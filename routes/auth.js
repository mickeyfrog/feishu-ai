/**
 * 飞书登录路由（routes/auth.js）
 * -------------------------------------------------------------
 * 第三阶段已实现并通过测试的飞书 Web OAuth 授权码登录，第四阶段「原样迁移」到本路由，
 * 唯一新增：登录成功后把用户同步进 SQLite，并把数据库内部 user.id 写入 session。
 *
 *   GET  /auth/feishu           跳转飞书官方授权页
 *   GET  /auth/feishu/callback  接收 code，服务端换取 user_access_token 并拉取用户身份
 *   GET  /api/me                返回当前登录用户（未登录 401）
 *   POST /auth/logout           清除 session
 *
 * 接口依据（2026-09 核对的飞书开放平台官方文档）：
 *   授权页   GET  https://accounts.feishu.cn/open-apis/authen/v1/authorize
 *   换令牌   POST https://accounts.feishu.cn/oauth/v3/token        （v2 已标记历史版本）
 *   用户信息 GET  https://open.feishu.cn/open-apis/authen/v1/user_info
 *
 * 安全约定：
 *   - App Secret 只存在于服务端环境变量，绝不下发前端、绝不写进 public/
 *   - 用户身份一律由后端拿飞书认证结果写入 session，绝不信任浏览器提交的 user_id
 *   - 授权流程带 state 防 CSRF，校验后立即作废
 */

import crypto from 'node:crypto';
import { Router } from 'express';
import { upsertFeishuUser } from '../database/db.js';

/* ========================= 飞书 OAuth 配置 ========================= */

// 飞书官方端点（当前版本，勿改回旧地址）
const FEISHU_ACCOUNTS_ORIGIN = 'https://accounts.feishu.cn';
const FEISHU_OPENAPI_ORIGIN = 'https://open.feishu.cn';
const FEISHU_AUTHORIZE_PATH = '/open-apis/authen/v1/authorize';
const FEISHU_TOKEN_PATH = '/oauth/v3/token';
const FEISHU_USER_INFO_PATH = '/open-apis/authen/v1/user_info';

/** session cookie 名（server.js 的 session 配置与本文件 clearCookie 必须一致） */
export const SESSION_COOKIE_NAME = 'feishu_ai_sid';

/** 读取飞书应用配置（全部来自环境变量，禁止硬编码） */
export function getFeishuConfig() {
  const baseUrl = String(process.env.BASE_URL || '').replace(/\/+$/, '');
  return {
    appId: String(process.env.FEISHU_APP_ID || ''),
    appSecret: String(process.env.FEISHU_APP_SECRET || ''),
    redirectUri: String(process.env.FEISHU_REDIRECT_URI || (baseUrl ? baseUrl + '/auth/feishu/callback' : ''))
  };
}

export function isFeishuConfigured() {
  const cfg = getFeishuConfig();
  return Boolean(cfg.appId && cfg.appSecret && cfg.redirectUri);
}

/** 打码显示 App ID，方便启动时确认配置又不泄露完整凭证 */
export function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return value.slice(0, 2) + '****';
  return value.slice(0, 6) + '****' + value.slice(-4);
}

const router = Router();

/* ========================= 飞书登录 ========================= */

/**
 * GET /auth/feishu
 * 开始飞书登录：生成 state 存入 session，然后 302 到飞书官方授权页。
 */
router.get('/auth/feishu', (req, res) => {
  const cfg = getFeishuConfig();

  if (!cfg.appId || !cfg.appSecret || !cfg.redirectUri) {
    return res.status(503).json({
      success: false,
      message: '飞书登录未配置：请在 .env 中填写 FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_REDIRECT_URI 后重启服务'
    });
  }

  // state 防 CSRF：随机串存 session，回调时比对后立即销毁
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  // 使用 URL 标准库拼接，保证 redirect_uri 等参数编码正确
  const authorizeUrl = new URL(FEISHU_AUTHORIZE_PATH, FEISHU_ACCOUNTS_ORIGIN);
  authorizeUrl.searchParams.set('client_id', cfg.appId);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', cfg.redirectUri);
  authorizeUrl.searchParams.set('state', state);

  // 先落盘 session（写入 state 与 cookie），再跳转
  req.session.save((err) => {
    if (err) {
      console.error('[飞书登录] 保存 session 失败：', err);
      return res.status(500).json({ success: false, message: '服务器内部错误' });
    }
    return res.redirect(authorizeUrl.toString());
  });
});

/**
 * GET /auth/feishu/callback
 * 飞书授权后回调：
 *   1. 处理用户拒绝授权（error=access_denied）
 *   2. 校验 state（防 CSRF）
 *   3. 服务端用 code 换 user_access_token（v3 令牌端点）
 *   4. 用 user_access_token 拉取用户身份（open_id 等）
 *   5. 同步进 SQLite（users 表），把内部 user.id 写入 session，再回首页
 */
router.get('/auth/feishu/callback', async (req, res) => {
  const backHome = (query) => res.redirect('/' + (query || ''));

  try {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const error = typeof req.query.error === 'string' ? req.query.error : '';

    // 用户在授权页点了拒绝
    if (error) {
      console.warn('[飞书登录] 用户拒绝授权或授权页返回错误：', error);
      return backHome('?login=denied');
    }

    if (!code) {
      console.warn('[飞书登录] 回调缺少 code 参数');
      return backHome('?login=error');
    }

    // 校验 state：必须与发起授权时存入 session 的一致
    const expectedState = req.session.oauthState;
    delete req.session.oauthState; // 一次性使用
    if (!expectedState || expectedState !== state) {
      console.warn('[飞书登录] state 校验失败（可能为 CSRF 或会话过期），已拒绝本次登录');
      return backHome('?login=error');
    }

    const cfg = getFeishuConfig();
    if (!cfg.appId || !cfg.appSecret) {
      console.error('[飞书登录] 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET 配置');
      return backHome('?login=error');
    }

    // 1）code 换 user_access_token（官方 v3 令牌端点，form-urlencoded）
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      code,
      redirect_uri: cfg.redirectUri
    });

    const tokenRes = await fetch(FEISHU_ACCOUNTS_ORIGIN + FEISHU_TOKEN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString()
    });
    const tokenJson = await tokenRes.json().catch(() => null);

    if (!tokenRes.ok || !tokenJson || tokenJson.code !== 0 || !tokenJson.access_token) {
      console.error('[飞书登录] 换取 user_access_token 失败：', tokenRes.status, tokenJson && (tokenJson.error_description || tokenJson.error || tokenJson.code));
      return backHome('?login=error');
    }

    // 2）拿用户身份（身份只信飞书返回，不信浏览器）
    const userRes = await fetch(FEISHU_OPENAPI_ORIGIN + FEISHU_USER_INFO_PATH, {
      headers: { Authorization: 'Bearer ' + tokenJson.access_token }
    });
    const userJson = await userRes.json().catch(() => null);
    const info = userJson && userJson.data ? userJson.data : null;

    if (!userRes.ok || !userJson || userJson.code !== 0 || !info || !info.open_id) {
      console.error('[飞书登录] 获取用户信息失败：', userRes.status, userJson && (userJson.msg || userJson.code));
      return backHome('?login=error');
    }

    // 3）同步到 SQLite：以飞书稳定唯一 ID（open_id）为唯一身份，不用姓名做标识
    //    不存在则 INSERT；存在则更新 name / avatar / updated_at
    const name = info.name || info.en_name || '飞书用户';
    const avatar = info.avatar_url || info.avatar_middle || '';

    let dbUser;
    try {
      dbUser = upsertFeishuUser({ feishuUserId: info.open_id, name, avatar });
    } catch (dbErr) {
      console.error('[飞书登录] 写入 users 表失败：', dbErr);
      return backHome('?login=error');
    }

    if (!dbUser || !dbUser.id) {
      console.error('[飞书登录] 同步用户后未取到数据库主键');
      return backHome('?login=error');
    }

    // 4）写入 session（只存业务需要的最小字段；token 不落 session，避免膨胀与泄露面）
    //    之后所有数据库操作都使用 req.session.user.id，绝不接受前端提交的 user_id
    req.session.user = {
      id: dbUser.id,                       // 数据库内部主键（后续所有查询的归属依据）
      feishuUserId: info.open_id,          // 应用内唯一且稳定，作为主标识
      unionId: info.union_id || '',
      tenantKey: info.tenant_key || '',
      name: dbUser.name || name,
      avatar: dbUser.avatar || avatar,
      loginAt: Date.now()
    };

    req.session.save((err) => {
      if (err) {
        console.error('[飞书登录] 保存登录态失败：', err);
        return backHome('?login=error');
      }
      return backHome('');
    });
  } catch (err) {
    console.error('[飞书登录] 回调处理异常：', err);
    return backHome('?login=error');
  }
});

/**
 * GET /api/me
 * 未登录：401 { loggedIn: false }
 * 已登录：{ loggedIn: true, user: { name, avatar, feishuUserId } }
 * 注意：绝不返回 App Secret、token、内部主键等敏感/无关信息。
 */
router.get('/api/me', (req, res) => {
  const user = req.session && req.session.user;
  if (!user || !user.feishuUserId) {
    return res.status(401).json({ loggedIn: false });
  }
  return res.json({
    loggedIn: true,
    user: {
      name: user.name,
      avatar: user.avatar,
      feishuUserId: user.feishuUserId
    }
  });
});

/**
 * POST /auth/logout
 * 销毁当前会话并清除 Cookie。
 */
router.post('/auth/logout', (req, res) => {
  const done = () => {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.json({ success: true });
  };

  if (req.session) {
    req.session.destroy((err) => {
      if (err) console.error('[登出] 销毁 session 出错：', err);
      done();
    });
  } else {
    done();
  }
});

export default router;