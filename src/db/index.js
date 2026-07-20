const { Pool } = require('pg');
const { env } = require('../config/env');

if (!env.databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: env.databaseUrl
});

const query = (text, params) => pool.query(text, params);

const getClient = () => pool.connect();

/**
 * Run `fn` inside a single transaction. Commits on success, rolls back on any
 * error, and always releases the client back to the pool. `fn` receives the
 * transactional client and must use it (not the pooled `query`) for its work.
 */
const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Surface the original error; log the rollback failure for diagnostics.
      console.error('Transaction rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { pool, query, getClient, withTransaction };
