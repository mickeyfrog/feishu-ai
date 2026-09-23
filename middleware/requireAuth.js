/**
 * 登录校验中间件
 * 所有聊天相关 API 必须先经过这里；身份只认服务端 session，绝不信任浏览器提交的用户 ID。
 */
export default function requireAuth(req, res, next) {
  const user = req.session && req.session.user;
  if (!user || !user.id) {
    return res.status(401).json({
      success: false,
      message: '请先登录飞书'
    });
  }
  return next();
}
