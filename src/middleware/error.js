const { fail } = require('../utils/response');

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  console.error(err);
  return fail(res, err.status || 500, err.message || 'Server error');
};

module.exports = { errorHandler };
