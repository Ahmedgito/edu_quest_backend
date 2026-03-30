const { Pool } = require('pg');
const { env } = require('../config/env');

if (!env.databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: env.databaseUrl
});

const query = (text, params) => pool.query(text, params);

module.exports = { pool, query };
