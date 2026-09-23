/**
 * 会话（conversation）路由：routes/conversations.js
 * -------------------------------------------------------------
 *   GET    /api/conversations              列出「当前登录用户自己」的会话（updated_at DESC）
 *   POST   /api/conversations              新建会话（title 默认「新对话」）
 *   PATCH  /api/conversations/:id          重命名
 *   DELETE /api/conversations/:id          删除（messages 由外键 CASCADE 自动删除）
 *   GET    /api/conversations/:id/messages 读取历史消息
 *
 * 用户隔离（关键安全点）：
 *   - userId 一律取自 req.session.user.id，绝不接受前端提交的 user_id
 *   - 所有读写 SQL 都带 WHERE user_id = 当前用户
 *   - 不属于当前用户 / 不存在的会话，统一返回 404，不泄露「它属于别人」
 */

import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import {
  listConversations,
  createConversation,
  getConversationForUser,
  renameConversationForUser,
  deleteConversationForUser,
  listMessages,
  listBoundAttachments
} from '../database/db.js';

const router = Router();

// 本文件下所有接口都必须先登录飞书
router.use(requireAuth);

const DEFAULT_TITLE = '新对话';
const TITLE_MAX_LENGTH = 100;

/** 只对外暴露必要字段：内部 user_id 属于服务端归属信息，不下发前端 */
function publicConversation(conversation) {
  if (!conversation) return null;
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt
  };
}

/** 统一「对话不存在」响应：不区分「不存在」与「不属于你」 */
function respondNotFound(res) {
  return res.status(404).json({ success: false, message: '对话不存在' });
}

/** 解析并校验 :id，再确认归属当前用户；失败时已写好响应并返回 null */
function loadOwnedConversation(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    respondNotFound(res);
    return null;
  }

  const conversation = getConversationForUser(id, req.session.user.id);
  if (!conversation) {
    respondNotFound(res);
    return null;
  }

  return conversation;
}

/** GET /api/conversations —— 只返回当前用户自己的会话 */
router.get('/', (req, res) => {
  const conversations = listConversations(req.session.user.id);
  res.json({ success: true, conversations });
});

/** POST /api/conversations —— user_id 必须来自 session */
router.post('/', (req, res) => {
  const conversation = createConversation(req.session.user.id, DEFAULT_TITLE);
  res.status(201).json({ success: true, conversation: publicConversation(conversation) });
});

/** PATCH /api/conversations/:id —— 修改标题 */
router.patch('/:id', (req, res) => {
  const conversation = loadOwnedConversation(req, res);
  if (!conversation) return undefined;

  const body = req.body || {};
  const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';

  if (!rawTitle) {
    return res.status(400).json({ success: false, message: '标题不能为空' });
  }
  if (rawTitle.length > TITLE_MAX_LENGTH) {
    return res.status(400).json({ success: false, message: '标题过长（最多 ' + TITLE_MAX_LENGTH + ' 个字符）' });
  }

  renameConversationForUser(conversation.id, req.session.user.id, rawTitle);
  const updated = getConversationForUser(conversation.id, req.session.user.id);
  return res.json({ success: true, conversation: publicConversation(updated) });
});

/** DELETE /api/conversations/:id —— messages 随外键 CASCADE 一并删除 */
router.delete('/:id', (req, res) => {
  const conversation = loadOwnedConversation(req, res);
  if (!conversation) return undefined;

  const deleted = deleteConversationForUser(conversation.id, req.session.user.id);
  if (!deleted) return respondNotFound(res);

  return res.json({ success: true, id: conversation.id });
});

/** GET /api/conversations/:id/messages —— 先校验归属，再返回消息（created_at ASC） */
router.get('/:id/messages', (req, res) => {
  const conversation = loadOwnedConversation(req, res);
  if (!conversation) return undefined;

  const messages = listMessages(conversation.id);
  // 附件随消息下发：历史气泡里能直接看到 / 预览当时上传的文件
  const byMessage = new Map();
  for (const att of listBoundAttachments(conversation.id, req.session.user.id)) {
    const list = byMessage.get(att.messageId) || [];
    list.push({
      id: att.id,
      filename: att.filename,
      mime: att.mime,
      size: att.size,
      hasText: Boolean(att.hasText),
      isImage: String(att.mime).indexOf('image/') === 0,
      url: '/api/uploads/' + att.id + '/file',
      previewUrl: '/api/uploads/' + att.id + '/preview'
    });
    byMessage.set(att.messageId, list);
  }
  const withAtts = messages.map(function (m) {
    return Object.assign({}, m, { attachments: byMessage.get(m.id) || [] });
  });
  return res.json({
    success: true,
    conversation: publicConversation(conversation),
    messages: withAtts
  });
});

export default router;