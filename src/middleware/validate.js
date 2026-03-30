const { fail } = require('../utils/response');

const validate = (schema) => (req, res, next) => {
  try {
    const parsed = schema.parse({
      body: req.body,
      params: req.params,
      query: req.query
    });
    req.validated = parsed;
    return next();
  } catch (err) {
    const errors = err.errors ? err.errors.map((e) => ({ path: e.path, message: e.message })) : undefined;
    return fail(res, 400, 'Validation error', errors);
  }
};

module.exports = { validate };
