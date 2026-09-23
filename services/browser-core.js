/**
 * 浏览器自动化公共层：services/browser-core.js
 * -------------------------------------------------------------
 * 被 services/image-browser.js（生图）与 services/chat-browser.js（对话）共用。
 * 所有浏览器任务共享同一条「串行队列 + 同一个 CDP 连接」，避免同一账号并发操作网页。
 *
 * 红线（与生图一致）：不抓 cookie、不读浏览器凭证文件、不碰任何私有接口 token、
 * 不自动拉起 Chrome、不自动登录；日志只记文本前 50 字 + 长度。
 *
 * 合规风险：自动化使用 ChatGPT 网页版违反 OpenAI 服务条款，可能封号，仅建议小号。
 */

/* ----------------------------- 错误类型 ----------------------------- */

/** CDP 连不上（Chrome 没启动 / 端口不对） */
export class BrowserNotConnectedError extends Error {
  constructor(message) { super(message || '无法连接调试 Chrome'); this.name = 'BrowserNotConnectedError'; }
}

/** 未检测到 chatgpt.com 登录态 */
export class BrowserLoginRequiredError extends Error {
  constructor(message) { super(message || '未检测到 ChatGPT 登录态'); this.name = 'BrowserLoginRequiredError'; }
}

/** 等待超时（生图 / 对话生成） */
export class BrowserGenerationTimeoutError extends Error {
  constructor(message) { super(message || '等待生成超时'); this.name = 'BrowserGenerationTimeoutError'; }
}

/** 页面结构与预期不符（前端改版，选择器失效） */
export class BrowserDomChangedError extends Error {
  constructor(message) { super(message || '页面结构已变化'); this.name = 'BrowserDomChangedError'; }
}

/* ----------------------------- 配置 ----------------------------- */

/** CDP 地址（本机调试 Chrome） */
export function getCdpUrl() {
  return String(process.env.AI_IMAGE_BROWSER_CDP || 'http://127.0.0.1:9222').trim();
}

/** 任务超时：envName 指定环境变量，defMs 为默认值 */
export function getTimeoutMs(envName, defMs) {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defMs;
}

/** 全局浏览器任务并发上限：默认 1（串行），最大 3（网页版风控，严禁调高） */
export function getConcurrency() {
  const n = Number(process.env.AI_BROWSER_CONCURRENCY || process.env.AI_IMAGE_BROWSER_CONCURRENCY);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(3, Math.floor(n));
}

/** 归档目标：ChatGPT「项目」页 URL（留空 = 普通新会话）。对话与生图共用。 */
export function getProjectUrl() {
  const url = String(process.env.AI_BROWSER_PROJECT_URL || '').trim();
  return /^https:\/\/chatgpt\.com\/g\//i.test(url) ? url : '';
}

export const CHAT_HOME_URL = 'https://chatgpt.com/';
export const POLL_INTERVAL_MS = 750;
export const NAV_TIMEOUT_MS = 60000;
export const COMPOSER_WAIT_CAP_MS = 10000;

/** ChatGPT 前端选择器（改版时改这里） */
export const SELECTORS = {
  // 输入框：新版是 contenteditable 的 ProseMirror；旧版是 textarea
  composer: [
    '#prompt-textarea',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'div[contenteditable="true"]',
    'form textarea'
  ]
};

/* ----------------------------- 小工具 ----------------------------- */

export function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

export function makeAbortError() {
  const err = new Error('请求已取消');
  err.name = 'AbortError';
  return err;
}

export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw makeAbortError();
}

export function safeUrl(page) {
  try { return page.url(); } catch (e) { return ''; }
}

/* --------------------- CDP 连接（可注入 mock 供测试） --------------------- */

let connectImpl = null;      // 测试注入点：_setConnectImplForTesting(fn)
let cachedBrowser = null;
let cachedSharedPage = null; // 并发=1 时复用的标签页

async function defaultConnect() {
  // playwright-core 只含驱动，不下载浏览器；浏览器由用户手动启动
  const { chromium } = await import('playwright-core');
  return chromium.connectOverCDP(getCdpUrl());
}

export async function getBrowser() {
  if (cachedBrowser) {
    let alive = true;
    try {
      if (typeof cachedBrowser.isConnected === 'function' && !cachedBrowser.isConnected()) alive = false;
    } catch (e) { alive = false; }
    if (!alive) { cachedBrowser = null; cachedSharedPage = null; }
  }
  if (cachedBrowser) return cachedBrowser;

  let browser;
  try {
    browser = connectImpl ? await connectImpl(getCdpUrl()) : await defaultConnect();
  } catch (err) {
    throw new BrowserNotConnectedError(
      '连接 ' + getCdpUrl() + ' 失败：' + (err && err.message ? err.message : err)
    );
  }
  if (browser && typeof browser.on === 'function') {
    browser.on('disconnected', function () {
      if (cachedBrowser === browser) { cachedBrowser = null; cachedSharedPage = null; }
    });
  }
  cachedBrowser = browser;
  return browser;
}

/** 取标签页：并发=1 时复用一个 chatgpt.com 标签；并发>1 时每次新开，用完即关 */
export async function acquirePage(browser, dedicated) {
  if (!dedicated && cachedSharedPage) {
    let closed = false;
    try {
      if (typeof cachedSharedPage.isClosed === 'function' && cachedSharedPage.isClosed()) closed = true;
    } catch (e) { closed = true; }
    if (!closed) return { page: cachedSharedPage, closeAfter: false };
    cachedSharedPage = null;
  }

  let contexts;
  try { contexts = browser.contexts(); } catch (e) { contexts = null; }
  if (!contexts || !contexts.length) throw new BrowserDomChangedError('CDP 连接里没有可用的浏览器上下文');
  const ctx = contexts[0];

  if (!dedicated) {
    let pages = [];
    try { pages = ctx.pages() || []; } catch (e) { pages = []; }
    const existing = pages.find(function (p) { return /chatgpt\.com/i.test(safeUrl(p)); });
    if (existing) {
      cachedSharedPage = existing;
      return { page: existing, closeAfter: false };
    }
  }

  let page;
  try {
    page = await ctx.newPage();
  } catch (err) {
    throw new BrowserDomChangedError('无法新建标签页：' + (err && err.message ? err.message : err));
  }
  if (!dedicated) cachedSharedPage = page;
  return { page: page, closeAfter: dedicated };
}

/** 用完归还：独立标签页关闭，共享标签页保留 */
export async function releasePage(handle) {
  if (handle && handle.closeAfter && handle.page && typeof handle.page.close === 'function') {
    try { await handle.page.close(); } catch (e) { /* 忽略关闭异常 */ }
  }
}

/* ----------------------------- 全局串行队列 ----------------------------- */

let activeCount = 0;
const waitQueue = [];

export async function acquireSlot(signal) {
  throwIfAborted(signal);
  while (activeCount >= getConcurrency()) {
    await new Promise(function (resolve, reject) {
      const entry = {};
      const onAbort = function () {
        const i = waitQueue.indexOf(entry);
        if (i > -1) waitQueue.splice(i, 1);
        reject(makeAbortError());
      };
      entry.resolve = function () {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      };
      waitQueue.push(entry);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
    throwIfAborted(signal);
  }
  activeCount++;
}

export function releaseSlot() {
  activeCount--;
  const next = waitQueue.shift();
  if (next) next.resolve();
}

/** 当前占用数（日志用） */
export function getActiveCount() { return activeCount; }

/* ----------------------------- 页面流程 ----------------------------- */

/** 打开指定 URL（项目页 / 会话页 / 首页） */
export async function gotoPage(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    throw new BrowserDomChangedError('打开页面失败（' + url + '）：' + (err && err.message ? err.message : err));
  }
}

/** 检测页面是否出现登录/注册按钮（用于区分「未登录」与「DOM 改版」） */
export async function pageHasLoginButton(page) {
  try {
    return await page.evaluate(function (arg) {
      void arg;
      const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      return els.some(function (el) {
        return /log in|sign up|登录|注册/i.test(String(el.textContent || '').trim());
      });
    }, { action: 'detectLoginButton' });
  } catch (e) { return false; }
}

/** 确认已登录并找到「可见的」输入框选择器；超时内反复探测 */
export async function ensureLoggedInAndFindComposer(page, deadline, signal) {
  const url = safeUrl(page);
  if (/auth\.openai\.com|chatgpt\.com\/(auth|login)/i.test(url || '')) {
    throw new BrowserLoginRequiredError('当前页面是登录页：' + url);
  }
  const composerDeadline = Math.min(deadline, Date.now() + COMPOSER_WAIT_CAP_MS);
  while (Date.now() < composerDeadline) {
    throwIfAborted(signal);
    for (const sel of SELECTORS.composer) {
      let handle = null;
      try { handle = await page.$(sel); } catch (e) { handle = null; }
      if (!handle) continue;
      // 必须可见：ChatGPT 首屏自带一个 display:none 的兜底 <textarea name="prompt-textarea">，
      // 真正的输入框是稍后挂载的 contenteditable div#prompt-textarea；不查可见性会命中隐藏节点
      let visible = false;
      try { visible = await handle.isVisible(); } catch (e) { visible = false; }
      if (visible) return sel;
    }
    // 页面明显是「未登录」态时立刻报错，不做无谓轮询
    if (await pageHasLoginButton(page)) throw new BrowserLoginRequiredError();
    await sleep(500);
  }
  const urlAfter = safeUrl(page);
  if (/auth\.openai\.com|chatgpt\.com\/(auth|login)/i.test(urlAfter || '')) {
    throw new BrowserLoginRequiredError();
  }
  throw new BrowserDomChangedError('找不到对话输入框（选择器可能失效）');
}

/** 填入提示词并回车发送 */
export async function fillAndSend(page, composerSel, text) {
  try {
    await page.fill(composerSel, text);
    await page.keyboard.press('Enter');
  } catch (err) {
    throw new BrowserDomChangedError('输入或提交失败：' + (err && err.message ? err.message : err));
  }
}

/* ----------------------------- 测试钩子（生产请勿调用） ----------------------------- */

/** 注入 mock 的 connectOverCDP；传 null 恢复真实 playwright-core */
export function _setConnectImplForTesting(fn) {
  connectImpl = fn || null;
  cachedBrowser = null;
  cachedSharedPage = null;
}

/** 清空连接缓存与队列状态（每个测试用例之间调用） */
export function _resetForTesting() {
  connectImpl = null;
  cachedBrowser = null;
  cachedSharedPage = null;
  activeCount = 0;
  waitQueue.length = 0;
}
