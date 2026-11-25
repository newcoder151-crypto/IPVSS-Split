'use strict';
/**
 * Several CMS that work together (N+1 redundancy, several locations).
 *
 *   identity     every CMS has a node number (its id range), a node uuid and a name / location / URL - see sql/migrations/011_cluster.sql
 *   registry     cms_node is replicated, so every CMS knows all the others; a CMS writes only its OWN row
 *   heartbeat    every 10 s a CMS stamps its row (last_seen + a few numbers); every 10 s it also asks each other CMS "are you there?"
 *   ownership    cms_owns() in the database decides which CMS does which background work (and who takes over when one is down)
 *   video        footage of one CMS is served to the consoles of all the others through that CMS (fetchFromNode), and archived
 *                evidence is mirrored (jobs.js: evidence_mirror)
 *   requests     CMS to CMS calls are signed with a shared secret (CMS_CLUSTER_SECRET) - nobody else can fetch video or join
 *
 * A CMS that has not been put in a cluster (no row in cms_cluster_config) behaves exactly as before.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pool } = require('../db');
const config = require('../config');

const ID_SPACE = 1000000000;
const ALIVE_SECONDS = 45;
const startedAt = new Date();

// ------------------------------------------------------------------------------------------------------------------
// who am I
// ------------------------------------------------------------------------------------------------------------------
let cached = { at: 0, row: null };
async function self({ fresh = false } = {}) {
  if (!fresh && Date.now() - cached.at < 5000) return cached.row;
  let row = null;
  try { row = (await pool.query(`SELECT c.cluster_id, c.node_uuid, c.node_no, n.name, n.location, n.url, n.role FROM cms_cluster_config c LEFT JOIN cms_node n ON n.node_uuid = c.node_uuid WHERE c.id = 1`)).rows[0] || null; } catch (_) { row = null; }
  cached = { at: Date.now(), row };
  return row;
}
const isClustered = async () => !!(await self());
/** The CMS that made a row, from its id. Ids below 2e9 belong to the first CMS (the one that existed before the cluster). */
const nodeOfId = (id) => Math.max(1, Math.floor(Number(id) / ID_SPACE));

// ------------------------------------------------------------------------------------------------------------------
// the shared secret + signed CMS-to-CMS requests
// ------------------------------------------------------------------------------------------------------------------
function secret() {
  const env = String(process.env.CMS_CLUSTER_SECRET || '').trim();
  if (env.length >= 16) return env;
  const file = path.resolve(process.env.CLUSTER_SECRET_FILE || path.join(__dirname, '..', '..', '..', 'data', 'cluster-secret'));
  try { const s = fs.readFileSync(file, 'utf8').trim(); if (s.length >= 16) return s; } catch (_) { /* none yet */ }
  return null;
}
/** Create the secret (first CMS of a cluster) and keep it in data/cluster-secret. The other CMS get the same value in CMS_CLUSTER_SECRET. */
function ensureSecret() {
  const have = secret();
  if (have) return have;
  const file = path.resolve(process.env.CLUSTER_SECRET_FILE || path.join(__dirname, '..', '..', '..', 'data', 'cluster-secret'));
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s + '\n', { mode: 0o600 });
  return s;
}
const sig = (key, node, ts, method, p) => crypto.createHmac('sha256', key).update(`${node}.${ts}.${method.toUpperCase()}.${p}`).digest('hex');
async function signHeaders(method, p) {
  const key = secret(); const me = await self();
  if (!key || !me) throw new Error('this CMS is not part of a cluster (no cluster secret)');
  const ts = Date.now();
  return { 'X-Cluster-Node': me.node_uuid, 'X-Cluster-Ts': String(ts), 'X-Cluster-Sig': sig(key, me.node_uuid, ts, method, p) };
}
/** Express middleware: the request must be signed by a CMS that knows the cluster secret. */
function requireCluster(req, res, next) {
  const key = secret();
  const node = req.get('x-cluster-node'); const ts = Number(req.get('x-cluster-ts')); const got = String(req.get('x-cluster-sig') || '');
  if (!key || !node || !Number.isFinite(ts) || Math.abs(Date.now() - ts) > 120000) return res.status(401).json({ error: 'cluster authentication failed' });
  const want = sig(key, node, ts, req.method, req.baseUrl + req.path);
  const a = Buffer.from(got); const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'cluster authentication failed' });
  req.clusterNode = node;
  next();
}

// ------------------------------------------------------------------------------------------------------------------
// talking to another CMS
// ------------------------------------------------------------------------------------------------------------------
async function nodes({ withRemoved = false } = {}) {
  const { rows } = await pool.query(`SELECT * FROM cms_node ${withRemoved ? '' : 'WHERE removed_at IS NULL'} ORDER BY node_no`);
  return rows;
}
async function nodeByNo(no) { return (await pool.query(`SELECT * FROM cms_node WHERE node_no = $1`, [no])).rows[0] || null; }
async function isAlive(no) { return (await pool.query(`SELECT cms_node_alive($1) AS a`, [no])).rows[0].a; }

/** GET / POST to another CMS (signed). Returns the fetch Response. */
async function callNode(node, method, p, { body, range, hop, timeoutMs = 15000 } = {}) {
  if (!node || !node.url) throw new Error('that CMS has no address (URL) in the registry');
  const headers = { ...(await signHeaders(method, p)) };
  if (range) headers.Range = range;
  if (hop) headers['X-Cluster-Hop'] = '1'; // already forwarded once: the receiver must not forward it again
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(node.url.replace(/\/+$/, '') + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Serve a file that lives on ANOTHER CMS to `res`, byte for byte, with Range support (so a <video> can seek).
 * Throws an Error with .status for the caller to turn into a message the operator understands.
 */
async function proxyMedia(req, res, ownerNo, kind, id, { hop = false } = {}) {
  const node = await nodeByNo(ownerNo);
  if (!node || node.removed_at) { const e = new Error(`the CMS that holds this recording (node ${ownerNo}) is no longer part of the cluster`); e.status = 404; throw e; }
  let r;
  try { r = await callNode(node, 'GET', `/cluster/internal/media/${kind}/${id}`, { range: req.get('range') || undefined, hop, timeoutMs: 20000 }); } catch (err) {
    const e = new Error(`the CMS "${node.name}" (${node.location || 'location not set'}) that holds this recording cannot be reached - it is offline or unreachable`); e.status = 502; throw e;
  }
  if (r.status === 404) { const e = new Error(`the recording is not on the disk of "${node.name}" any more`); e.status = 404; throw e; }
  if (r.status >= 400 && r.status !== 416) { const e = new Error(`"${node.name}" refused to serve the recording (HTTP ${r.status})`); e.status = 502; throw e; }
  const keep = {};
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'x-content-sha256', 'content-disposition']) if (r.headers.get(h)) keep[h] = r.headers.get(h);
  keep['cache-control'] = 'no-store'; keep['x-served-by-node'] = String(ownerNo);
  res.writeHead(r.status, keep);
  const rs = Readable.fromWeb(r.body);
  rs.on('error', () => res.destroy());
  rs.pipe(res);
  // stop reading from the other CMS when the VIEWER goes away (not when the request has merely been received)
  res.on('close', () => { if (!res.writableFinished) rs.destroy(); });
}

/** Download a file from another CMS into `dest` (written beside it first). Returns the SHA-256 of what arrived. */
async function downloadFromNode(node, kind, id, dest) {
  const r = await callNode(node, 'GET', `/cluster/internal/media/${kind}/${id}`, { timeoutMs: 600000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.mirror-${process.pid}`;
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    Readable.fromWeb(r.body).on('data', (d) => h.update(d)).on('error', reject).pipe(out).on('finish', resolve).on('error', reject);
  });
  fs.renameSync(tmp, dest);
  return h.digest('hex');
}

// ------------------------------------------------------------------------------------------------------------------
// start-up: keep my own registry row right
// ------------------------------------------------------------------------------------------------------------------
async function event(kind, nodeNo, message) {
  await pool.query(`INSERT INTO cluster_event (kind, node_no, message) VALUES ($1, $2, $3)`, [kind, nodeNo, message]).catch(() => {});
}
async function init() {
  const me = await self({ fresh: true });
  if (!me) return null; // not clustered
  const name = String(process.env.CMS_NODE_NAME || '').trim(); const location = String(process.env.CMS_NODE_LOCATION || '').trim(); const url = String(process.env.CMS_PUBLIC_URL || '').trim();
  // .env only fills what is still empty: whatever was typed on the Cluster tab is kept across restarts
  await pool.query(
    `UPDATE cms_node SET name = COALESCE(NULLIF(name, ''), NULLIF($2, ''), name), location = COALESCE(NULLIF(location, ''), NULLIF($3, '')), url = COALESCE(NULLIF(url, ''), NULLIF($4, '')), version = $5, started_at = now(), last_seen = now()
      WHERE node_uuid = $1`, [me.node_uuid, name, location, url, config.version]);
  try { await pool.query(`SELECT cms_enable_live_triggers()`); await pool.query(`SELECT cms_refresh_publication()`); } catch (e) { console.warn('cluster: could not refresh replication settings:', e.message); }
  await event('start', me.node_no, `${me.name || 'this CMS'} started (version ${config.version})`);
  return self({ fresh: true });
}

// ------------------------------------------------------------------------------------------------------------------
// heartbeat: stamp my row (what others see) and look at the others
// ------------------------------------------------------------------------------------------------------------------
async function localStats() {
  const q = async (sql) => { try { return (await pool.query(sql)).rows[0] || {}; } catch (_) { return {}; } };
  // what THIS CMS is responsible for (its own M-NVRs, the alerts / incidents / recordings it made); a single CMS counts everything
  const a = await q(`SELECT (SELECT COUNT(*) FROM nvr_unit n WHERE n.status = 'active' AND cms_owns_nvr(n.id))::int AS nvrs,
                            (SELECT COUNT(*) FROM nvr_unit n WHERE n.status = 'active' AND n.last_seen > now() - interval '2 minutes' AND cms_owns_nvr(n.id))::int AS nvrs_online,
                            (SELECT COUNT(*) FROM alert WHERE status IN ('new','routed','escalated') AND cms_owns_strict(id))::int AS open_alerts,
                            (SELECT COUNT(*) FROM incident WHERE status <> 'closed' AND cms_owns_strict(id))::int AS open_incidents,
                            (SELECT COUNT(*) FROM evidence_flag WHERE status = 'active' AND cms_owns_strict(footage_id))::int AS evidence,
                            (SELECT COUNT(*) FROM delivered_footage WHERE cms_owns_strict(id))::int AS footage`);
  let disk = null;
  try { const s = fs.statfsSync(config.mediaRoot); disk = { free_gb: Math.round((s.bavail * s.bsize) / 1e9 * 10) / 10, total_gb: Math.round((s.blocks * s.bsize) / 1e9 * 10) / 10 }; } catch (_) { /* store not mounted */ }
  return { ...a, disk, uptime_s: Math.round((Date.now() - startedAt) / 1000), load: os.loadavg()[0], host: os.hostname() };
}
async function beat() {
  const me = await self();
  if (!me) return 'not clustered';
  const stats = await localStats();
  await pool.query(`UPDATE cms_node SET last_seen = now(), stats = $2::jsonb, version = $3 WHERE node_uuid = $1`, [me.node_uuid, JSON.stringify(stats), config.version]);
  return 'heartbeat sent';
}
async function probe() {
  const me = await self();
  if (!me) return 'not clustered';
  const peers = (await nodes()).filter((n) => n.node_uuid !== me.node_uuid);
  let up = 0; let down = 0;
  for (const n of peers) {
    const prev = (await pool.query(`SELECT reachable FROM cms_peer_status WHERE node_uuid = $1`, [n.node_uuid])).rows[0];
    let ok = false; let rtt = null; let err = null; let skew = null; let info = {};
    if (!n.url) err = 'no URL set for this CMS';
    else {
      const t0 = Date.now();
      try {
        const r = await fetch(n.url.replace(/\/+$/, '') + '/cluster/health', { signal: AbortSignal.timeout(2500) });
        rtt = Date.now() - t0;
        if (r.ok) { info = await r.json(); ok = info.node_uuid === n.node_uuid; if (!ok) err = 'answered, but it is a different CMS than the registry says'; skew = info.time ? Math.round(new Date(info.time).getTime() - (t0 + rtt / 2)) : null; } else err = `HTTP ${r.status}`;
      } catch (e) { err = e.name === 'TimeoutError' ? 'no answer (timed out)' : (e.cause && e.cause.code) || e.message; }
    }
    await pool.query(
      `INSERT INTO cms_peer_status (node_uuid, reachable, rtt_ms, last_ok_at, last_check_at, skew_ms, error, info) VALUES ($1, $2, $3, CASE WHEN $2 THEN now() END, now(), $4, $5, $6::jsonb)
       ON CONFLICT (node_uuid) DO UPDATE SET reachable = $2, rtt_ms = $3, last_ok_at = CASE WHEN $2 THEN now() ELSE cms_peer_status.last_ok_at END, last_check_at = now(), skew_ms = $4, error = $5, info = $6::jsonb`,
      [n.node_uuid, ok, rtt, skew, err, JSON.stringify(info)]);
    if (ok) up++; else down++;
    if (prev && prev.reachable !== ok) {
      await event(ok ? 'up' : 'down', n.node_no, ok ? `${n.name} is reachable again` : `${n.name} cannot be reached (${err})`);
      if (!ok) await considerTakeover(n);
    } else if (!prev && !ok) await event('down', n.node_no, `${n.name} cannot be reached (${err})`);
  }
  return `${up} CMS reachable, ${down} not`;
}
/** When another CMS goes down: if I am the lowest numbered CMS that is alive, I take over its database-only work. */
async function considerTakeover(dead) {
  const me = await self();
  const alive = [];
  for (const n of await nodes()) if (n.node_no !== dead.node_no && (n.node_uuid === me.node_uuid || (await isAlive(n.node_no)))) alive.push(n.node_no);
  if (alive.length && Math.min(...alive) === me.node_no) await event('takeover', dead.node_no, `${me.name} took over the alert / notification work of ${dead.name} (its video stays with it)`);
}

// ------------------------------------------------------------------------------------------------------------------
// what the Cluster tab shows
// ------------------------------------------------------------------------------------------------------------------
async function replication() {
  const out = { wal_level: null, publication: null, subscriptions: [], slots: [], can_manage: false };
  try {
    out.wal_level = (await pool.query(`SHOW wal_level`)).rows[0].wal_level;
    out.publication = (await pool.query(`SELECT p.pubname, (SELECT count(*)::int FROM pg_publication_tables t WHERE t.pubname = p.pubname) AS tables FROM pg_publication p WHERE p.pubname = 'cms_pub'`)).rows[0] || null;
    out.subscriptions = (await pool.query(
      `SELECT s.subname, s.subenabled, split_part(s.subconninfo, ' password', 1) AS conninfo, st.pid, st.received_lsn, st.last_msg_receipt_time, st.latest_end_time,
              (SELECT COALESCE(ss.apply_error_count, 0) + COALESCE(ss.sync_error_count, 0) FROM pg_stat_subscription_stats ss WHERE ss.subid = s.oid) AS errors,
              (SELECT count(*)::int FROM pg_subscription_rel r WHERE r.srsubid = s.oid AND r.srsubstate <> 'r') AS tables_syncing
         FROM pg_subscription s LEFT JOIN pg_stat_subscription st ON st.subid = s.oid AND st.relid IS NULL ORDER BY s.subname`)).rows;
    out.slots = (await pool.query(
      `SELECT slot_name, active, pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint AS lag_bytes FROM pg_replication_slots WHERE slot_type = 'logical' ORDER BY slot_name`)).rows;
    out.can_manage = (await pool.query(`SELECT (rolsuper OR pg_has_role(current_user, 'pg_create_subscription', 'member')) AS ok FROM pg_roles WHERE rolname = current_user`)).rows[0].ok;
  } catch (e) { out.error = e.message; }
  return out;
}
async function overview() {
  const me = await self();
  const list = await nodes({ withRemoved: true });
  const peers = new Map((await pool.query(`SELECT * FROM cms_peer_status`)).rows.map((p) => [p.node_uuid, p]));
  const now = Date.now();
  const rows = list.map((n) => {
    const isMe = !!me && n.node_uuid === me.node_uuid;
    const p = peers.get(n.node_uuid);
    const seenAge = n.last_seen ? (now - new Date(n.last_seen).getTime()) / 1000 : null;
    const reachableNow = isMe || (p && p.reachable && p.last_ok_at && (now - new Date(p.last_ok_at).getTime()) / 1000 < ALIVE_SECONDS);
    const alive = n.removed_at ? false : isMe || reachableNow || (seenAge != null && seenAge < ALIVE_SECONDS);
    // reachable over the network but not stamping its heartbeat into MY copy of the registry: replication to me is behind or broken
    const degraded = !isMe && !n.removed_at && alive && reachableNow && (seenAge == null || seenAge > 120);
    return { ...n, is_me: isMe, status: n.removed_at ? 'removed' : !alive ? 'offline' : degraded ? 'degraded' : 'online', reachable: isMe ? true : !!(p && p.reachable), rtt_ms: p ? p.rtt_ms : null, last_check_at: p ? p.last_check_at : null, last_ok_at: p ? p.last_ok_at : null, skew_ms: p ? p.skew_ms : null, error: p ? p.error : null, seen_age_s: seenAge == null ? null : Math.round(seenAge) };
  });
  const active = rows.filter((r) => r.status !== 'removed');
  const online = active.filter((r) => r.status === 'online' || r.status === 'degraded').length;
  const events = (await pool.query(`SELECT id, at, kind, node_no, message FROM cluster_event ORDER BY id DESC LIMIT 40`)).rows;
  return {
    clustered: !!me, cluster_id: me ? me.cluster_id : null, self: me ? { node_no: me.node_no, node_uuid: me.node_uuid } : null,
    summary: { nodes: active.length, online, offline: active.length - online, redundant: online >= 2, secret_set: !!secret() },
    nodes: rows, events, replication: me ? await replication() : null,
  };
}

// ------------------------------------------------------------------------------------------------------------------
// join / leave (called from the CLI and the Cluster tab)
// ------------------------------------------------------------------------------------------------------------------
/** The first CMS of a cluster: it becomes node 1 and keeps the ids it already has. */
async function createCluster({ name, location, url }) {
  if (await self({ fresh: true })) throw new Error('this CMS is already part of a cluster');
  ensureSecret();
  const clusterId = crypto.randomUUID(); const nodeUuid = crypto.randomUUID();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO cms_cluster_config (id, cluster_id, node_uuid, node_no) VALUES (1, $1, $2, 1)`, [clusterId, nodeUuid]);
    await c.query(`INSERT INTO cms_node (node_uuid, node_no, name, location, url, version, started_at, last_seen) VALUES ($1, 1, $2, $3, $4, $5, now(), now())`, [nodeUuid, name, location || null, url || null, config.version]);
    await c.query(`SELECT cms_assign_id_space(1)`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  await pool.query(`SELECT cms_refresh_publication()`); await pool.query(`SELECT cms_enable_live_triggers()`);
  cached = { at: 0, row: null };
  await event('create', 1, `cluster created by ${name}`);
  return self({ fresh: true });
}
/** A seed CMS hands out the next node number to a CMS that wants to join (called through the signed /cluster/internal/join). */
async function allocateNode({ name, location, url, node_uuid }) {
  const me = await self();
  if (!me) throw new Error('this CMS is not part of a cluster');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT pg_advisory_xact_lock(7311)`);
    const dup = (await c.query(`SELECT * FROM cms_node WHERE node_uuid = $1`, [node_uuid])).rows[0];
    if (dup) { await c.query('COMMIT'); return { cluster_id: me.cluster_id, node_no: dup.node_no, node_uuid: dup.node_uuid, rejoin: true }; }
    const no = (await c.query(`SELECT COALESCE(MAX(node_no), 0) + 1 AS n FROM cms_node`)).rows[0].n;
    await c.query(`INSERT INTO cms_node (node_uuid, node_no, name, location, url) VALUES ($1, $2, $3, $4, $5)`, [node_uuid, no, name, location || null, url || null]);
    await c.query('COMMIT');
    await event('join', no, `${name} joined the cluster as node ${no}`);
    return { cluster_id: me.cluster_id, node_no: no, node_uuid };
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

module.exports = {
  ID_SPACE, self, isClustered, nodeOfId, secret, ensureSecret, signHeaders, requireCluster, nodes, nodeByNo, isAlive, callNode, proxyMedia, downloadFromNode,
  init, beat, probe, overview, replication, createCluster, allocateNode, event, localStats,
};
