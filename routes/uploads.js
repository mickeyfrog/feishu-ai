/**
 * 文件附件路由：routes/uploads.js
 * -------------------------------------------------------------
 *   POST   /api/conversations/:id/uploads  上传文件（multipart，字段名 file）
 *   GET    /api/conversations/:id/uploads  列出当前会话的附件
 *   DELETE /api/uploads/:id                删除附件（记录 + 磁盘文件）
 *   GET    /api/uploads/:id/file           下载 / 预览原文件
 *
 * 安全约定：
 *   - 全部 requireAuth；归属用 session 用户校验，越权 / 不存在统一 404
 *   - 磁盘路径为 data/uploads/<userId>/<随机名>，原始文件名只存数据库（防路径穿越）
 *   - 扩展名白名单（FILE_TYPES）；文件大小默认不限制（UPLOAD_MAX_MB 可兜底）
 *   - 响应带 X-Content-Type-Options: nosniff，非图片强制 attachment 下载
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import multer from 'multer';
import requireAuth from '../middleware/requireAuth.js';
import {
  getConversationForUser,
  addAttachment,
  listAttachmentsForUser,
  getAttachmentForUser,
  deleteAttachmentForUser
} from '../database/db.js';
import {
  FILE_TYPES,
  ALLOWED_EXT_HINT,
  getMaxUploadBytes,
  extOf,
  safeFilename,
  extractText
} from '../services/files.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.join(here, '..', 'data', 'uploads');

const router = Router();
router.use(requireAuth);

/* ------------------------ multer：磁盘流式接收 ------------------------ */

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOAD_ROOT, String(req.session.user.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  // 磁盘文件名只用随机串；展示名（含扩展名）存数据库
  filename(req, file, cb) {
    cb(null, crypto.randomBytes(16).toString('hex'));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: getMaxUploadBytes(), files: 1 },
  fileFilter(req, file, cb) {
    const ext = extOf(file.originalname);
    if (!FILE_TYPES[ext]) {
      const err = new Error('不支持的文件类型，当前支持：' + ALLOWED_EXT_HINT);
      err.code = 'UNSUPPORTED_TYPE';
      cb(err);
      return;
    }
    file.__ext = ext;
    cb(null, true);
  }
});

function singleUpload(req, res) {
  return new Promise(function (resolve, reject) {
    upload.single('file')(req, res, function (err) {
      if (err) reject(err); else resolve();
    });
  });
}

function respondNotFound(res) {
  return res.status(404).json({ success: false, message: '对话不存在' });
}

function respondAttachmentNotFound(res) {
  return res.status(404).json({ success: false, message: '附件不存在' });
}

/** 只对外暴露必要字段 */
function publicAttachment(row) {
  const ext = extOf(row.filename);
  const hasText = row.hasText !== undefined && row.hasText !== null
    ? Boolean(row.hasText)
    : Boolean(row.extracted_text || row.extractedText);
  return {
    id: row.id,
    conversationId: row.conversationId !== undefined ? row.conversationId : row.conversation_id,
    messageId: row.messageId !== undefined ? row.messageId : (row.message_id || null),
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    kind: FILE_TYPES[ext] ? FILE_TYPES[ext].kind : 'text',
    hasText: hasText,
    createdAt: row.createdAt || row.created_at,
    url: '/api/uploads/' + row.id + '/file',
    previewUrl: '/api/uploads/' + row.id + '/preview'
  };
}

/* ------------------------ 上传 ------------------------ */

router.post('/conversations/:id/uploads', async function (req, res) {
  const id = Number(req.params.id);
  const conversation = Number.isInteger(id) && id > 0
    ? getConversationForUser(id, req.session.user.id)
    : null;
  if (!conversation) return respondNotFound(res);

  let file;
  try {
    await singleUpload(req, res);
    file = req.file;
  } catch (err) {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        message: '文件超过大小限制（UPLOAD_MAX_MB=' + process.env.UPLOAD_MAX_MB + 'MB）'
      });
    }
    if (err && err.code === 'UNSUPPORTED_TYPE') {
      return res.status(415).json({ success: false, message: err.message });
    }
    if (err && err.code && String(err.code).indexOf('LIMIT') === 0) {
      return res.status(413).json({ success: false, message: '上传受限：' + err.code });
    }
    console.error('[上传] multipart 解析失败：', err && err.message ? err.message : err);
    return res.status(400).json({ success: false, message: '上传失败，请重试' });
  }

  if (!file) {
    return res.status(400).json({ success: false, message: '未收到文件，表单字段名必须为 file' });
  }

  const ext = file.__ext || extOf(file.originalname);
  const meta = FILE_TYPES[ext] || { mime: 'application/octet-stream', kind: 'text' };

  // 抽取文本失败不影响文件保存：附件仍在，只是不进上下文
  let extracted = null;
  try {
    const buffer = fs.readFileSync(file.path);
    extracted = await extractText(buffer, meta.kind);
  } catch (parseErr) {
    console.error('[上传] 内容抽取失败（文件保留）：', parseErr && parseErr.message ? parseErr.message : parseErr);
    extracted = null;
  }

  const row = addAttachment({
    conversationId: conversation.id,
    userId: req.session.user.id,
    filename: safeFilename(file.originalname),
    mime: meta.mime,
    size: file.size,
    storedName: String(req.session.user.id) + '/' + path.basename(file.path),
    extractedText: extracted
  });

  return res.status(201).json({ success: true, attachment: publicAttachment(row) });
});

/* ------------------------ 列表 ------------------------ */

router.get('/conversations/:id/uploads', function (req, res) {
  const id = Number(req.params.id);
  const conversation = Number.isInteger(id) && id > 0
    ? getConversationForUser(id, req.session.user.id)
    : null;
  if (!conversation) return respondNotFound(res);

  const rows = listAttachmentsForUser(conversation.id, req.session.user.id);
  return res.json({ success: true, attachments: rows.map(publicAttachment) });
});

/* ------------------------ 删除 ------------------------ */

router.delete('/uploads/:id', function (req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return respondAttachmentNotFound(res);

  const row = getAttachmentForUser(id, req.session.user.id);
  if (!row) return respondAttachmentNotFound(res);

  deleteAttachmentForUser(id, req.session.user.id);
  try {
    fs.rmSync(path.join(UPLOAD_ROOT, row.stored_name), { force: true });
  } catch (rmErr) {
    console.error('[上传] 删除磁盘文件失败：', rmErr && rmErr.message);
  }
  return res.json({ success: true, id: id });
});

/* ------------------------ 在线预览（JSON：供前端预览弹窗） ------------------------ */

const PREVIEW_TEXT_CHARS = 3000;

router.get('/uploads/:id/preview', function (req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return respondAttachmentNotFound(res);
  const row = getAttachmentForUser(id, req.session.user.id);
  if (!row) return respondAttachmentNotFound(res);

  const pub = publicAttachment(row);
  const ext = extOf(row.filename);
  const kind = pub.kind;
  // inlineOpen=true 表示前端可以直接 window.open(url) 预览（浏览器原生渲染）
  const inlineOpen = kind === 'image' || kind === 'pdf' || kind === 'text' || ext === 'csv';
  const text = row.extracted_text || '';
  return res.json({
    success: true,
    attachment: Object.assign({}, pub, {
      inlineOpen: inlineOpen,
      previewText: text
        ? (text.length > PREVIEW_TEXT_CHARS ? text.slice(0, PREVIEW_TEXT_CHARS) + '\n…（预览截断，完整内容请下载）' : text)
        : ''
    })
  });
});

/* ------------------------ 下载 / 预览 ------------------------ */

router.get('/uploads/:id/file', function (req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return respondAttachmentNotFound(res);

  const row = getAttachmentForUser(id, req.session.user.id);
  if (!row) return respondAttachmentNotFound(res);

  const filePath = path.join(UPLOAD_ROOT, row.stored_name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, message: '文件不存在' });
  }

  const ext2 = extOf(row.filename);
  const kind2 = FILE_TYPES[ext2] ? FILE_TYPES[ext2].kind : '';
  // 图片 / PDF / 纯文本与代码 / CSV：浏览器内直接预览；Office 二进制仍走下载
  const inline = kind2 === 'image' || kind2 === 'pdf' || kind2 === 'text' || ext2 === 'csv';
  res.setHeader('Content-Type', row.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition',
    (inline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(row.filename) + '"');
  fs.createReadStream(filePath).pipe(res);
  return undefined;
});

export default router;