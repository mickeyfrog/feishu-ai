/**
 * 组内 AI（feishu-ai）后端服务 - 第四阶段
 * -------------------------------------------------------------
 * 阶段回顾：
 *   二：Express + ChatGPT 风格前端（本地 localhost:3000）
 *   三：飞书 Web OAuth 用户身份登录（express-session）
 *   四（本阶段）：SQLite 按用户隔离的会话/消息 + OpenAI Responses API 真实流式对话 + Markdown
 *
 * 路由划分：
 *   routes/auth.js           GET /auth/feishu、GET /auth/feishu/callback、GET /api/me、POST /auth/logout
 *   routes/conversations.js  GET/POST /api/conversations、PATCH/DELETE /api/conversations/:id、GET /api/conversations/:id/messages
 *   routes/chat.js           POST /api/conversations/:id/chat、POST /api/conversations/:id/chat/stream（SSE）
 *
 * 安全约定（不可动摇）：
 *   - FEISHU_APP_SECRET / OPENAI_API_KEY 只存在于服务端环境变量，绝不下发前端、绝不进 public/、绝不硬编码
 *   - 用户身份与数据归属一律由服务端 session 决定，绝不信任浏览器提交的 user_id
 *   - 不属于当前用户的会话统一 404，不泄露归属信息
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import session from 'express-session';
import 'dotenv/config'; // 自动读取项目根目录下的 .env（没有该文件也不会报错）

import { DB_FILE, db } from './database/db.js';
import authRouter, {
  SESSION_COOKIE_NAME,
  getFeishuConfig,
  isFeishuConfigured,
  maskSecret
} from './routes/auth.js';
import conversationsRouter from './routes/conversations.js';
import chatRouter from './routes/chat.js';
import uploadsRouter from './routes/uploads.js';
import imagesRouter from './routes/images.js';
import { isOpenAIConfigured, getAIConfig, MAX_CONTEXT_MESSAGES } from './services/openai.js';

// ES Module 中没有 __dirname，需要手动推导
const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

const app = express();

// 端口：优先读取环境变量 PORT，否则使用 3000
const PORT = Number(process.env.PORT) || 3000;

/* ========================= 中间件 ========================= */

// 隐藏 Express 标识，减少无意义的信息暴露
app.disable('x-powered-by');

// 运行在 Cloudflare Tunnel / HTTPS 反向代理后面：
// 信任一跳代理，使 req.protocol / req.secure 能正确识别为 https
app.set('trust proxy', 1);

// 解析 JSON 请求体，并限制体积，避免恶意超大请求
app.use(express.json({ limit: '1mb' }));

// Session：
// - 使用内存存储（组内少量用户足够；重启后需要重新登录飞书）
// - Cookie：httpOnly 防 JS 读取；secure 只走 HTTPS；sameSite=lax 兼顾跳转与防 CSRF
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('[提示] 未设置 SESSION_SECRET，本次启动使用随机密钥（重启后所有登录态失效）。生产环境请在 .env 中固定配置。');
}

/**
 * Secure Cookie 开关：
 *   - COOKIE_SECURE=true / false 可显式强制指定；
 *   - 未显式指定时：对外地址（BASE_URL 或 FEISHU_REDIRECT_URI）为 https 则开启，
 *     否则关闭（方便本地纯 HTTP 调试）。
 * 说明：express-session 在 secure=true 时，只有当请求被识别为 HTTPS 才会下发 Cookie；
 * 本服务已 app.set('trust proxy', 1)，Cloudflare Tunnel 会携带 X-Forwarded-Proto: https，
 * 因此线上（https://ai.wzyiloveu.kdns.fr）可以正常登录。
 */
function resolveCookieSecure() {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  const baseUrl = String(process.env.BASE_URL || '');
  const redirectUri = String(process.env.FEISHU_REDIRECT_URI || '');
  return baseUrl.indexOf('https://') === 0 || redirectUri.indexOf('https://') === 0;
}

const COOKIE_SECURE = resolveCookieSecure();

app.use(
  session({
    name: SESSION_COOKIE_NAME,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 天
    }
  })
);

// 静态资源目录：public/
// 缓存策略：HTML/JS/CSS 用 no-cache（每次带 etag 校验，发版即时生效，避免 Cloudflare/浏览器旧缓存）；
// 其余二进制静态资源缓存 1 天。
app.use(express.static(path.join(currentDir, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

/**
 * 前端第三方库（Markdown 渲染 + XSS 清理）：
 * 直接从 node_modules 提供，避免把库文件复制进 public/ 造成两份不同步。
 *   marked    -> /vendor/marked.umd.js     （window.marked）
 *   DOMPurify -> /vendor/purify.min.js    （window.DOMPurify）
 */
const VENDOR_FILES = {
  '/vendor/marked.umd.js': path.join(currentDir, 'node_modules', 'marked', 'lib', 'marked.umd.js'),
  '/vendor/purify.min.js': path.join(currentDir, 'node_modules', 'dompurify', 'dist', 'purify.min.js')
};

Object.keys(VENDOR_FILES).forEach((urlPath) => {
  const filePath = VENDOR_FILES[urlPath];
  app.get(urlPath, (req, res) => {
    if (!fs.existsSync(filePath)) {
      return res.status(404).type('text/plain; charset=utf-8').send('vendor file missing');
    }
    return res.sendFile(filePath, { maxAge: '1d' });
  });
});

// 统一给接口响应加上 no-store，避免开发阶段浏览器缓存旧数据
// （流式接口会在自己的路由里覆盖为 no-cache, no-transform）
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/**
 * 浏览器会自动请求 /favicon.ico。
 * 页面 head 里已经使用了内联 SVG 图标，这里直接返回 204，避免控制台出现 404。
 */
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

/* ========================= 基础接口 ========================= */

/**
 * GET /api/test
 * 健康检查：确认后端、数据库与 AI 配置状态（不泄露任何密钥）
 */
app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: '飞书 AI 后端运行正常',
    feishuLogin: isFeishuConfigured(),
    aiReady: isOpenAIConfigured()
  });
});

/* ========================= 业务路由 ========================= */

// 飞书登录（第三阶段实现，已迁移到 routes/auth.js，逻辑保持不变）
app.use(authRouter);

// 会话与消息（均要求登录；数据按 session 中的用户隔离）
app.use('/api/conversations', conversationsRouter);
app.use('/api/conversations', chatRouter);

// 文件附件与 AI 生图（均要求登录；归属由 session 校验）
app.use('/api', uploadsRouter);
app.use('/api', imagesRouter);

/* ------------------------- 兜底与错误处理 ------------------------- */

// 未知接口统一返回 404 JSON（放在所有 /api 路由之后）
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    message: '接口不存在：' + req.method + ' ' + req.originalUrl
  });
});

// 其余未匹配路径：返回 404（首页由静态中间件处理，不会走到这里）
app.use((req, res) => {
  res.status(404).type('text/plain; charset=utf-8').send('404 Not Found');
});

// 全局错误处理：例如 JSON 格式错误、服务内部异常
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // 请求体不是合法 JSON
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({
      success: false,
      message: '请求格式错误，请发送合法的 JSON'
    });
  }

  console.error('[服务器错误]', err);
  return res.status(500).json({
    success: false,
    message: '服务器内部错误'
  });
});

/* ----------------------------- 启动 ----------------------------- */

// 仅当直接运行本文件时才监听端口；被测试脚本 import 时只导出 app
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const server = app.listen(PORT, () => {
    const cfg = getFeishuConfig();
    console.log('组内 AI（feishu-ai）服务已启动 - 第四阶段');
    console.log('访问地址：http://localhost:' + PORT);
    console.log('接口自检：http://localhost:' + PORT + '/api/test');

    if (isFeishuConfigured()) {
      console.log('飞书登录：已配置（App ID ' + maskSecret(cfg.appId) + '，回调 ' + cfg.redirectUri + '）');
    } else {
      console.log('飞书登录：未配置（请在 .env 填写 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_REDIRECT_URI）');
    }

    if (isOpenAIConfigured()) {
      const ai = getAIConfig();
      console.log('AI 接口：已配置（模型 ' + ai.model + '，模式 ' + ai.mode + '，地址 ' + ai.baseURL + '，上下文最近 ' + MAX_CONTEXT_MESSAGES + ' 条消息）');
    } else {
      console.log('AI 接口：未配置（请在 .env 填写 AI_API_KEY / AI_MODEL，或旧变量 OPENAI_API_KEY / OPENAI_MODEL；未配置时聊天接口返回「服务器尚未配置 AI API」）');
    }

    console.log('数据库：SQLite ' + DB_FILE);
    console.log('Session Cookie：secure=' + COOKIE_SECURE + '，httpOnly=true，sameSite=lax（trust proxy 已开启）');
  });

  // 端口被占用等情况，给出可读提示而不是抛出一大堆堆栈
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('启动失败：端口 ' + PORT + ' 已被占用。');
      console.error('解决办法：关闭占用该端口的程序，或在 .env 中修改 PORT 后重新启动。');
      process.exit(1);
    }
    console.error('启动失败：', err);
    process.exit(1);
  });

  // Ctrl + C 优雅退出
  process.on('SIGINT', () => {
    console.log('\n正在关闭组内 AI 服务...');
    server.close(() => {
      try {
        db.close();
      } catch (closeErr) {
        console.error('[关闭] 数据库关闭出错：', closeErr);
      }
      process.exit(0);
    });
  });
}

export { app };