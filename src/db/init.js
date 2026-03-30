const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool, query } = require('./index');
const { env } = require('../config/env');

const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');

const run = async () => {
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await query(sql);

  if (env.adminEmail && env.adminPassword) {
    const existing = await query('SELECT id FROM users WHERE email = $1', [env.adminEmail]);
    if (existing.rowCount === 0) {
      const hash = await bcrypt.hash(env.adminPassword, env.bcryptSaltRounds);
      await query(
        'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)',
        [env.adminEmail, hash, 'admin']
      );
      console.log('Admin user created');
    } else {
      console.log('Admin user already exists');
    }
  } else {
    console.log('ADMIN_EMAIL/ADMIN_PASSWORD not set; skipping admin bootstrap');
  }
};

run()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
