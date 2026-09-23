/**
 * 浏览器自动化生图：services/image-browser.js
 * -------------------------------------------------------------
 * 唯一的生图实现（API 生图模式已于 2026-09-20 移除）。
 * 停用方式：.env 设 AI_IMAGE_MODEL=off。
 *
 * 工作方式：通过 browser-core（playwright-core CDP）连接本机「已登录 chatgpt.com」的
 * 调试 Chrome，把提示词当作一次网页对话发送，等待生成图片出现后提取。
 * 若配置了 AI_BROWSER_PROJECT_URL（ChatGPT「项目」页地址），生图会话会落在该项目里，
 * 便于在 ChatGPT 网页版里集中归档查看。
 *
 * 红线：不抓 cookie、不读浏览器凭证文件、不碰任何私有接口 token、不自动登录；
 * 日志只记 prompt 前 50 字 + 长度；失败绝不重试、绝不静默回退。
 *
 * 合规风险：自动化使用 ChatGPT 网页版违反 OpenAI 服务条款，可能封号，仅建议小号。
 *
 * 页面结构相关逻辑（选择器 / 连接 / 队列）集中在 browser-core.js，改版时优先改那里。
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

// 让既有调用方/测试继续从本模块拿到错误类与测试钩子（转发到 core，状态共享）
export {
  BrowserNotConnectedError,
  BrowserLoginRequiredError,
  BrowserGenerationTimeoutError,
  BrowserDomChangedError
};
export function _setConnectImplForTesting(fn) { coreSetConnect(fn); }
export function _resetForTesting() { coreReset(); }

/* ----------------------------- 生图开关与标签 ----------------------------- */

/** AI_IMAGE_MODEL 的这些取值表示「彻底关闭生图功能」 */
const IMAGE_DISABLED_VALUES = new Set(['off', 'none', 'false', 'disabled', '0']);

/** browser 模式的「模型名」只是 DB / 前端展示用的标签，网页版没有模型参数 */
export const BROWSER_MODEL_LABEL = 'chatgpt-web';

/**
 * 生图是否可用。browser 是唯一模式：不依赖任何 API Key，
 * 只要求没被显式关闭（AI_IMAGE_MODEL ≠ off，留空即开启）。
 */
export function isImageGenerationEnabled() {
  const explicit = String(process.env.AI_IMAGE_MODEL || '').trim();
  return !IMAGE_DISABLED_VALUES.has(explicit.toLowerCase());
}

/** 生图记录用的模型标签 */
export function getImageModelLabel() {
  return BROWSER_MODEL_LABEL;
}

/**
 * 生图错误 -> 可操作的中文提示（只按错误 name 识别，绝不回传敏感信息）。
 */
export function describeBrowserImageError(err) {
  const errName = String(err && err.name ? err.name : '');
  if (errName === 'BrowserNotConnectedError') {
    return '浏览器未连接：请先启动带 --remote-debugging-port=9222 的 Chrome 并登录 ChatGPT。';
  }
  if (errName === 'BrowserLoginRequiredError') {
    return '未检测到 ChatGPT 登录态：请在调试 Chrome 中登录 chatgpt.com 后重试。';
  }
  if (errName === 'BrowserGenerationTimeoutError') {
    return '生图超时：ChatGPT 网页可能正在排队，请稍后重试。';
  }
  if (errName === 'BrowserDomChangedError') {
    return '页面结构已变化：自动化脚本需要更新，请联系管理员。';
  }
  return '图片生成失败，请重试。';
}

/* ----------------------------- 页面内操作 ----------------------------- */

/** 扫描 main 区域内的候选生成图片（过滤头像等小图） */
async function scanImages(page) {
  const list = await page.evaluate(function (arg) {
    void arg;
    const main = document.querySelector('main') || document.body;
    const imgs = Array.from(main.querySelectorAll('img'));
    return imgs.map(function (img, i) {
      return {
        index: i,
        src: String(img.currentSrc || img.src || ''),
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0,
        complete: img.complete === true,
        alt: String(img.alt || '')
      };
    }).filter(function (x) {
      if (!x.src) return false;
      if (x.src.indexOf('blob:') !== 0 && !/^https:/i.test(x.src)) return false;
      return x.width >= 256 || /generat|dall|image/i.test(x.alt);
    });
  }, { action: 'scanImages' });
  return Array.isArray(list) ? list : [];
}

/** blob:/https: 图片 → data URL（FileReader 在页面里执行，天然携带登录态） */
async function blobSrcToDataUrl(page, src) {
  const dataUrl = await page.evaluate(async function (arg) {
    const res = await fetch(arg.src);
    const blob = await res.blob();
    return await new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(new Error('FileReader failed')); };
      reader.readAsDataURL(blob);
    });
  }, { action: 'blobToDataUrl', src: src });
  return String(dataUrl || '');
}

/* ----------------------------- 流程 ----------------------------- */

function keyOf(img) { return img.src; }

/** 轮询等待「基线之外的新图片」出现，且连续两次扫描处于完成态（稳定） */
async function waitForNewImage(page, baselineKeys, deadline, signal, timeoutMs) {
  let stableRounds = 0;
  let lastKey = '';
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    let images;
    try {
      images = await scanImages(page);
    } catch (err) {
      throw new BrowserDomChangedError('扫描图片失败：' + (err && err.message ? err.message : err));
    }
    const fresh = images.filter(function (img) { return !baselineKeys.has(keyOf(img)); });
    const ready = fresh.filter(function (img) { return img.complete && img.width >= 256; });
    if (ready.length) {
      const candidate = ready[ready.length - 1];
      if (keyOf(candidate) === lastKey) {
        stableRounds++;
        if (stableRounds >= 2) return candidate;
      } else {
        lastKey = keyOf(candidate);
        stableRounds = 1;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new BrowserGenerationTimeoutError(
    '超过 ' + Math.round(timeoutMs / 1000) + 's 未等到生成图片'
  );
}

/* ----------------------------- 对外入口 ----------------------------- */

/**
 * 通过本机调试 Chrome（已登录 ChatGPT）生成一张图片。
 * @param {{prompt:string, size?:string, signal?:AbortSignal}} options
 *   size 目前仅透传保留：网页版没有尺寸参数入口，本实现不改动用户提示词。
 * @returns {Promise<{buffer:Buffer, mimeType:string}>} 只返回内存数据，落盘由路由层负责
 * 失败语义：绝不重试；错误类型为四个 Browser*Error 之一或 AbortError。
 */
export async function generateImageViaBrowser(options) {
  const prompt = String(options && options.prompt || '');
  const signal = options && options.signal;
  const timeoutMs = getTimeoutMs('AI_IMAGE_BROWSER_TIMEOUT_MS', 180000);
  const limit = getConcurrency();

  await acquireSlot(signal);
  try {
    // 超时从「拿到执行位」才开始计时：排队等待不计入生成预算
    const deadline = Date.now() + timeoutMs;
    // 日志只记录 prompt 前 50 字 + 长度，绝不打印全文
    console.log('[生图·browser] 开始：prompt 前 50 字="' + prompt.slice(0, 50) + '"，长度=' + prompt.length +
      '，超时=' + Math.round(timeoutMs / 1000) + 's，并发=' + getActiveCount() + '/' + limit);

    const browser = await getBrowser();
    const dedicated = limit > 1;
    const handle = await acquirePage(browser, dedicated);
    try {
      const page = handle.page;
      // 配置了项目地址就落在「项目」里，实现自动归档；否则普通新会话
      await gotoPage(page, getProjectUrl() || CHAT_HOME_URL);
      const composerSel = await ensureLoggedInAndFindComposer(page, deadline, signal);

      let baseline = [];
      try { baseline = await scanImages(page); } catch (e) { baseline = []; }
      const baselineKeys = new Set(baseline.map(keyOf));

      await fillAndSend(page, composerSel, prompt);

      const img = await waitForNewImage(page, baselineKeys, deadline, signal, timeoutMs);

      // 统一在页面内取图：生成图的 src 是 chatgpt.com 同源后台接口
      // （/backend-api/estuary/content?id=...&sig=...），Node 直接下载会被 403（要登录态 Cookie）。
      let dataUrl = '';
      try {
        dataUrl = await blobSrcToDataUrl(page, img.src);
      } catch (firstErr) {
        // 保底：元素截图（完全不依赖网络/CORS；输出为 PNG 位图）
        console.warn('[生图·browser] 页面内取图失败，退化为元素截图：' + (firstErr && firstErr.message ? firstErr.message : firstErr));
        try {
          const shot = await page.locator('main img').nth(img.index).screenshot({ timeout: 15000 });
          if (shot && shot.length) return { buffer: shot, mimeType: 'image/png' };
        } catch (shotErr) {
          throw new BrowserDomChangedError('提取图片失败（页面内下载与截图都失败）：' + (shotErr && shotErr.message ? shotErr.message : shotErr));
        }
        throw new BrowserDomChangedError('提取图片失败：' + (firstErr && firstErr.message ? firstErr.message : firstErr));
      }
      const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(String(dataUrl));
      if (!m || !m[2]) throw new BrowserDomChangedError('图片转码结果不是 base64 data URL');
      return { buffer: Buffer.from(m[3], 'base64'), mimeType: m[1] || '' };
    } finally {
      await releasePage(handle);
    }
  } finally {
    releaseSlot();
  }
}
