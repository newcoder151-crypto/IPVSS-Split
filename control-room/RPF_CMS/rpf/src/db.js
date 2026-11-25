const { Pool, types } = require('pg');
const config = require('./config');

// bigint (int8) -> JS number so ids/counts serialise as numbers, not strings.
// Safe: ids and counts here stay far below 2^53.
types.setTypeParser(20, (v) => Number(v));

/**
 * Same database as CMS. RPF never runs DDL against it.
 *
 * DB_HOST may list several CMS databases separated by commas ("10.1.1.10,10.2.2.20"): every CMS of a cluster holds all the data, so if
 * the one this post is using stops answering, RPF switches to the next one (and keeps working; what it writes is shared by the cluster).
 */
const hosts = String(config.db.host || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!hosts.length) hosts.push(undefined);
let idx = 0;
const make = (h) => {
  const p = new Pool({ ...config.db, host: h, ...(hosts.length > 1 ? { connectionTimeoutMillis: 4000 } : {}) });
  p.on('error', (err) => console.error(`Unexpected error on idle Postgres client (${h || 'default host'})`, err.message));
  return p;
};
let pool = make(hosts[idx]);

const CONNECT_FAIL = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', '57P03']);
const isConnectFail = (e) => !!e && (CONNECT_FAIL.has(e.code) || /timeout exceeded when trying to connect|Connection terminated unexpectedly/i.test(e.message || ''));
function switchHost(err) {
  if (hosts.length < 2) return false;
  const old = pool;
  idx = (idx + 1) % hosts.length;
  pool = make(hosts[idx]);
  old.end().catch(() => {});
  console.warn(`[db] ${hosts[(idx + hosts.length - 1) % hosts.length]} did not answer (${err.code || err.message}); now using ${hosts[idx]}`);
  return true;
}
// what the rest of the code uses: query / connect / end / on - the same as a Pool, with the fail-over inside
const wrapper = {
  async query(...a) { try { return await pool.query(...a); } catch (e) { if (isConnectFail(e) && switchHost(e)) return pool.query(...a); throw e; } },
  async connect() { try { return await pool.connect(); } catch (e) { if (isConnectFail(e) && switchHost(e)) return pool.connect(); throw e; } },
  end() { return pool.end(); },
  on(ev, fn) { return pool.on(ev, fn); },
  get currentHost() { return hosts[idx]; },
};

/** Run fn(client) inside one transaction. */
async function withTransaction(fn) {
  const client = await wrapper.connect();
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

module.exports = { pool: wrapper, withTransaction };
