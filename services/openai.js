/**
 * AI Provider 服务层（官方 openai SDK，支持任意 OpenAI-Compatible 中转站）
 * -------------------------------------------------------------
 * 配置（新变量优先，旧变量仅作兼容回退）：
 *   AI_API_KEY   > OPENAI_API_KEY
 *   AI_MODEL     > OPENAI_MODEL
 *   AI_BASE_URL  （留空默认 https://api.openai.com/v1；由 .env 完整提供，代码不再拼 /v1）
 *   AI_API_MODE  responses | chat_completions（默认 responses）
 *
 * 生图已改为「浏览器自动化」独立模块（services/image-browser.js），本文件不再涉及。
 *
 * 两种模式：
 *   responses        -> client.responses.create() / responses.stream()
 *   chat_completions -> client.chat.completions.create({ stream:true|false })
 * 模式只由 AI_API_MODE 决定：失败时「绝不」自动切换模式再发一次收费请求。
 *
 * 通用保障（两种模式一致）：
 *   - 多轮上下文由数据库 messages 重建：条数上限 MAX_CONTEXT_MESSAGES，字符预算 MAX_CONTEXT_CHARS
 *   - 流式逐段回调 onDelta；内存累积，写库由路由层在流结束后一次性完成
 *   - 流截断检测：responses 看终止事件，chat_completions 看 finish_reason；缺失即失败
 *   - 空闲看门狗 OPENAI_IDLE_TIMEOUT_MS：无事件超时即 abort 上游
 *   - 可传 { signal }：客户端断开时立刻中断上游请求
 *   - describeOpenAIError()：把中转站常见 401/403/404/429/5xx/网络错误映射成友好中文提示；
 *     绝不把 API Key / Authorization / 请求头 / .env 内容返回浏览器
 */

import OpenAI from 'openai';

/** 发送给模型的最大历史消息条数（数据库仍保存全部历史） */
export const MAX_CONTEXT_MESSAGES = 30;

/** 发送给模型的上下文总字符预算（超预算时从最旧的消息开始丢弃） */
export const MAX_CONTEXT_CHARS = 16000;

/** 空闲超时默认值（毫秒）：这么久没有任何事件就主动 abort */
export const DEFAULT_IDLE_TIMEOUT_MS = 60000;

/** 未配置 AI_BASE_URL 时的默认地址（OpenAI 官方） */
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

const SYSTEM_INSTRUCTIONS = [
  '你是「组内 AI」，一个嵌入飞书的团队内部助手。',
  '请使用与用户相同的语言回答（默认中文），简洁、准确、结构化。',
  '涉及代码时给出可直接运行的示例，并使用 Markdown 代码块。'
].join('\n');

/** 未配置 Key / 模型时抛出的错误类型（路由层据此返回友好提示） */
export class OpenAIConfigError extends Error {
  constructor() {
    super('服务器尚未配置 AI API');
    this.name = 'OpenAIConfigError';
  }
}

/** 流被截断 / 上游返回失败事件时抛出，调用方据此「不保存」半截回复 */
export class OpenAIStreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpenAIStreamError';
  }
}

/** 空闲超时：上游长时间无任何事件，已主动 abort */
export class OpenAITimeoutError extends Error {
  constructor() {
    super('AI 响应超时');
    this.name = 'OpenAITimeoutError';
  }
}

/**
 * 统一读取 AI Provider 配置。
 * 新变量优先；AI_BASE_URL 留空时回落到 OpenAI 官方地址。
 * 注意：baseURL 原样交给 SDK，代码不做任何 /v1 拼接或裁剪。
 */
export function getAIConfig() {
  const apiKey = String(process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const model = String(process.env.AI_MODEL || process.env.OPENAI_MODEL || '').trim();
  const baseURL = String(process.env.AI_BASE_URL || '').trim() || DEFAULT_BASE_URL;
  const modeRaw = String(process.env.AI_API_MODE || '').trim().toLowerCase();
  const mode = modeRaw === 'chat_completions' ? 'chat_completions' : 'responses';
  return { apiKey, model, baseURL, mode };
}

export function isOpenAIConfigured() {
  const cfg = getAIConfig();
  return Boolean(cfg.apiKey && cfg.model);
}

function getIdleTimeoutMs() {
  const raw = Number(process.env.OPENAI_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_TIMEOUT_MS;
}

let client = null;
let clientKey = '';
let clientBase = '';

function getClient() {
  const { apiKey, baseURL } = getAIConfig();
  if (!apiKey) throw new OpenAIConfigError();
  if (!client || clientKey !== apiKey || clientBase !== baseURL) {
    client = new OpenAI({ apiKey, baseURL });
    clientKey = apiKey;
    clientBase = baseURL;
  }
  return client;
}

function getModel() {
  const { model } = getAIConfig();
  if (!model) throw new OpenAIConfigError();
  return model;
}

/** 供其它服务层（如生图）复用同一个 SDK 客户端 */
export function getSDKClient() {
  return getClient();
}

/**
 * 用数据库消息重建当前 conversation 的上下文。
 * 先按条数取最近 MAX_CONTEXT_MESSAGES 条，再按字符预算从最旧的开始裁剪，
 * 保证至少保留最后一条（也就是用户当前的提问）。
 * @param {Array<{role:string,content:string}>} messages 按时间升序
 */
export function buildInput(messages) {
  const recent = messages.slice(-MAX_CONTEXT_MESSAGES);

  let total = 0;
  const picked = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const len = String(recent[i].content || '').length;
    if (picked.length > 0 && total + len > MAX_CONTEXT_CHARS) break;
    total += len;
    // images 只跟随消息透传（由 buildXxxRequest 决定是否真的内联，仅最后一条 user 消息）；无图不带键
    const item = { role: recent[i].role, content: recent[i].content };
    if (Array.isArray(recent[i].images) && recent[i].images.length) item.images = recent[i].images;
    picked.unshift(item);
  }
  return picked;
}

/** 每条消息最多内联的图片数（防一次性发太多图） */
export const MAX_IMAGES_PER_MESSAGE = 4;

/**
 * 组装一条消息的请求载荷：仅「最后一条 user 消息」且带图片时才内联多模态内容，
 * 历史消息里的图不重复发送（省 token、防上下文爆炸）。
 * mode='responses' -> input_text / input_image；mode='chat_completions' -> text / image_url
 */
function toMultimodalMessage(m, isLast, mode) {
  if (!isLast || m.role !== 'user' || !Array.isArray(m.images) || !m.images.length) {
    return { role: m.role, content: m.content };
  }
  const imgs = m.images.slice(0, MAX_IMAGES_PER_MESSAGE);
  if (mode === 'chat_completions') {
    const content = [{ type: 'text', text: m.content }];
    imgs.forEach(function (img) {
      content.push({ type: 'image_url', image_url: { url: 'data:' + img.mime + ';base64,' + img.data } });
    });
    return { role: 'user', content: content };
  }
  const content = [{ type: 'input_text', text: m.content }];
  imgs.forEach(function (img) {
    content.push({ type: 'input_image', image_url: 'data:' + img.mime + ';base64,' + img.data });
  });
  return { role: 'user', content: content };
}

/** 系统提示 = 基础人设 + （可选）当前会话的附件文档上下文 */
function buildInstructions(documents) {
  return documents ? SYSTEM_INSTRUCTIONS + '\n\n' + documents : SYSTEM_INSTRUCTIONS;
}

/** Responses 模式请求体 */
function buildResponsesRequest(messages, documents) {
  const input = buildInput(messages);
  return {
    model: getModel(),
    instructions: buildInstructions(documents),
    input: input.map(function (m, i) { return toMultimodalMessage(m, i === input.length - 1, 'responses'); })
  };
}

/** Chat Completions 模式请求体：system + 历史消息 */
function buildChatMessages(messages, documents) {
  const input = buildInput(messages);
  return [{ role: 'system', content: buildInstructions(documents) }].concat(
    input.map(function (m, i) { return toMultimodalMessage(m, i === input.length - 1, 'chat_completions'); })
  );
}

/** 从 Responses API 响应中提取纯文本 */
function extractText(response) {
  if (response && typeof response.output_text === 'string' && response.output_text) {
    return response.output_text;
  }
  let text = '';
  const items = (response && response.output) || [];
  for (const item of items) {
    for (const part of item.content || []) {
      if (part && part.type === 'output_text' && typeof part.text === 'string') {
        text += part.text;
      }
    }
  }
  return text;
}

/** 从 Chat Completions 响应中提取纯文本 */
function extractChatText(response) {
  const choices = response && response.choices;
  const choice = choices && choices[0];
  const msg = choice && choice.message;
  return msg && typeof msg.content === 'string' ? msg.content : '';
}

/**
 * 空闲看门狗：每次 kick() 重置计时；超时则 abort 上游请求并置 timedOut。
 * linkSignal（例如「客户端已断开」）触发时立刻 abort，但不算超时。
 */
function createIdleWatchdog(linkSignal) {
  const ms = getIdleTimeoutMs();
  const controller = new AbortController();
  let timer = null;
  let fired = false;
  let onLinkAbort = null;

  function arm() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      controller.abort();
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  }
  arm();

  if (linkSignal) {
    onLinkAbort = () => { controller.abort(); };
    if (linkSignal.aborted) onLinkAbort();
    else linkSignal.addEventListener('abort', onLinkAbort, { once: true });
  }

  return {
    signal: controller.signal,
    kick: arm,
    isTimedOut() { return fired; },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (linkSignal && onLinkAbort) linkSignal.removeEventListener('abort', onLinkAbort);
    }
  };
}

/** 表示「模型已正常收尾」的终止事件；缺失即视为流被中途截断 */
const TERMINAL_EVENT_TYPES = new Set(['response.completed', 'response.incomplete', 'response.failed']);

/** 流式入口：按 AI_API_MODE 分发（绝不自动回退到另一种模式） */
export async function streamChat(messages, onDelta, options) {
  if (!isOpenAIConfigured()) throw new OpenAIConfigError();
  const { mode } = getAIConfig();
  if (mode === 'chat_completions') return streamChatCompletions(messages, onDelta, options);
  return streamResponses(messages, onDelta, options);
}

/**
 * Responses API 流式。
 * 注意：这里故意不用 SDK 的 responses.stream() 助手，而用低层 create({stream:true})：
 * 助手内部会对事件序列做严格累积（要求先发 output_item.added / content_part.added），
 * 不少中转站不发这两个铺垫事件，会直接抛 "missing content at index 0"。
 * 低层接口只解析 SSE 事件流，序列校验由我们自己完成（终止事件 + 截断检测），
 * 对官方与宽松中转站都兼容。
 */
async function streamResponses(messages, onDelta, options) {
  const watchdog = createIdleWatchdog(options && options.signal ? options.signal : null);
  try {
    const stream = await getClient().responses.create(
      Object.assign({}, buildResponsesRequest(messages, options && options.documents), { stream: true }),
      { signal: watchdog.signal }
    );
    let full = '';
    let terminalType = '';
    let terminalResponse = null;

    for await (const event of stream) {
      watchdog.kick();
      const type = event && event.type;
      if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        full += event.delta;
        if (onDelta) onDelta(event.delta);
      } else if (TERMINAL_EVENT_TYPES.has(type)) {
        terminalType = type;
        terminalResponse = event.response || null;
      }
    }

    if (watchdog.isTimedOut()) throw new OpenAITimeoutError();
    // 没收到终止事件 = 流被中途截断（代理断连、上游异常收尾等）：按失败处理
    if (!terminalType) throw new OpenAIStreamError('AI 响应流意外中断');
    if (terminalType === 'response.failed') throw new OpenAIStreamError('AI 返回失败事件');

    // 优先用终止事件里的完整响应文本，兜底用逐段累积结果
    return extractText(terminalResponse) || full;
  } catch (err) {
    if (watchdog.isTimedOut()) throw new OpenAITimeoutError();
    throw err;
  } finally {
    watchdog.stop();
  }
}

/** Chat Completions 流式：安全解析 delta，不假定每个 chunk 都有 content */
async function streamChatCompletions(messages, onDelta, options) {
  const watchdog = createIdleWatchdog(options && options.signal ? options.signal : null);
  try {
    const stream = await getClient().chat.completions.create({
      model: getModel(),
      messages: buildChatMessages(messages, options && options.documents),
      stream: true
    }, { signal: watchdog.signal });

    let full = '';
    let finishReason = '';

    for await (const chunk of stream) {
      watchdog.kick();
      const choices = chunk && chunk.choices;
      const choice = choices && choices[0];
      const delta = choice && choice.delta && typeof choice.delta.content === 'string'
        ? choice.delta.content
        : '';
      if (delta) {
        full += delta;
        if (onDelta) onDelta(delta);
      }
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
    }

    if (watchdog.isTimedOut()) throw new OpenAITimeoutError();
    // 没有 finish_reason = 流被中途截断：按失败处理，调用方不得保存半截回复
    if (!finishReason) throw new OpenAIStreamError('AI 响应流意外中断');
    return full;
  } catch (err) {
    if (watchdog.isTimedOut()) throw new OpenAITimeoutError();
    throw err;
  } finally {
    watchdog.stop();
  }
}

/** 非流式入口：按 AI_API_MODE 分发 */
export async function completeChat(messages, options) {
  if (!isOpenAIConfigured()) throw new OpenAIConfigError();
  const { mode } = getAIConfig();
  const watchdog = createIdleWatchdog(options && options.signal ? options.signal : null);
  try {
    if (mode === 'chat_completions') {
      const response = await getClient().chat.completions.create({
        model: getModel(),
        messages: buildChatMessages(messages, options && options.documents),
        stream: false
      }, { signal: watchdog.signal });
      if (watchdog.isTimedOut()) throw new OpenAITimeoutError();
      return extractChatText(response);
    }
    const response = await getClient().responses.create(buildResponsesRequest(messages, options && options.documents), { signal: watchdog.signal });
    if (watchdog.isTimedOut()) throw new OpenAITimeoutError();
    return extractText(response);
  } catch (err) {
    if (watchdog.isTimedOut()) throw new OpenAITimeoutError();
    throw err;
  } finally {
    watchdog.stop();
  }
}

/**
 * 把上游 / 本地错误映射成「可以对用户展示」的中文提示。
 * 只依据状态码 / 错误码语义，绝不把密钥、Authorization、请求头或 .env 内容丢给前端。
 * @param {Error} err
 * @param {{mode?:string}} [context] 覆盖当前模式（默认读环境变量）
 */
export function describeOpenAIError(err, context) {
  if (err instanceof OpenAIConfigError) return err.message;
  if (err instanceof OpenAITimeoutError) return 'AI 响应超时，请稍后重试';
  if (err instanceof OpenAIStreamError) return 'AI 回复失败，请重试。';

  const body = err && typeof err.error === 'object' && err.error ? err.error : {};
  const code = String(err && err.code !== undefined ? err.code : body.code || '').toLowerCase();
  const type = String(err && err.type !== undefined ? err.type : body.type || '').toLowerCase();
  const message = String((err && err.message) || body.message || '').toLowerCase();
  const status = Number(err && err.status);
  const mode = context && context.mode ? context.mode : getAIConfig().mode;

  // 404：responses 模式下大概率是中转站不支持 Responses API，直接给出切换建议
  // （只提示，不自动改模式、不自动重发收费请求）
  if (status === 404 || code === 'model_not_found') {
    if (mode === 'responses') {
      return '当前中转站可能不支持 Responses API，请将 AI_API_MODE 改为 chat_completions。';
    }
    return 'AI API 地址或模型接口不存在';
  }
  if (status === 401 || code === 'invalid_api_key') return 'AI API Key 无效或未授权';
  if (status === 403) return '当前 API Key 没有该模型权限';
  if (status === 429 || code === 'rate_limit_exceeded' || code === 'insufficient_quota' || type === 'insufficient_quota') {
    return 'AI 请求过于频繁或中转站额度不足';
  }
  if (status >= 500 && status <= 599) return 'AI 服务暂时不可用';

  // 网络层失败（拿不到 HTTP 状态：DNS / 拒连 / socket 超时等）
  const networkish = String((err && err.code) || '').toUpperCase();
  if (!status && (
    networkish === 'ECONNREFUSED' || networkish === 'ENOTFOUND' || networkish === 'EAI_AGAIN' ||
    networkish === 'UND_ERR_CONNECT_TIMEOUT' ||
    /connection|network|fetch failed|socket/i.test(message)
  )) {
    return '无法连接 AI 服务';
  }
  if (message.indexOf('abort') > -1) return 'AI 响应超时，请稍后重试';

  return 'AI 回复失败，请重试。';
}