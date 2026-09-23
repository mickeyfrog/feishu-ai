/**
 * AI 生图路由：routes/images.js
 * -------------------------------------------------------------
 *   POST /api/images/generate   依据提示词生成图片（浏览器自动化，唯一模式）
 *   GET  /api/images            我的生图历史（最近 60 条）
 *   GET  /api/images/:id/file   查看 / 下载生成的图片
 *
 * 约定：
 *   - 生图只走「浏览器自动化」：services/image-browser.js 驱动本机已登录
 *     ChatGPT 的调试 Chrome 出图（API 生图模式已于 2026-09-20 移除）
 *   - 停用方式：.env 设 AI_IMAGE_MODEL=off（isImageGenerationEnabled 返回 false）
 *   - 失败绝不重试、绝不做任何隐式回退；错误经 describeBrowserImageError
 *     翻译成可操作的中文提示；绝不回传 Key 或 .env 内容
 *   - 浏览器未连接（BrowserNotConnectedError）返回 503（环境未就绪），
 *     其余生成失败返回 502
 *   - 生成结果落盘 data/generated/<随机名>.<ext>，并记入 generated_images 表
 *   - 魔数识别不出格式时，可信回退 Provider 附带的 MIME（仅限已知图片类型）
 *   - 归属校验：只能看 / 下载自己生成的图；越权统一 404
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import {
  addGeneratedImage,
  listGeneratedImages,
  getGeneratedImageForUser
} from '../database/db.js';
import { sniffImageMime } from '../services/files.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GEN_ROOT = path.join(here, '..', 'data', 'generated');

const router = Router();
router.use(requireAuth);

const PROMPT_MAX_LENGTH = 2000;
const GEN_ERROR_TEXT = '图片生成失败，请重试。';

router.post('/images/generate', async function (req, res) {
  const body = req.body || {};
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return res.status(400).json({ success: false, message: '请先描述你想生成的图片' });
  }
  if (prompt.length > PROMPT_MAX_LENGTH) {
    return res.status(400).json({
      success: false,
      message: '提示词过长（最多 ' + PROMPT_MAX_LENGTH + ' 字符）'
    });
  }

  // 懒加载：只在真正生图时才引入 playwright-core 相关模块
  const browserSvc = await import('../services/image-browser.js');

  if (!browserSvc.isImageGenerationEnabled()) {
    return res.status(503).json({
      success: false,
      message: '生图功能已停用：.env 中 AI_IMAGE_MODEL=off；删除该行并重启即可启用（浏览器生图模式）'
    });
  }
  const model = browserSvc.getImageModelLabel();

  let buffer = null;
  let hintedMime = '';
  try {
    const generated = await browserSvc.generateImageViaBrowser({ prompt: prompt });
    buffer = generated && generated.buffer;
    hintedMime = generated && generated.mimeType ? generated.mimeType : '';

    if (!buffer || !buffer.length) {
      return res.status(502).json({ success: false, message: GEN_ERROR_TEXT });
    }
  } catch (err) {
    console.error('[生图] 调用失败：', err && err.message ? err.message : err);
    // 浏览器未连接 = 环境未就绪，用 503 与「生成失败（502）」区分开，便于监控与前端提示
    const status = err && err.name === 'BrowserNotConnectedError' ? 503 : 502;
    return res.status(status).json({ success: false, message: browserSvc.describeBrowserImageError(err) });
  }

  const sniff = sniffImageMime(buffer);
  let mime = sniff.mime;
  let ext = sniff.ext;
  // 极少数情况魔数识别不出格式：信任 Provider 附带的 MIME（仅限已知图片类型）
  if (mime === 'application/octet-stream' && /^image\/(png|jpe?g|webp|gif)$/i.test(hintedMime)) {
    mime = hintedMime.toLowerCase();
    ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  }
  fs.mkdirSync(GEN_ROOT, { recursive: true });
  const storedName = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(GEN_ROOT, storedName), buffer);

  const created = addGeneratedImage({
    userId: req.session.user.id,
    prompt: prompt,
    storedName: storedName,
    mime: mime,
    model: model
  });

  return res.json({
    success: true,
    image: {
      id: created.id,
      prompt: prompt,
      model: model,
      mime: mime,
      url: '/api/images/' + created.id + '/file'
    }
  });
});

router.get('/images', function (req, res) {
  const rows = listGeneratedImages(req.session.user.id);
  return res.json({
    success: true,
    images: rows.map(function (row) {
      return {
        id: row.id,
        prompt: row.prompt,
        model: row.model,
        mime: row.mime,
        createdAt: row.createdAt,
        url: '/api/images/' + row.id + '/file'
      };
    })
  });
});

router.get('/images/:id/file', function (req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ success: false, message: '图片不存在' });
  }
  const row = getGeneratedImageForUser(id, req.session.user.id);
  if (!row) {
    return res.status(404).json({ success: false, message: '图片不存在' });
  }
  const filePath = path.join(GEN_ROOT, row.stored_name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, message: '图片不存在' });
  }
  res.setHeader('Content-Type', row.mime || 'image/png');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent('generated-' + row.id + '.' + sniffImageMime(fs.readFileSync(filePath)).ext + '"'));
  fs.createReadStream(filePath).pipe(res);
  return undefined;
});

export default router;
