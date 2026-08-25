const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  // 前端发请求时，会在HTTP headers（请求的"信封资讯"，不是body本体）里带上token，
  // 格式通常是 Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登入' });
  }

  const token = authHeader.split(' ')[1];
  // 把字串用空格切开，变成["Bearer", "eyJhbGc..."]，取第二个
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // 跟登入时jwt.sign(...)相反——这是验证token是不是用你的JWT_SECRET签发的、有没有过期。
    // 如果验证成功，会解密回原本包进去的payload（也就是{ userId, email }）；
    // 如果token是伪造的、被窜改过、或过期了，这行会直接丢出错误，被下面的catch接住。
    req.userId = decoded.userId;
    // 把解密出来的userId，"塞"进req这个物件里，变成req.userId。
    // 因为req会一路传递给后面真正处理这个请求的route function，
    // 这样后面的route就能读到"这个请求是哪个使用者发的"
    next();
    // 这是middleware特有的东西——呼叫next()代表"这一关检查通过了，请继续往下执行原本的route逻辑"
    // 验证失败时），请求就会停在这里，不会执行到真正的route function。
  } catch (error) {
    return res.status(401).json({ error: 'Token无效或已过期，请重新登入' });
  }
}

module.exports = requireAuth;