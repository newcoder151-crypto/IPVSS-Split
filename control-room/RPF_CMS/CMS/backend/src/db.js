const { Pool, types } = require('pg');
const config = require('./config');

// bigint -> number (ids and counts stay far below 2^53)
types.setTypeParser(20, (v) => Number(v));

const pool = new Pool(config.db);
pool.on('error', (err) => console.error('Unexpected error on idle Postgres client', err));

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
