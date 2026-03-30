const { verifyAccessToken } = require('../utils/token');
const { fail } = require('../utils/response');

const auth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return fail(res, 401, 'Unauthorized');
  }
  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
    return next();
  } catch (err) {
    return fail(res, 401, 'Invalid or expired token');
  }
};

module.exports = { auth };
