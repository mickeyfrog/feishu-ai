/**
 * SQLite 数据层（better-sqlite3）
 * -------------------------------------------------------------
 * - 数据库文件：data/feishu-ai.db（目录不存在时自动创建）
 * - PRAGMA：foreign_keys = ON、journal_mode = WAL
 * - 三张表：users / conversations / messages（外键 CASCADE）
 * - 所有查询都通过预编译语句暴露为函数，路由层不写裸 SQL
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data');

// 目录不存在自动创建
fs.mkdirSync(dataDir, { recursive: true });

// 默认使用 data/feishu-ai.db；测试可用环境变量 DB_FILE 指向独立文件，避免污染正式数据
export const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(dataDir, 'feishu-ai.db');

export const db = new Database(DB_FILE);

// 外键约束 + WAL 模式（并发读更好，适合组内少量用户）
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

/* ----------------------------- 建表 ----------------------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  feishu_user_id TEXT UNIQUE NOT NULL,
  name           TEXT,
  avatar         TEXT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  title      TEXT NOT NULL DEFAULT '新对话',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  user_id         INTEGER NOT NULL,
  filename        TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  stored_name     TEXT NOT NULL,
  extracted_text  TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS generated_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  prompt      TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime        TEXT,
  model       TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_generated_images_user ON generated_images(user_id, id DESC);


`);

// 幂等迁移：conversations.external_url（ChatGPT 网页会话地址，browser 对话模式用于续聊）
const convCols = db.prepare('PRAGMA table_info(conversations)').all().map(function (c) { return c.name; });
if (convCols.indexOf('external_url') === -1) {
  db.exec('ALTER TABLE conversations ADD COLUMN external_url TEXT');
}

// 幂等迁移：users.username / password_hash（本地账号注册登录，2026-09-24 替代飞书 OAuth）
const userCols = db.prepare('PRAGMA table_info(users)').all().map(function (c) { return c.name; });
if (userCols.indexOf('username') === -1) {
  db.exec('ALTER TABLE users ADD COLUMN username TEXT');
}
if (userCols.indexOf('password_hash') === -1) {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL');

// 幂等迁移：messages.model（记录这条 AI 回复由哪个模型生成，前端展示用）
const msgCols = db.prepare('PRAGMA table_info(messages)').all().map(function (c) { return c.name; });
if (msgCols.indexOf('model') === -1) {
  db.exec('ALTER TABLE messages ADD COLUMN model TEXT');
}

// 幂等迁移：attachments.message_id（附件绑定到具体消息；NULL = 输入框里的待发附件）
const attCols = db.prepare('PRAGMA table_info(attachments)').all().map(function (c) { return c.name; });
if (attCols.indexOf('message_id') === -1) {
  db.exec('ALTER TABLE attachments ADD COLUMN message_id INTEGER');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)');

// 说明：UPDATE 语句统一使用 strftime('%Y-%m-%d %H:%M:%f','now')（毫秒精度，仍为 UTC 文本），
// 保证「最近更新」的会话排序稳定；INSERT 仍沿用列默认值 CURRENT_TIMESTAMP。

/* ----------------------------- 预编译语句 ----------------------------- */
const stmt = {
  upsertUser: db.prepare(`
    INSERT INTO users (feishu_user_id, name, avatar)
    VALUES (@feishuUserId, @name, @avatar)
    ON CONFLICT(feishu_user_id) DO UPDATE SET
      name = @name,
      avatar = @avatar,
      updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
  `),
  userByFeishuId: db.prepare('SELECT * FROM users WHERE feishu_user_id = ?'),

  listConversations: db.prepare(`
    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations
    WHERE user_id = ?
    ORDER BY updated_at DESC, id DESC
  `),
  createConversation: db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)'),
  conversationById: db.prepare('SELECT id, user_id AS userId, title, external_url AS externalUrl, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE id = ?'),
  conversationForUser: db.prepare('SELECT id, user_id AS userId, title, external_url AS externalUrl, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE id = ? AND user_id = ?'),
  renameConversationForUser: db.prepare("UPDATE conversations SET title = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ? AND user_id = ?"),
  setConversationTitle: db.prepare("UPDATE conversations SET title = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?"),
  touchConversation: db.prepare("UPDATE conversations SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?"),
  deleteConversationForUser: db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?'),
  setExternalUrl: db.prepare('UPDATE conversations SET external_url = ? WHERE id = ?'),

  listMessages: db.prepare(`
    SELECT id, role, content, created_at AS createdAt
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC, id ASC
  `),
  listRecentMessages: db.prepare(`
    SELECT id, role, content, created_at AS createdAt
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `),
  countMessages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?'),
  addMessage: db.prepare('INSERT INTO messages (conversation_id, role, content, model) VALUES (?, ?, ?, ?)'),
  messageById: db.prepare('SELECT id, conversation_id AS conversationId, role, content, model, created_at AS createdAt FROM messages WHERE id = ?'),
  lastMessage: db.prepare('SELECT id, conversation_id AS conversationId, role, content, model FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1'),
  lastUserMessage: db.prepare("SELECT id, conversation_id AS conversationId, role, content, model FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1"),
  updateMessageContent: db.prepare('UPDATE messages SET content = ? WHERE id = ?'),
  deleteMessageById: db.prepare('DELETE FROM messages WHERE id = ?'),
  deleteMessagesFrom: db.prepare('DELETE FROM messages WHERE conversation_id = ? AND id >= ?'),
  // 将随消息一起删除的附件（返回 id 与磁盘名，供路由层删文件）
  attachmentsFromMessage: db.prepare('SELECT id, stored_name AS storedName FROM attachments WHERE conversation_id = ? AND message_id IS NOT NULL AND message_id >= ?'),
  deleteAttachmentsFromMessage: db.prepare('DELETE FROM attachments WHERE conversation_id = ? AND message_id IS NOT NULL AND message_id >= ?'),

  addAttachment: db.prepare('INSERT INTO attachments (conversation_id, user_id, message_id, filename, mime, size, stored_name, extracted_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  // 输入框 chips 只列「待发」附件（message_id IS NULL）；已发送的随消息气泡展示
  listPendingAttachments: db.prepare(`
    SELECT id, conversation_id AS conversationId, filename, mime, size, stored_name AS storedName,
           CASE WHEN extracted_text IS NOT NULL AND extracted_text != '' THEN 1 ELSE 0 END AS hasText,
           created_at AS createdAt
    FROM attachments WHERE conversation_id = ? AND user_id = ? AND message_id IS NULL ORDER BY id ASC
  `),
  bindPendingAttachments: db.prepare('UPDATE attachments SET message_id = ? WHERE conversation_id = ? AND user_id = ? AND message_id IS NULL'),
  listBoundAttachments: db.prepare(`
    SELECT id, message_id AS messageId, filename, mime, size,
           CASE WHEN extracted_text IS NOT NULL AND extracted_text != '' THEN 1 ELSE 0 END AS hasText,
           created_at AS createdAt
    FROM attachments WHERE conversation_id = ? AND user_id = ? AND message_id IS NOT NULL ORDER BY id ASC
  `),
  imagesForMessage: db.prepare("SELECT id, mime, stored_name AS storedName FROM attachments WHERE message_id = ? AND mime LIKE 'image/%' ORDER BY id ASC"),
  attachmentForUser: db.prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?'),
  deleteAttachmentForUser: db.prepare('DELETE FROM attachments WHERE id = ? AND user_id = ?'),
  attachmentTexts: db.prepare('SELECT filename, extracted_text AS extractedText FROM attachments WHERE conversation_id = ? AND user_id = ? ORDER BY id ASC'),

  addGeneratedImage: db.prepare('INSERT INTO generated_images (user_id, prompt, stored_name, mime, model) VALUES (?, ?, ?, ?, ?)'),
  listGeneratedImages: db.prepare('SELECT id, prompt, mime, model, stored_name AS storedName, created_at AS createdAt FROM generated_images WHERE user_id = ? ORDER BY id DESC LIMIT 60'),
  generatedImageForUser: db.prepare('SELECT * FROM generated_images WHERE id = ? AND user_id = ?'),


};

/* ----------------------------- users ----------------------------- */

/**
 * 飞书登录成功后同步用户：不存在则插入，存在则更新 name / avatar / updated_at。
 * 以飞书稳定唯一 ID（open_id）为唯一身份，不用姓名做标识。
 */
export function upsertFeishuUser({ feishuUserId, name, avatar }) {
  stmt.upsertUser.run({
    feishuUserId,
    name: name || '',
    avatar: avatar || ''
  });
  return stmt.userByFeishuId.get(feishuUserId);
}

/* ----------------------------- 本地账号（注册/登录） ----------------------------- */

const LOCAL_ID_PREFIX = 'local:';

/** 用户名是否已注册 */
export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
}

/**
 * 创建本地账号。username 唯一（重复抛 UNIQUE 错误，由路由层转成 409）。
 * feishu_user_id 写入 local:<username> 占位，兼容旧表的唯一约束（旧飞书数据不受影响）。
 */
export function createLocalUser(username, passwordHash) {
  const uname = String(username || '').trim();
  const info = db.prepare(
    'INSERT INTO users (feishu_user_id, name, avatar, username, password_hash) VALUES (?, ?, ?, ?, ?)'
  ).run(LOCAL_ID_PREFIX + uname, uname, '', uname, passwordHash);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
}

/* ----------------------------- conversations ----------------------------- */

export function listConversations(userId) {
  return stmt.listConversations.all(userId);
}

export function createConversation(userId, title) {
  const info = stmt.createConversation.run(userId, title || '新对话');
  return stmt.conversationById.get(info.lastInsertRowid);
}

export function getConversationForUser(conversationId, userId) {
  return stmt.conversationForUser.get(conversationId, userId);
}

export function renameConversationForUser(conversationId, userId, title) {
  const info = stmt.renameConversationForUser.run(title, conversationId, userId);
  return info.changes > 0;
}

/** 内部使用：自动标题（不走用户归属校验，调用方已校验归属） */
export function setConversationTitle(conversationId, title) {
  return stmt.setConversationTitle.run(title, conversationId).changes > 0;
}

export function touchConversation(conversationId) {
  return stmt.touchConversation.run(conversationId).changes > 0;
}

/**
 * 记录会话对应的「外部会话地址」（browser 对话模式下 ChatGPT 的 /c/<id> URL）。
 * 只在值变化时写入；不动 updated_at（避免外部回写影响会话排序）。
 */
export function setConversationExternalUrl(conversationId, url) {
  return stmt.setExternalUrl.run(String(url || ''), conversationId).changes > 0;
}

export function deleteConversationForUser(conversationId, userId) {
  const info = stmt.deleteConversationForUser.run(conversationId, userId);
  return info.changes > 0;
}

/* ----------------------------- messages ----------------------------- */

const ALLOWED_ROLES = new Set(['user', 'assistant']);

export function listMessages(conversationId) {
  return stmt.listMessages.all(conversationId);
}

export function listRecentMessages(conversationId, limit) {
  return stmt.listRecentMessages.all(conversationId, limit);
}

export function countMessages(conversationId) {
  return stmt.countMessages.get(conversationId).n;
}

export function addMessage(conversationId, role, content, model) {
  if (!ALLOWED_ROLES.has(role)) {
    throw new Error('非法的消息 role：' + role);
  }
  const info = stmt.addMessage.run(conversationId, role, String(content), model ? String(model) : null);
  return stmt.messageById.get(info.lastInsertRowid);
}



/* ----------------------------- messages（补充操作） ----------------------------- */

/** 会话最后一条消息（重新生成时判断是否要删掉旧回答） */
export function getLastMessage(conversationId) {
  return stmt.lastMessage.get(conversationId);
}

/** 会话最后一条用户消息（重新生成 / 编辑后重答的输入） */
export function getLastUserMessage(conversationId) {
  return stmt.lastUserMessage.get(conversationId);
}

/** 按 id 取消息（含 conversationId，供归属校验） */
export function getMessageById(messageId) {
  return stmt.messageById.get(messageId);
}

/** 改写消息内容（仅用于用户消息的编辑） */
export function updateMessageContent(messageId, content) {
  return stmt.updateMessageContent.run(String(content), messageId).changes > 0;
}

/** 删除单条消息 */
export function deleteMessageById(messageId) {
  return stmt.deleteMessageById.run(messageId).changes > 0;
}

/** 删除该会话中 id >= fromMessageId 的全部消息（编辑 / 删除后级联清理） */
export function deleteMessagesFrom(conversationId, fromMessageId) {
  return stmt.deleteMessagesFrom.run(conversationId, fromMessageId).changes;
}

/** 找出将随消息删除的附件（返回 { id, storedName }，路由层负责删磁盘文件） */
export function listAttachmentsFromMessage(conversationId, fromMessageId) {
  return stmt.attachmentsFromMessage.all(conversationId, fromMessageId);
}

/** 删除这些消息绑定的附件记录 */
export function deleteAttachmentsFromMessage(conversationId, fromMessageId) {
  return stmt.deleteAttachmentsFromMessage.run(conversationId, fromMessageId).changes;
}

/* ----------------------------- attachments ----------------------------- */

export function addAttachment({ conversationId, userId, messageId, filename, mime, size, storedName, extractedText }) {
  const info = stmt.addAttachment.run(
    conversationId, userId, messageId || null, filename, mime, size, storedName,
    extractedText === undefined || extractedText === null ? null : String(extractedText)
  );
  return stmt.attachmentForUser.get(Number(info.lastInsertRowid), userId);
}

/** 输入框 chips：只列「待发」附件（未绑定消息的） */
export function listAttachmentsForUser(conversationId, userId) {
  return stmt.listPendingAttachments.all(conversationId, userId);
}

/** 发送消息时调用：把该会话所有待发附件绑定到这条消息 */
export function bindPendingAttachments(conversationId, userId, messageId) {
  return stmt.bindPendingAttachments.run(messageId, conversationId, userId).changes;
}

/** 历史消息渲染用：该会话全部已绑定附件（按 messageId 分组由调用方做） */
export function listBoundAttachments(conversationId, userId) {
  return stmt.listBoundAttachments.all(conversationId, userId);
}

/** 某条消息的图片附件（多模态视觉用） */
export function listImagesForMessage(messageId) {
  return stmt.imagesForMessage.all(messageId);
}

export function getAttachmentForUser(id, userId) {
  return stmt.attachmentForUser.get(id, userId);
}

export function deleteAttachmentForUser(id, userId) {
  return stmt.deleteAttachmentForUser.run(id, userId).changes > 0;
}

export function listAttachmentTexts(conversationId, userId) {
  return stmt.attachmentTexts.all(conversationId, userId);
}

/* ----------------------------- generated images ----------------------------- */

export function addGeneratedImage({ userId, prompt, storedName, mime, model }) {
  const info = stmt.addGeneratedImage.run(userId, prompt, storedName, mime || null, model || null);
  return { id: Number(info.lastInsertRowid) };
}

export function listGeneratedImages(userId) {
  return stmt.listGeneratedImages.all(userId);
}

export function getGeneratedImageForUser(id, userId) {
  return stmt.generatedImageForUser.get(id, userId);
}
