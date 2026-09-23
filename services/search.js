/**
 * 联网搜索服务层：为模型提供「网页检索」上下文
 * -------------------------------------------------------------
 * 提供商（WEB_SEARCH_PROVIDER，默认 duckduckgo 免 Key）：
 *   duckduckgo  抓取 html.duckduckgo.com 解析结果（无需 Key）
 *   searxng     SearXNG 元搜索 JSON API（无需 Key；SEARXNG_BASE_URL 可配自建/公共实例，逗号分隔多个）
 *   tavily      POST api.tavily.com/search（需 TAVILY_API_KEY，免费档 1000 次/月）
 *   brave       GET api.search.brave.com/res/v1/web/search（需 BRAVE_SEARCH_KEY，免费档 2000 次/月）
 *   bing        GET api.bing.microsoft.com/v7.0/search（需 BING_SEARCH_KEY）
 *
 * 失败转移链：主提供商「真实请求失败（网络/HTTP/解析/空结果）」时，依次尝试其余已配置的提供商，
 *   duckduckgo 永远垫底；但「缺 Key 等配置错误」不触发转移（避免误配时悄悄走免 Key 通道）
 *
 * 约定：
 *   - WEB_SEARCH_ENABLED=false 可整体关闭（默认开启）
 *   - 搜索失败 / 超时（8s）只记日志，聊天继续「无搜索」回答，绝不让搜索拖垮对话
 *   - 结果以编号块注入上下文，提示模型用 [编号] 标注来源
 *   - 只把「用户问题 + 检索摘要」发给模型，不发送任何密钥 / 会话隐私
 */

/** 默认返回条数 */
export const DEFAULT_SEARCH_LIMIT = 5;

/** 搜索请求超时（毫秒） */
export const SEARCH_TIMEOUT_MS = 8000;

export function isWebSearchEnabled() {
  return String(process.env.WEB_SEARCH_ENABLED || 'true').trim() !== 'false';
}

export function getSearchProvider() {
  const provider = String(process.env.WEB_SEARCH_PROVIDER || '').trim().toLowerCase();
  if (provider === 'tavily' || provider === 'bing' || provider === 'brave' || provider === 'searxng') return provider;
  return 'duckduckgo';
}

/* ----------------------------- 小工具 ----------------------------- */

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** DuckDuckGo 的跳转链接还原为真实 URL（uddg 参数） */
function decodeDdgHref(href) {
  const matched = String(href).match(/[?&]uddg=([^&]+)/);
  if (matched) {
    try { return decodeURIComponent(matched[1]); } catch (e) { /* fallthrough */ }
  }
  let out = String(href);
  if (out.indexOf('//') === 0) out = 'https:' + out;
  return out;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, SEARCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------- 提供商实现 ----------------------------- */

async function searchDuckDuckGo(query, limit) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) feishu-ai/1.0',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }
  });
  if (!res.ok) throw new Error('DuckDuckGo HTTP ' + res.status);
  const html = await res.text();

  const titles = [];
  const reTitle = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = reTitle.exec(html)) !== null) {
    titles.push({ url: decodeDdgHref(m[1]), title: stripTags(m[2]) });
  }
  const snippets = [];
  const reSnippet = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = reSnippet.exec(html)) !== null) snippets.push(stripTags(m[1]));

  return titles.slice(0, limit).map(function (item, i) {
    return { title: item.title, url: item.url, snippet: snippets[i] || '' };
  });
}

/** 配置错误（缺 Key 等）：不触发失败转移，直接抛给调用方降级 */
function configError(msg) {
  const err = new Error(msg);
  err.configError = true;
  return err;
}

async function searchTavily(query, limit) {
  const key = String(process.env.TAVILY_API_KEY || '').trim();
  if (!key) throw configError('未配置 TAVILY_API_KEY');
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query: query, max_results: limit })
  });
  if (!res.ok) throw new Error('Tavily HTTP ' + res.status);
  const json = await res.json();
  return (json.results || []).slice(0, limit).map(function (item) {
    return { title: item.title || '', url: item.url || '', snippet: item.content || '' };
  });
}

async function searchBing(query, limit) {
  const key = String(process.env.BING_SEARCH_KEY || '').trim();
  if (!key) throw configError('未配置 BING_SEARCH_KEY');
  const url = 'https://api.bing.microsoft.com/v7.0/search?q=' + encodeURIComponent(query) +
    '&mkt=zh-CN&count=' + limit;
  const res = await fetchWithTimeout(url, {
    headers: { 'Ocp-Apim-Subscription-Key': key }
  });
  if (!res.ok) throw new Error('Bing HTTP ' + res.status);
  const json = await res.json();
  const pages = (json.webPages && json.webPages.value) || [];
  return pages.slice(0, limit).map(function (item) {
    return { title: item.name || '', url: item.url || '', snippet: item.snippet || '' };
  });
}

/**
 * Brave Search API：免费档 2000 次/月（需注册 https://brave.com/search/api 拿 Key）
 * 文档：https://brave.com/search/api/ （web/search 端点，X-Subscription-Token 头）
 */
async function searchBrave(query, limit) {
  const key = String(process.env.BRAVE_SEARCH_KEY || '').trim();
  if (!key) throw configError('未配置 BRAVE_SEARCH_KEY');
  const url = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) +
    '&count=' + limit;
  const res = await fetchWithTimeout(url, {
    headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error('Brave HTTP ' + res.status);
  const json = await res.json();
  const list = (json.web && json.web.results) || [];
  return list.slice(0, limit).map(function (item) {
    return { title: item.title || '', url: item.url || '', snippet: item.description || '' };
  });
}

/**
 * SearXNG 元搜索（自托管/公共实例，JSON API）。
 * SEARXNG_BASE_URL：逗号分隔多个实例做实例级失败转移；
 * 未配置时用公共默认实例（自建实例见 README §14.6，searxng/searxng-docker）。
 */
const SEARXNG_DEFAULT_INSTANCES = ['https://etsi.me'];

function getSearxngInstances() {
  const raw = String(process.env.SEARXNG_BASE_URL || '').trim();
  if (!raw) return SEARXNG_DEFAULT_INSTANCES.slice();
  return raw.split(',').map(function (x) { return x.trim().replace(/\/+$/, ''); }).filter(Boolean);
}

async function searchSearxng(query, limit) {
  const instances = getSearxngInstances();
  if (!instances.length) throw configError('SEARXNG_BASE_URL 为空且没有默认实例');
  let lastErr = null;
  for (const base of instances) {
    try {
      const res = await fetchWithTimeout(base + '/search?q=' + encodeURIComponent(query) + '&format=json', {
        headers: { 'User-Agent': 'feishu-ai/1.0', 'Accept': 'application/json' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const list = Array.isArray(json.results) ? json.results : [];
      if (!list.length) throw new Error('空结果');
      return list.slice(0, limit).map(function (item) {
        return { title: item.title || '', url: item.url || '', snippet: item.content || '' };
      });
    } catch (err) {
      lastErr = err;
      console.error('[联网搜索] searxng 实例 ' + base + ' 失败（试下一个）：', err && err.message ? err.message : err);
    }
  }
  throw new Error('SearXNG 全部实例不可用：' + (lastErr && lastErr.message ? lastErr.message : '未知错误'));
}

/* ----------------------------- 对外入口 ----------------------------- */

const PROVIDERS = {
  duckduckgo: searchDuckDuckGo,
  searxng: searchSearxng,
  tavily: searchTavily,
  brave: searchBrave,
  bing: searchBing
};

/** 该提供商是否「已配置到可以发起真实请求」（免 Key 的 searxng 需显式配置实例才进转移链） */
function providerAvailable(name) {
  if (name === 'tavily') return Boolean(String(process.env.TAVILY_API_KEY || '').trim());
  if (name === 'brave') return Boolean(String(process.env.BRAVE_SEARCH_KEY || '').trim());
  if (name === 'bing') return Boolean(String(process.env.BING_SEARCH_KEY || '').trim());
  if (name === 'searxng') return Boolean(String(process.env.SEARXNG_BASE_URL || '').trim());
  return true; // duckduckgo 免 Key 永远可用
}

/**
 * 执行一次联网搜索：按「失败转移链」依次尝试提供商。
 * 链 = 主提供商 -> 其余已配置的提供商（tavily/brave/searxng/bing）-> duckduckgo 垫底。
 * 配置错误（缺 Key）不触发转移；真实请求失败或空结果才转移。
 * 全部失败时抛错，由调用方决定降级策略。
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<Array<{title:string,url:string,snippet:string}>>}
 */
export async function searchWeb(query, limit) {
  const size = Number(limit) > 0 ? Number(limit) : DEFAULT_SEARCH_LIMIT;
  const primary = getSearchProvider();
  const chain = [primary];
  ['tavily', 'brave', 'searxng', 'bing'].forEach(function (name) {
    if (name !== primary && providerAvailable(name) && chain.indexOf(name) === -1) chain.push(name);
  });
  if (chain.indexOf('duckduckgo') === -1) chain.push('duckduckgo');

  let lastErr = null;
  for (const name of chain) {
    try {
      const results = await PROVIDERS[name](query, size);
      if (results && results.length) {
        if (name !== primary) console.log('[联网搜索] 已由 ' + name + ' 兜底返回 ' + results.length + ' 条');
        return results;
      }
      lastErr = new Error(name + ' 返回空结果');
    } catch (err) {
      if (err && err.configError) throw err; // 配置错误：不转移，直接抛
      lastErr = err;
      console.error('[联网搜索] ' + name + ' 失败（尝试下一个）：', err && err.message ? err.message : err);
    }
  }
  throw lastErr || new Error('所有搜索提供商均不可用');
}

/** 把搜索结果拼成带编号的上下文块 */
export function buildSearchBlock(results) {
  if (!results || !results.length) return '';
  return '以下是联网搜索到的网页摘要（编号即引用标记），回答时请结合它们并用 [编号] 标注来源：\n' +
    results.map(function (item, i) {
      return '[' + (i + 1) + '] ' + item.title +
        '\n    链接：' + item.url +
        (item.snippet ? '\n    摘要：' + item.snippet : '');
    }).join('\n');
}