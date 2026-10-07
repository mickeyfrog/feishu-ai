/**
 * 本地账号认证路由：routes/auth.js
 * -------------------------------------------------------------
 * 2026-09-24 起替代飞书 OAuth：
 *   POST /auth/register  注册（用户名 + 密码，scrypt 加盐哈希存储）
 *   POST /auth/login     登录（session 写入服务端确认的用户）
 *   POST /auth/logout    登出（销毁 session）
 *   GET  /api/me         当前登录用户（未登录 401）
 *
 * 安全约定：
 *   - 密码用 node:crypto 的 scrypt 加盐哈希（N=16384），绝不存明文、绝不回传
 *   - 登录失败次数按 IP 限流（10 次锁定 10 分钟）；注册按 IP 限流（每小时 10 个）
 *   - 用户身份一律由服务端 session 决定，绝不信任浏览器提交的 user_id
 */

import crypto from 'node:crypto';
import { Router } from 'express';
import { getUserByUsername, createLocalUser } from '../database/db.js';

const router = Router();

export const SESSION_COOKIE_NAME = 'feishu_ai_sid';

const USERNAME_RE = /^[\w\u4e00-\u9fa5-]{2,32}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;
const SCRYPT_N = 16384;

/* ----------------------------- 密码哈希 ----------------------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64, { N: SCRYPT_N }).toString('hex');
  return 'scrypt:' + SCRYPT_N + ':' + salt + ':' + hash;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const salt = parts[2];
  const expect = Buffer.from(parts[3], 'hex');
  const actual = crypto.scryptSync(String(password), salt, expect.length, { N: n });
  return crypto.timingSafeEqual(actual, expect);
}

/* ----------------------------- 简单限流（内存版，重启清零） ----------------------------- */

const loginFails = new Map();   // ip -> { count, lockedUntil }
const registerHits = new Map(); // ip -> number[]（时间戳）

function clientIp(req) {
  return String(req.ip || 'unknown');
}

function loginLocked(req) {
  const rec = loginFails.get(clientIp(req));
  return Boolean(rec && rec.lockedUntil && rec.lockedUntil > Date.now());
}
function noteLoginFail(req) {
  const ip = clientIp(req);
  const rec = loginFails.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= 10) { rec.lockedUntil = Date.now() + 10 * 60 * 1000; rec.count = 0; }
  loginFails.set(ip, rec);
}
function clearLoginFail(req) { loginFails.delete(clientIp(req)); }

function registerAllowed(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const list = (registerHits.get(ip) || []).filter(function (t) { return now - t < 3600000; });
  if (list.length >= 10) { registerHits.set(ip, list); return false; }
  list.push(now);
  registerHits.set(ip, list);
  return true;
}

/* ----------------------------- 小工具 ----------------------------- */

function publicUser(user) {
  return { name: user.name, avatar: user.avatar || '', userId: user.username || '' };
}

function attachSession(req, user) {
  req.session.user = {
    id: user.id,
    feishuUserId: user.feishu_user_id, // 兼容旧字段（本地账号为 local:<username>）
    username: user.username || '',     // 干净的登录名（展示用）
    name: user.name,
    avatar: user.avatar || ''
  };
}

function readCredentials(req, res) {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!USERNAME_RE.test(username)) {
    res.status(400).json({ success: false, message: '用户名需为 2~32 位字母/数字/中文/下划线' });
    return null;
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    res.status(400).json({ success: false, message: '密码长度需为 ' + PASSWORD_MIN + '~' + PASSWORD_MAX + ' 位' });
    return null;
  }
  return { username: username, password: password };
}

/* ----------------------------- 路由 ----------------------------- */

/** 注册 */
router.post('/auth/register', (req, res) => {
  if (!registerAllowed(req)) {
    return res.status(429).json({ success: false, message: '注册过于频繁，请一小时后再试' });
  }
  const cred = readCredentials(req, res);
  if (!cred) return undefined;
  if (getUserByUsername(cred.username)) {
    return res.status(409).json({ success: false, message: '该用户名已被注册' });
  }
  let user;
  try {
    user = createLocalUser(cred.username, hashPassword(cred.password));
  } catch (err) {
    if (String(err && err.message).indexOf('UNIQUE') > -1) {
      return res.status(409).json({ success: false, message: '该用户名已被注册' });
    }
    throw err;
  }
  attachSession(req, user);
  console.log('[注册] 新用户：' + cred.username);
  return res.status(201).json({ success: true, user: publicUser(user) });
});

/** 登录 */
router.post('/auth/login', (req, res) => {
  if (loginLocked(req)) {
    return res.status(429).json({ success: false, message: '失败次数过多，请 10 分钟后再试' });
  }
  const cred = readCredentials(req, res);
  if (!cred) return undefined;
  const user = getUserByUsername(cred.username);
  if (!user || !verifyPassword(cred.password, user.password_hash)) {
    noteLoginFail(req);
    return res.status(401).json({ success: false, message: '用户名或密码错误' });
  }
  clearLoginFail(req);
  attachSession(req, user);
  return res.json({ success: true, user: publicUser(user) });
});

/** 当前用户 */
router.get('/api/me', (req, res) => {
  const user = req.session && req.session.user;
  if (!user || !user.id) {
    return res.status(401).json({ loggedIn: false });
  }
  return res.json({
    loggedIn: true,
    user: { name: user.name, avatar: user.avatar, userId: user.username || user.feishuUserId }
  });
});

/** 登出 */
router.post('/auth/logout', (req, res) => {
  const done = function () {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.json({ success: true });
  };
  if (req.session) {
    req.session.destroy(function (err) {
      if (err) console.error('[登出] 销毁 session 出错：', err);
      done();
    });
  } else {
    done();
  }
});

export default router;
