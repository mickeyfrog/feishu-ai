/**
 * 浏览器自动化对话 Provider：services/chat-browser.js
 * -------------------------------------------------------------
 * 启用方式：AI_CHAT_PROVIDER=browser（默认 api，不设置时走 OpenAI-Compatible 接口）。
 *
 * 工作方式：通过 browser-core（playwright-core CDP）连接本机「已登录 chatgpt.com」的
 * 调试 Chrome：
 *   - 新会话：打开「AI_BROWSER_PROJECT_URL 项目页」（配置了的话，便于在 ChatGPT 里归档）
 *     或 chatgpt.com 首页，发送消息；结束后把最终的 /c/<id> 会话地址回写数据库，
 *     之后同一 feishu 会话的消息都回到同一个 ChatGPT 会话里继续（上下文连续）。
 *   - 续聊：直接打开数据库里存的 /c/<id> 地址再发送。
 *
 * 流式策略（伪流式）：轮询读取最后一条 assistant 消息的「纯文本」增长量做增量下发；
 * 结束时用「页面内 DOM -> Markdown 转换器」取最终排版，整段替换（路由层在 done 里带 fullText）。
 *
 * 红线与生图一致：不抓 cookie、不读凭证文件、不碰私有接口 token、不自动登录；
 * 日志只记消息前 50 字 + 长度；失败绝不重试、绝不回退到 API。
 */

import {
  BrowserNotConnectedError,
  BrowserLoginRequiredError,
  BrowserGenerationTimeoutError,
  BrowserDomChangedError,
  getTimeoutMs,
  getConcurrency,
  getActiveCount,
  getProjectUrl,
  CHAT_HOME_URL,
  POLL_INTERVAL_MS,
  sleep,
  throwIfAborted,
  safeUrl,
  getBrowser,
  acquirePage,
  releasePage,
  acquireSlot,
  releaseSlot,
  gotoPage,
  ensureLoggedInAndFindComposer,
  fillAndSend,
  _setConnectImplForTesting as coreSetConnect,
  _resetForTesting as coreReset
} from './browser-core.js';

// 测试钩子转发（与 image-browser 共享 core 状态；两个测试文件跑在不同进程，互不干扰）
export function _setConnectImplForTesting(fn) { coreSetConnect(fn); }
export function _resetForTesting() { coreReset(); }

/* ----------------------------- 配置 ----------------------------- */

/** 是否启用浏览器对话 */
export function isBrowserChatEnabled() {
  return String(process.env.AI_CHAT_PROVIDER || '').trim().toLowerCase() === 'browser';
}

/** 单次对话超时（默认 240s，思考型回复可能较慢） */
export function getChatBrowserTimeoutMs() {
  return getTimeoutMs('AI_CHAT_BROWSER_TIMEOUT_MS', 240000);
}

/** 从 ChatGPT 会话页 URL 提取会话地址：/c/<id> 或项目内 /g/<slug>/c/<id>（项目页本身等其它地址不算） */
export function extractChatUrl(url) {
  // 项目内会话的地址是 /g/<项目slug>/c/<id>，普通会话是 /c/<id>
  const m = /^(https:\/\/chatgpt\.com\/(?:g\/[0-9a-zA-Z-]+\/)?c\/[0-9a-zA-Z-]+)/.exec(String(url || ''));
  return m ? m[1] : '';
}

/* ----------------------------- 错误文案 ----------------------------- */

/** 对话错误 -> 可操作的中文提示（只按错误 name 识别） */
export function describeBrowserChatError(err) {
  const errName = String(err && err.name ? err.name : '');
  if (errName === 'BrowserNotConnectedError') {
    return '浏览器未连接：请先启动带 --remote-debugging-port=9222 的 Chrome 并登录 ChatGPT。';
  }
  if (errName === 'BrowserLoginRequiredError') {
    return '未检测到 ChatGPT 登录态：请在调试 Chrome 中登录 chatgpt.com 后重试。';
  }
  if (errName === 'BrowserGenerationTimeoutError') {
    return '回答超时：ChatGPT 网页可能正在排队或触达额度上限，请稍后重试。';
  }
  if (errName === 'BrowserDomChangedError') {
    return '页面结构已变化：自动化脚本需要更新，请联系管理员。';
  }
  if (errName === 'AbortError') {
    return '已取消。';
  }
  return 'AI 回复失败，请重试。';
}

/* ----------------------------- 页面内读取 ----------------------------- */

/** 读取 assistant 消息状态：条数 + 最后一条纯文本 + 是否仍在生成 */
async function readAssistantState(page) {
  const state = await page.evaluate(function (arg) {
    void arg;
    const turns = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    const last = turns[turns.length - 1] || null;
    // 生成中的特征：存在「停止」按钮（不同语言/版本都试）
    const stopBtn = document.querySelector(
      'button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]'
    );
    return {
      count: turns.length,
      lastText: last ? String(last.innerText || '') : '',
      generating: !!stopBtn
    };
  }, { action: 'assistantState' });
  return state && typeof state === 'object'
    ? { count: state.count || 0, lastText: String(state.lastText || ''), generating: !!state.generating }
    : { count: 0, lastText: '', generating: false };
}

/**
 * 把最后一条 assistant 消息的 HTML 转成 Markdown。
 * 转换器在页面内运行（CDP evaluate 不受页面 CSP 限制），只认常见元素。
 * 注：代码里的反引号用 BT（String.fromCharCode(96)）构造，避免与宿主字符串/模板冲突。
 */
async function extractLastAssistantMarkdown(page) {
  const md = await page.evaluate(function (arg) {
    void arg;
    const BT = String.fromCharCode(96); // 反引号
    const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
    const last = turns[turns.length - 1];
    if (!last) return '';
    const root = last.querySelector('.markdown') || last;

    function kids(node) {
      return Array.from(node.childNodes).map(toMd).join('');
    }

    function tableToMd(table) {
      const rows = Array.from(table.querySelectorAll('tr')).map(function (tr) {
        return Array.from(tr.children).map(function (cell) {
          return Array.from(cell.childNodes).map(toMd).join('').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
        });
      }).filter(function (r) { return r.length; });
      if (!rows.length) return '';
      const head = rows[0];
      const sep = head.map(function () { return '---'; });
      const body = rows.slice(1);
      const lines = ['| ' + head.join(' | ') + ' |', '| ' + sep.join(' | ') + ' |']
        .concat(body.map(function (r) { return '| ' + r.join(' | ') + ' |'; }));
      return '\n\n' + lines.join('\n') + '\n\n';
    }

    function toMd(node) {
      if (node.nodeType === 3) return node.nodeValue;
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toLowerCase();
      if (tag === 'p') { const t = kids(node).trim(); return t ? '\n\n' + t + '\n\n' : ''; }
      if (tag === 'br') return '\n';
      if (tag === 'strong' || tag === 'b') return '**' + kids(node) + '**';
      if (tag === 'em' || tag === 'i') return '*' + kids(node) + '*';
      if (tag === 'del' || tag === 's') return '~~' + kids(node) + '~~';
      if (tag === 'code') {
        if (node.parentElement && node.parentElement.tagName === 'PRE') return kids(node);
        const t = kids(node);
        return t.indexOf(BT) > -1 ? BT + BT + ' ' + t + ' ' + BT + BT : BT + t + BT;
      }
      if (tag === 'pre') {
        const codeEl = node.querySelector('code');
        const lang = codeEl && /language-(\w+)/.exec(codeEl.className || '');
        const text = String((codeEl || node).innerText || '').replace(/\n+$/, '');
        return '\n\n' + BT + BT + BT + (lang ? lang[1] : '') + '\n' + text + '\n' + BT + BT + BT + '\n\n';
      }
      if (tag === 'ul' || tag === 'ol') {
        let i = 0;
        const items = Array.from(node.children)
          .filter(function (c) { return c.tagName === 'LI'; })
          .map(function (li) {
            i++;
            const body = toMd(li).trim().replace(/\n+/g, '\n  ');
            return (tag === 'ul' ? '- ' : i + '. ') + body;
          });
        return items.length ? '\n' + items.join('\n') + '\n' : '';
      }
      if (tag === 'li') return kids(node);
      if (/^h[1-6]$/.test(tag)) {
        const t = kids(node).trim();
        return t ? '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + t + '\n\n' : '';
      }
      if (tag === 'blockquote') {
        const t = kids(node).trim();
        return t ? '\n\n' + t.split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n\n' : '';
      }
      if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        const label = kids(node).trim() || href;
        return /^https?:/i.test(href) ? '[' + label + '](' + href + ')' : label;
      }
      if (tag === 'hr') return '\n\n---\n\n';
      if (tag === 'table') return tableToMd(node);
      if (tag === 'img' || tag === 'svg' || tag === 'button') return '';
      return kids(node);
    }

    return toMd(root).replace(/\n{3,}/g, '\n\n').trim();
  }, { action: 'extractMarkdown' });
  return String(md || '');
}

/* ----------------------------- 轮询生成 ----------------------------- */

/**
 * 轮询等待「新 assistant 回合」出现并生成完毕：
 *   - 期间按纯文本增长量调用 onDelta（伪流式）
 *   - 完成条件：没有「停止」按钮 且 文本连续两轮不再变化 且 确实有内容
 */
async function pollAssistantAnswer(page, baselineCount, deadline, signal, timeoutMs, onDelta) {
  let emitted = '';
  let stableRounds = 0;
  let lastSeen = '';

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    let state;
    try {
      state = await readAssistantState(page);
    } catch (err) {
      throw new BrowserDomChangedError('读取回答失败：' + (err && err.message ? err.message : err));
    }

    const hasNewTurn = state.count > baselineCount;
    const text = hasNewTurn ? state.lastText : '';

    if (text && text !== lastSeen) {
      // 只在「前缀扩展」时下发增量；结构重排（如代码块闭合）时等 done 用 fullText 修正
      if (text.indexOf(emitted) === 0) {
        const delta = text.slice(emitted.length);
        if (delta) {
          emitted = text;
          if (onDelta) onDelta(delta);
        }
      }
      lastSeen = text;
      stableRounds = 0;
    } else if (text && !state.generating) {
      stableRounds++;
      if (stableRounds >= 2) return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new BrowserGenerationTimeoutError('超过 ' + Math.round(timeoutMs / 1000) + 's 未等到回答完成');
}

/* ----------------------------- 对外入口 ----------------------------- */

/**
 * 通过本机调试 Chrome（已登录 ChatGPT）完成一轮对话。
 * options: { conversationUrl, text, signal, onDelta }
 * 返回 { text, url }：text = Markdown 全文；url = 最终的 ChatGPT /c/<id> 会话地址（供续聊，可能为空）
 */
export async function streamChatViaBrowser(options) {
  const text = String(options && options.text || '');
  const signal = options && options.signal;
  const onDelta = options && options.onDelta;
  const existingUrl = extractChatUrl(options && options.conversationUrl);
  const timeoutMs = getChatBrowserTimeoutMs();
  const limit = getConcurrency();

  await acquireSlot(signal);
  try {
    // 超时从「拿到执行位」起算
    const deadline = Date.now() + timeoutMs;
    console.log('[对话·browser] 开始：消息前 50 字="' + text.slice(0, 50) + '"，长度=' + text.length +
      '，续聊=' + (existingUrl ? '是' : '否') + '，并发=' + getActiveCount() + '/' + limit);

    const browser = await getBrowser();
    const handle = await acquirePage(browser, limit > 1);
    try {
      const page = handle.page;
      // 续聊回旧会话；新会话落在项目页（若配置）或首页
      const targetUrl = existingUrl || getProjectUrl() || CHAT_HOME_URL;
      await gotoPage(page, targetUrl);
      const composerSel = await ensureLoggedInAndFindComposer(page, deadline, signal);

      const baseline = await readAssistantState(page);
      await fillAndSend(page, composerSel, text);
      await pollAssistantAnswer(page, baseline.count, deadline, signal, timeoutMs, onDelta);

      const markdown = await extractLastAssistantMarkdown(page);
      const finalUrl = extractChatUrl(safeUrl(page));
      return { text: markdown, url: finalUrl || existingUrl || '' };
    } finally {
      await releasePage(handle);
    }
  } finally {
    releaseSlot();
  }
}
