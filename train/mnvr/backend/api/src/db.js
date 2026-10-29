require('dotenv').config();
const { Pool } = require('pg');
const { DB_PASSWORD } = require('./config/security');

// OWASP A02 / A05: no hardcoded credential fallback for the database — the
// only "default" is an explicit, logged, dev-only empty password (see
// config/security.js). Production requires DB_PASSWORD to be set.
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'mnvr',
  user: process.env.DB_USER || 'mnvr',
  password: DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // Enforce TLS to the database in production (A02: Cryptographic Failures —
  // credentials and video-surveillance metadata should not cross the wire
  // in plaintext). Set DB_SSL=true and provide a CA if your Postgres
  // deployment terminates TLS.
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
});

pool.on('error', (err) => console.error('[DB] Pool error:', err.message));

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    // OWASP A09: log full detail server-side only. Route handlers must not
    // forward err.message (which can include table/column names or SQL
    // fragments) back to the HTTP client.
    console.error('[DB] Query error:', err.message, '\nSQL:', text.slice(0, 200));
    throw err;
  }
}

async function queryOne(text, params) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

// Used where a single logical operation touches more than one table (e.g.
// creating a camera also has to upsert its cameras_config_details row) and
// both writes must succeed or fail together — otherwise a mid-way failure
// leaves the two tables out of sync, which is exactly the kind of drift
// that made cameras need manual DB edits in two places before.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function testConnection() {
  try {
    const r = await query('SELECT current_database(), version()');
    console.log(`[DB] Connected to: ${r.rows[0].current_database}`);
    return true;
  } catch (e) {
    console.error('[DB] Connection failed:', e.message);
    return false;
  }
}

module.exports = { pool, query, queryOne, withTransaction, testConnection };
