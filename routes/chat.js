/**
 * 聊天路由：routes/chat.js
 * -------------------------------------------------------------
 *   POST /api/conversations/:id/chat         非流式（兜底 / 调试用）
 *   POST /api/conversations/:id/chat/stream  流式（SSE，前端默认使用）
 *
 * 流程（两个接口一致）：
 *   requireAuth -> 校验 message -> 校验会话归属（不属于当前用户统一 404）
 *   -> 未配置 AI 时直接 503「服务器尚未配置 AI API」
 *   -> 保存用户消息 -> 首条消息自动生成标题
 *   -> 用数据库里的历史消息重建上下文 -> 调用 OpenAI Responses API
 *   -> 内存累积完整回复，结束后「一次性」写入 assistant 消息 -> 更新 updated_at
 *
 * 异常约定：
 *   中途失败（或客户端断开）时，不保存半截 assistant 消息；用户消息保留。
 *
 * 并发约定：
 *   同一会话同一时刻只允许一个生成任务，第二个请求返回 409「上一条回复还在生成中，请稍后再试」。
 *
 * 附件约定：
 *   保存用户消息后立刻把「待发附件」（message_id IS NULL）绑定到这条消息；
 *   其中的图片附件以 base64 内联进多模态请求（仅当前这条消息，历史不重复发送）；
 *   AI_VISION=false 可关闭图片内联（比如换到不支持视觉的模型时）。
 */

import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import {
  getConversationForUser,
  addMessage,
  listMessages,
  countMessages,
  touchConversation,
  setConversationTitle,
  listAttachmentTexts,
  setConversationExternalUrl,
  bindPendingAttachments,
  listImagesForMessage
} from '../database/db.js';
import {
  isOpenAIConfigured,
  streamChat,
  completeChat,
  OpenAIConfigError,
  describeOpenAIError
} from '../services/openai.js';
import {
  isBrowserChatEnabled,
  streamChatViaBrowser,
  describeBrowserChatError
} from '../services/chat-browser.js';
import { isWebSearchEnabled, searchWeb, buildSearchBlock } from '../services/search.js';
import { loadImagesAsBase64 } from '../services/files.js';

const router = Router();

// 本文件下所有接口都必须先登录飞书
router.use(requireAuth);

const DEFAULT_TITLE = '新对话';
const TITLE_MAX_LENGTH = 30;        // 自动标题：取前 20~30 个字符
const MESSAGE_MAX_LENGTH = 4000;    // 与前端 textarea maxlength 保持一致
const AI_ERROR_TEXT = 'AI 回复失败，请重试。';
const CONFIG_ERROR_TEXT = '服务器尚未配置 AI API';
const SSE_HEARTBEAT_MS = 15000;     // 长连接保活注释帧（Cloudflare Tunnel 支持长连接）
const BUSY_MESSAGE = '上一条回复还在生成中，请稍后再试';

/**
 * 同一会话同一时刻只允许一个生成任务：
 * 避免并发请求把上下文写乱、重复自动标题、重复消耗额度。
 * 前端 isSending 只是体验层保护，这里才是权威约束。
 */
const inflightGenerations = new Set();

function acquireGeneration(conversationId) {
  if (inflightGenerations.has(conversationId)) return false;
  inflightGenerations.add(conversationId);
  return true;
}

function releaseGeneration(conversationId) {
  inflightGenerations.delete(conversationId);
}

/** 客户端主动断开（关页面 / 取消）标记，用 Error 子类从 streamChat 的回调里抛出以中断上游请求 */
class ClientGoneError extends Error {
  constructor() {
    super('客户端已断开连接');
    this.name = 'ClientGoneError';
  }
}

/* ========================= 公共小工具 ========================= */

function respondNotFound(res) {
  res.status(404).json({ success: false, message: '对话不存在' });
  return null;
}

/** 解析 :id 并确认归属当前用户；失败时已写好响应并返回 null */
function loadOwnedConversation(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return respondNotFound(res);

  const conversation = getConversationForUser(id, req.session.user.id);
  if (!conversation) return respondNotFound(res);

  return conversation;
}

/** 读取并校验请求体里的 message；失败时已写好响应并返回 null */
function readUserMessage(req, res) {
  const body = req.body || {};
  const message = body.message;

  if (typeof message !== 'string' || message.trim() === '') {
    res.status(400).json({ success: false, message: '消息不能为空' });
    return null;
  }

  const text = message.trim();
  if (text.length > MESSAGE_MAX_LENGTH) {
    res.status(400).json({
      success: false,
      message: '消息过长（最多 ' + MESSAGE_MAX_LENGTH + ' 个字符）'
    });
    return null;
  }
  return text;
}

/** 自动标题：去掉换行与多余空白，取前 30 个字符，过长则截断加 ... */
function buildTitleFromText(text) {
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  if (!cleaned) return DEFAULT_TITLE;
  return cleaned.length > TITLE_MAX_LENGTH ? cleaned.slice(0, TITLE_MAX_LENGTH) + '...' : cleaned;
}

/**
 * 组装「文档上下文」= 会话附件 + （可选）联网搜索结果。
 * 搜索失败 / 超时只记日志并降级为无搜索回答，绝不让搜索拖垮对话。
 */
async function buildContextDocuments(conversationId, userId, query, wantSearch) {
  let documents = buildDocumentsBlock(conversationId, userId);
  if (!wantSearch) return documents;
  try {
    const results = await searchWeb(query);
    const block = buildSearchBlock(results);
    if (block) documents = documents ? documents + '\n\n' + block : block;
  } catch (searchErr) {
    console.error('[联网搜索] 搜索失败（继续无搜索回答）：', searchErr && searchErr.message ? searchErr.message : searchErr);
  }
  return documents;
}

/** 读取请求体里的联网开关：前端 search=true 且服务端未禁用才生效 */
function readSearchFlag(req) {
  return Boolean(req.body && req.body.search === true) && isWebSearchEnabled();
}

/**
 * 把当前会话的附件抽取文本拼成「文档上下文」，随请求交给模型。
 * 没有附件（或附件无文本，如图片）时返回空串，不影响原有行为。
 */
function buildDocumentsBlock(conversationId, userId) {
  const rows = listAttachmentTexts(conversationId, userId);
  const withText = rows.filter(function (row) {
    return row.extractedText && String(row.extractedText).trim();
  });
  if (!withText.length) return '';
  return '以下是用户在当前会话上传的文件内容，回答相关问题时请结合它们：\n' +
    withText.map(function (row) {
      return '----- 文件：' + row.filename + ' -----\n' + row.extractedText;
    }).join('\n\n');
}

/**
 * 保存用户消息 + 必要时自动生成标题。
 * 只在「本会话第一条消息」且标题仍是默认「新对话」时生成标题（不额外调用 AI）。
 * @returns {{ userMessage: object, title: string }}
 */
function saveUserMessageAndMaybeTitle(conversation, text) {
  const isFirstMessage = countMessages(conversation.id) === 0;

  const userMessage = addMessage(conversation.id, 'user', text);

  let title = conversation.title;
  if (isFirstMessage && conversation.title === DEFAULT_TITLE) {
    title = buildTitleFromText(text);
    setConversationTitle(conversation.id, title);
  }
  return { userMessage, title };
}

/**
 * 发送消息时的附件处理：
 *   1. 把本会话「待发附件」（message_id IS NULL）绑定到刚保存的这条用户消息
 *      —— 之后输入框 chips 自然清空，附件随消息气泡展示；
 *   2. 其中的图片以 base64 内联挂到历史里这条消息上（多模态视觉），仅当前消息，历史不重复发图。
 * AI_VISION=false 可整体关闭图片内联（比如模型不支持视觉时）。
 */
function bindAttachmentsAndApplyImages(conversation, userId, userMessage, history) {
  bindPendingAttachments(conversation.id, userId, userMessage.id);
  if (String(process.env.AI_VISION || 'true').trim() === 'false') return;
  const rows = listImagesForMessage(userMessage.id);
  if (!rows.length) return;
  const images = loadImagesAsBase64(rows);
  if (!images.length) return;
  // history 最后一条就是刚保存的这条 user 消息
  const last = history[history.length - 1];
  if (last && last.role === 'user' && last.id === userMessage.id) last.images = images;
}

/** 写一条 SSE 数据帧：data: {json}\n\n */
function sseSend(res, payload) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
    return true;
  } catch (writeError) {
    // 连接已断（EPIPE 等）：静默失败，由 clientGone / close 事件收尾
    return false;
  }
}

/** 统一的「AI 调用前置检查」：未配置 Key / 模型时返回明确错误，不泄露任何密钥信息 */
function ensureAIConfigured(res) {
  if (isBrowserChatEnabled()) return true; // browser 模式不需要 API Key，连接问题在调用时再报
  if (isOpenAIConfigured()) return true;
  res.status(503).json({ success: false, message: CONFIG_ERROR_TEXT });
  return false;
}

/** 判断是否为浏览器自动化层抛出的错误（按 name 识别，避免硬依赖具体类） */
function isBrowserError(err) {
  return typeof (err && err.name) === 'string' && err.name.indexOf('Browser') === 0;
}

/** 统一的「调用失败 -> 用户可读文案」：browser 错误走 browser 文案，其余走 OpenAI 文案 */
function describeChatError(err) {
  return isBrowserError(err) ? describeBrowserChatError(err) : describeOpenAIError(err);
}

/**
 * 浏览器对话模式：把 feishu 会话的消息转发给本机已登录的 ChatGPT 网页。
 * - documents（附件/搜索上下文）拼在用户消息前面，网页版没有独立上下文通道；
 * - conversation.externalUrl 存在时续聊原 ChatGPT 会话，否则开新会话并把 /c/<id> 回写数据库；
 * - 返回 { text, url }；失败抛 Browser* 错误，由路由统一映射文案；绝不回退到 API。
 */
async function runBrowserChat(conversation, text, documents, signal, onDelta) {
  const payload = documents
    ? documents + '\n\n用户消息：\n' + text
    : text;
  const result = await streamChatViaBrowser({
    conversationUrl: conversation.externalUrl || '',
    text: payload,
    signal: signal,
    onDelta: onDelta
  });
  if (result.url && result.url !== (conversation.externalUrl || '')) {
    setConversationExternalUrl(conversation.id, result.url);
    conversation.externalUrl = result.url;
  }
  return result;
}

/* ========================= 非流式接口 ========================= */

/**
 * POST /api/conversations/:id/chat
 * 请求体：{ "message": "用户问题" }
 * 返回：  { success, reply, title, conversationId }
 */
router.post('/:id/chat', async (req, res) => {
  const conversation = loadOwnedConversation(req, res);
  if (!conversation) return undefined;

  const text = readUserMessage(req, res);
  if (text === null) return undefined;

  if (!ensureAIConfigured(res)) return undefined;

  const wantSearch = readSearchFlag(req);

  // 并发保护：同一会话同时只允许一个生成任务
  if (!acquireGeneration(conversation.id)) {
    return res.status(409).json({ success: false, message: BUSY_MESSAGE });
  }

  try {
    const { userMessage, title } = saveUserMessageAndMaybeTitle(conversation, text);

    // 上下文 = 本会话记录 + 附件 + （可选）联网搜索
    const documents = await buildContextDocuments(conversation.id, req.session.user.id, text, wantSearch);
    const history = listMessages(conversation.id);
    bindAttachmentsAndApplyImages(conversation, req.session.user.id, userMessage, history);
    let answer;
    if (isBrowserChatEnabled()) {
      const result = await runBrowserChat(conversation, text, documents, undefined, undefined);
      answer = result.text;
    } else {
      answer = await completeChat(history, { documents: documents });
    }

    if (!answer || !answer.trim()) {
      return res.status(502).json({ success: false, message: AI_ERROR_TEXT });
    }

    const reply = addMessage(conversation.id, 'assistant', answer);
    touchConversation(conversation.id);

    return res.json({
      success: true,
      conversationId: conversation.id,
      title,
      reply
    });
  } catch (err) {
    // 失败时不保存半截 assistant 消息；用户消息已保存，保留
    console.error('[聊天] 调用 AI 失败（conversation ' + conversation.id + '）：', err && err.message ? err.message : err);
    const status = (err instanceof OpenAIConfigError || (err && err.name) === 'BrowserNotConnectedError') ? 503 : 502;
    return res.status(status).json({ success: false, message: describeChatError(err) });
  } finally {
    releaseGeneration(conversation.id);
  }
});

/* ========================= 流式接口（SSE） ========================= */

/**
 * POST /api/conversations/:id/chat/stream
 * 请求体：{ "message": "用户问题" }
 * 响应：  text/event-stream
 *   data: {"type":"start","conversationId":12,"title":"..."}
 *   data: {"type":"delta","text":"LM"}
 *   ...
 *   data: {"type":"done","messageId":34,"title":"..."}
 *   data: {"type":"error","message":"AI 回复失败，请重试。"}
 */
router.post('/:id/chat/stream', async (req, res) => {
  const conversation = loadOwnedConversation(req, res);
  if (!conversation) return undefined;

  const text = readUserMessage(req, res);
  if (text === null) return undefined;

  // 注意：SSE 一旦开始输出就无法再改状态码，
  // 所以「配置检查」和「并发检查」都必须在写 SSE 头之前完成
  if (!ensureAIConfigured(res)) return undefined;

  const wantSearch = readSearchFlag(req);
  if (!acquireGeneration(conversation.id)) {
    return res.status(409).json({ success: false, message: BUSY_MESSAGE });
  }

  try {
    await runStreamGeneration(res, conversation, text, req.session.user.id, wantSearch);
  } finally {
    releaseGeneration(conversation.id);
  }
  return undefined;
});

/** SSE 生成主体：写头 -> 逐段下发 -> 成功后一次性落库 / 失败发 error 事件 */
async function runStreamGeneration(res, conversation, text, userId, wantSearch) {
  const { userMessage, title } = saveUserMessageAndMaybeTitle(conversation, text);

  /* -------- 建立 SSE 响应 -------- */
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // 明确告知代理不要缓冲
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let clientGone = false;
  // 客户端断开时立刻 abort 上游请求：不浪费额度，也能尽快释放并发锁
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      abortController.abort();
    }
  });
  // socket 异常（EPIPE 等）不要变成未捕获异常
  res.on('error', () => {});

  // 保活注释帧，避免中间层在长时间无输出时掐断连接
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(': ping\n\n');
    } catch (writeError) { /* 连接已断，忽略 */ }
  }, SSE_HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const finish = () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };

  try {
    sseSend(res, { type: 'start', conversationId: conversation.id, title, search: wantSearch === true });

    const documents = await buildContextDocuments(conversation.id, userId, text, wantSearch);
    const history = listMessages(conversation.id);
    bindAttachmentsAndApplyImages(conversation, userId, userMessage, history);

    // 内存累积 + 逐段下发；数据库只在流结束后写一次
    let answer;
    let fullText = '';
    if (isBrowserChatEnabled()) {
      // browser 模式：伪流式增量是纯文本，最终排版以 done 里的 fullText（Markdown）为准
      const result = await runBrowserChat(conversation, text, documents, abortController.signal, (delta) => {
        if (clientGone) throw new ClientGoneError();
        sseSend(res, { type: 'delta', text: delta });
      });
      answer = result.text;
      fullText = result.text;
    } else {
      answer = await streamChat(history, (delta) => {
        if (clientGone) throw new ClientGoneError();
        sseSend(res, { type: 'delta', text: delta });
      }, { signal: abortController.signal, documents: documents });
    }

    if (clientGone) {
      // 客户端已断开：不保存半截内容，直接收尾
      return finish();
    }

    if (!answer || !answer.trim()) {
      sseSend(res, { type: 'error', message: AI_ERROR_TEXT });
      return finish();
    }

    const assistantMessage = addMessage(conversation.id, 'assistant', answer);
    touchConversation(conversation.id);

    sseSend(res, {
      type: 'done',
      messageId: assistantMessage.id,
      title: title,
      ...(fullText ? { fullText: fullText } : {})
    });
    return finish();
  } catch (err) {
    if (err instanceof ClientGoneError || clientGone) {
      return finish();
    }
    // 失败时不保存 assistant 消息（用户消息已保存，保留）
    console.error('[流式聊天] 调用 AI 失败（conversation ' + conversation.id + '）：', err && err.message ? err.message : err);
    sseSend(res, { type: 'error', message: describeChatError(err) });
    return finish();
  }
}

export default router;