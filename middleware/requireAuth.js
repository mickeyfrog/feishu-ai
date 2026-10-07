/**
 * 登录校验中间件
 * 所有聊天相关 API 必须先经过这里；身份只认服务端 session，绝不信任浏览器提交的用户 ID。
 * 2026-09-24 起：飞书 OAuth 已下线，改为本地注册账号 + session。
 */
export default function requireAuth(req, res, next) {
  const user = req.session && req.session.user;
  if (!user || !user.id) {
    return res.status(401).json({
      success: false,
      message: '请先登录'
    });
  }
  return next();
}
