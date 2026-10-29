const { Pool, types } = require('pg');
const config = require('./config');

// bigint (int8) -> JS number so ids/counts serialise as numbers, not strings.
// Safe: ids and counts here stay far below 2^53.
types.setTypeParser(20, (v) => Number(v));

// Same database as CMS. RPF never runs DDL against it.
const pool = new Pool(config.db);

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

/** Run fn(client) inside one transaction. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
