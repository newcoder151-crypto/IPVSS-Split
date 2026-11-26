'use strict';
/**
 * CMS directory: every CMS on the network finds the others BY ITSELF - nothing to set up, nothing to join.
 *
 *   identity    each CMS has a unique id (CMS-3F9A2C), made once on its first start (table cms_identity), plus a name and a place.
 *   beacon      every few seconds a CMS broadcasts "I am CMS-3F9A2C, my console is on port N" (UDP, CMS_DISCOVERY_PORT). A CMS that hears it
 *               adds the sender to its directory (table cms_directory) - the sender's address is taken from the packet itself.
 *   hello       every 10 s a CMS asks each CMS in its directory over HTTP (GET /cluster/hello): who are you, what do you hold (M-NVRs, trains,
 *               alerts, disk), and which other CMS do you know. That is how CMS in other networks (where a broadcast does not reach)
 *               become known: through a CMS both can see, or through CMS_SEED_URLS in config/control-room.conf.
 *   trust       beacons and hello calls are signed with CMS_CLUSTER_KEY (config/control-room.conf). A CMS with another key is simply not seen:
 *               use different keys to keep two groups of CMS apart.
 *
 * This only makes the CMS VISIBLE to each other (Cluster tab). It does not share data: that is the optional replication of services/cluster.js.
 */
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { pool } = require('../db');
const config = require('../config');

const ALIVE_S = 30;            // answered over HTTP within this long = online
const BEACON_EVERY_MS = 5000;
const HELLO_EVERY_MS = 10000;
const MAX_SKEW_MS = 5 * 60 * 1000;
const startedAt = Date.now();

const D = config.discovery;
let sock = null; let beaconTimer = null; let helloTimer = null; let running = false;
let idCache = { at: 0, row: null };

// ------------------------------------------------------------------------------------------------------------------
// who am I
// ------------------------------------------------------------------------------------------------------------------
async function identity({ fresh = false } = {}) {
  if (!fresh && idCache.row && Date.now() - idCache.at < 5000) return idCache.row;
  let row = (await pool.query(`SELECT cms_uid, cms_uuid, name, location FROM cms_identity WHERE id = 1`)).rows[0];
  if (!row) { // (the migration makes it; this only covers a database that has not been migrated yet)
    await pool.query(`INSERT INTO cms_identity (id, cms_uid, cms_uuid) SELECT 1, 'CMS-' || upper(substr(replace(u::text, '-', ''), 1, 6)), u FROM (SELECT gen_random_uuid() AS u) g ON CONFLICT (id) DO NOTHING`);
    row = (await pool.query(`SELECT cms_uid, cms_uuid, name, location FROM cms_identity WHERE id = 1`)).rows[0];
  }
  // .env / config only fill what is still empty: a name typed on the Cluster tab is kept across restarts
  if (!row.name || (!row.location && D.location)) {
    await pool.query(`UPDATE cms_identity SET name = COALESCE(NULLIF(name, ''), $1), location = COALESCE(NULLIF(location, ''), NULLIF($2, '')) WHERE id = 1`, [D.name || os.hostname(), D.location || '']);
    row = (await pool.query(`SELECT cms_uid, cms_uuid, name, location FROM cms_identity WHERE id = 1`)).rows[0];
  }
  idCache = { at: Date.now(), row };
  return row;
}

/** The address other CMS use to reach this one. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i);
  return out;
}
function ownUrl() {
  if (D.publicUrl) return D.publicUrl.replace(/\/+$/, '');
  const a = lanAddresses()[0];
  return a ? `http://${a.address}:${config.port}` : null;
}

// ------------------------------------------------------------------------------------------------------------------
// signing
// ------------------------------------------------------------------------------------------------------------------
const hmac = (...parts) => crypto.createHmac('sha256', D.key).update(parts.join('.')).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const freshTs = (ts) => Number.isFinite(Number(ts)) && Math.abs(Date.now() - Number(ts)) < MAX_SKEW_MS;

/** Express middleware for GET /cluster/hello: the caller must hold the same cluster key. */
function requireKey(req, res, next) {
  if (!D.enabled) return res.status(404).json({ error: 'automatic discovery is switched off on this CMS' });
  const ts = req.get('x-dir-ts'); const uid = String(req.get('x-dir-uid') || ''); const sig = req.get('x-dir-sig');
  if (!ts || !sig || !freshTs(ts) || !same(sig, hmac('hello', uid, ts))) return res.status(401).json({ error: 'cluster key does not match' });
  req.dirPeer = uid;
  next();
}

// ------------------------------------------------------------------------------------------------------------------
// what I tell the others
// ------------------------------------------------------------------------------------------------------------------
async function trainsSummary() {
  try {
    const { rows } = await pool.query(
      `SELECT n.train_no, n.mnvr_uid, COALESCE(n.unit_no, n.id) AS unit_no, n.name, (n.last_seen > now() - interval '2 minutes') AS online,
              (SELECT COUNT(*) FROM camera c WHERE c.nvr_id = n.id AND c.active)::int AS cameras
         FROM nvr_unit n WHERE n.status <> 'removed' ORDER BY n.train_no NULLS LAST, 3 LIMIT 400`);
    const by = new Map();
    for (const r of rows) {
      const k = (r.train_no || '').trim() || '-';
      if (!by.has(k)) by.set(k, { train_no: k === '-' ? null : k, units: [] });
      by.get(k).units.push({ mnvr_uid: r.mnvr_uid, unit_no: r.unit_no, name: r.name, online: r.online, cameras: r.cameras });
    }
    return [...by.values()];
  } catch (_) { return []; }
}
async function hello() {
  const me = await identity();
  const cluster = require('./cluster');
  const peers = (await pool.query(`SELECT cms_uid, name, location, url FROM cms_directory WHERE forgotten_at IS NULL AND url IS NOT NULL AND reachable`)).rows;
  const time = new Date().toISOString();
  return {
    cms_uid: me.cms_uid, cms_uuid: me.cms_uuid, name: me.name, location: me.location, url: ownUrl(), version: config.version, time,
    host: os.hostname(), stats: await cluster.localStats(), trains: await trainsSummary(), peers, sig: hmac('reply', me.cms_uid, me.cms_uuid, time),
  };
}

// ------------------------------------------------------------------------------------------------------------------
// directory writes
// ------------------------------------------------------------------------------------------------------------------
async function event(kind, message) { await pool.query(`INSERT INTO cluster_event (kind, node_no, message) VALUES ($1, NULL, $2)`, [kind, message]).catch(() => {}); }

/** A CMS was heard (beacon) or named (gossip / config). `heard` = it spoke to us just now. */
async function note(p, { source, learnedFrom, heard }) {
  const me = await identity();
  if (!p.cms_uid || p.cms_uid === me.cms_uid || !/^CMS-[0-9A-F]{6}$/.test(p.cms_uid)) return;
  const prev = (await pool.query(`SELECT cms_uuid, url, forgotten_at FROM cms_directory WHERE cms_uid = $1`, [p.cms_uid])).rows[0];
  if (prev && p.cms_uuid && prev.cms_uuid && String(prev.cms_uuid) !== String(p.cms_uuid)) {
    await pool.query(`UPDATE cms_directory SET error = 'another CMS uses the same id - one of them must be reinstalled' WHERE cms_uid = $1`, [p.cms_uid]);
    return;
  }
  await pool.query(
    `INSERT INTO cms_directory (cms_uid, cms_uuid, name, location, url, version, source, learned_from, last_seen)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9 THEN now() END)
     ON CONFLICT (cms_uid) DO UPDATE SET
          cms_uuid = COALESCE(EXCLUDED.cms_uuid, cms_directory.cms_uuid), name = COALESCE(NULLIF(EXCLUDED.name, ''), cms_directory.name),
          location = COALESCE(EXCLUDED.location, cms_directory.location), url = COALESCE(EXCLUDED.url, cms_directory.url),
          version = COALESCE(EXCLUDED.version, cms_directory.version),
          last_seen = CASE WHEN $9 THEN now() ELSE cms_directory.last_seen END,
          forgotten_at = CASE WHEN $9 THEN NULL ELSE cms_directory.forgotten_at END`,
    [p.cms_uid, p.cms_uuid || null, p.name || null, p.location || null, p.url || null, p.version || null, source, learnedFrom || null, !!heard]);
  if (!prev) await event('found', `${p.name || p.cms_uid} (${p.cms_uid}) found on the network${p.url ? ` at ${p.url}` : ''}`);
}

// ------------------------------------------------------------------------------------------------------------------
// beacon (UDP)
// ------------------------------------------------------------------------------------------------------------------
function broadcastTargets() {
  const set = new Set(D.broadcast);
  for (const i of lanAddresses()) {
    const a = i.address.split('.').map(Number); const m = i.netmask.split('.').map(Number);
    set.add(a.map((x, k) => (x | (~m[k] & 255))).join('.'));
  }
  return [...set];
}
async function sendBeacon() {
  if (!sock) return;
  try {
    const me = await identity(); const ts = Date.now();
    const msg = Buffer.from(JSON.stringify({ v: 1, uid: me.cms_uid, uuid: me.cms_uuid, name: me.name, location: me.location, port: config.port, version: config.version, ts, sig: hmac('beacon', me.cms_uid, me.cms_uuid, config.port, ts) }));
    for (const t of broadcastTargets()) sock.send(msg, D.port, t, () => { /* a network without broadcast: the other ways (seeds, gossip) still work */ });
  } catch (_) { /* next time */ }
}
async function onBeacon(buf, rinfo) {
  let m; try { m = JSON.parse(buf.toString('utf8')); } catch (_) { return; }
  if (!m || m.v !== 1 || !m.uid || !m.port || !freshTs(m.ts) || !same(m.sig || '', hmac('beacon', m.uid, m.uuid, m.port, m.ts))) return;
  try {
    await note({ cms_uid: m.uid, cms_uuid: m.uuid, name: m.name, location: m.location, version: m.version, url: `http://${rinfo.address}:${Number(m.port)}` }, { source: 'broadcast', heard: true });
  } catch (e) { console.warn('directory:', e.message); }
}

// ------------------------------------------------------------------------------------------------------------------
// hello (HTTP): ask a CMS who it is and what it knows
// ------------------------------------------------------------------------------------------------------------------
async function callHello(url) {
  const me = await identity(); const ts = Date.now();
  const t0 = Date.now();
  const r = await fetch(url.replace(/\/+$/, '') + '/cluster/hello', { headers: { 'X-Dir-Uid': me.cms_uid, 'X-Dir-Ts': String(ts), 'X-Dir-Sig': hmac('hello', me.cms_uid, ts) }, signal: AbortSignal.timeout(2500) });
  const rtt = Date.now() - t0;
  if (r.status === 401) throw Object.assign(new Error('answers, but with another cluster key'), { code: 'KEY' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.cms_uid || !same(j.sig || '', hmac('reply', j.cms_uid, j.cms_uuid, j.time))) throw new Error('the answer is not signed with this cluster key');
  return { j, rtt, skew: j.time ? Math.round(new Date(j.time).getTime() - (t0 + rtt / 2)) : null };
}
const errText = (e) => (e.name === 'TimeoutError' ? 'no answer (timed out)' : (e.cause && e.cause.code) || e.message);

async function checkPeer(row) {
  const prevOk = row.reachable;
  let ok = false; let rtt = null; let skew = null; let err = null; let info = null;
  if (!row.url) err = 'no address known yet';
  else {
    try { const r = await callHello(row.url); info = r.j; rtt = r.rtt; skew = r.skew; ok = info.cms_uid === row.cms_uid; if (!ok) err = 'answered, but it is a different CMS than the directory says'; } catch (e) { err = errText(e); }
  }
  await pool.query(
    `UPDATE cms_directory SET reachable = $2, rtt_ms = $3, skew_ms = $4, error = $5, last_check_at = now(),
            last_ok_at = CASE WHEN $2 THEN now() ELSE last_ok_at END, last_seen = CASE WHEN $2 THEN now() ELSE last_seen END,
            name = COALESCE($6, name), location = COALESCE($7, location), version = COALESCE($8, version), host = COALESCE($9, host),
            stats = CASE WHEN $2 THEN $10::jsonb ELSE stats END, trains = CASE WHEN $2 THEN $11::jsonb ELSE trains END,
            url = COALESCE($12, url), forgotten_at = CASE WHEN $2 THEN NULL ELSE forgotten_at END
      WHERE cms_uid = $1`,
    [row.cms_uid, ok, rtt, skew, err, ok ? info.name : null, ok ? info.location : null, ok ? info.version : null, ok ? info.host : null,
      JSON.stringify(ok ? info.stats || {} : {}), JSON.stringify(ok ? info.trains || [] : []), null]);
  const label = row.name || row.cms_uid;
  if (ok && !prevOk && row.last_ok_at) await event('up', `${label} (${row.cms_uid}) is reachable again`);
  else if (!ok && prevOk) await event('down', `${label} (${row.cms_uid}) cannot be reached (${err})`);
  // gossip: the CMS it knows that I do not
  if (ok && Array.isArray(info.peers)) for (const p of info.peers.slice(0, 50)) if (p && p.url) await note({ cms_uid: p.cms_uid, name: p.name, location: p.location, url: p.url }, { source: 'gossip', learnedFrom: row.cms_uid }).catch(() => {});
  return ok;
}

/** One round: ask every CMS of the directory, then every address of CMS_SEED_URLS that is not in it yet. */
async function refresh() {
  if (!D.enabled) return 'automatic discovery is off';
  const rows = (await pool.query(`SELECT * FROM cms_directory WHERE forgotten_at IS NULL OR last_seen > forgotten_at`)).rows;
  let up = 0;
  await Promise.all(rows.map(async (r) => { if (await checkPeer(r).catch(() => false)) up++; }));
  const known = new Set(rows.map((r) => (r.url || '').replace(/\/+$/, '')));
  for (const url of D.seeds) {
    if (known.has(url.replace(/\/+$/, ''))) continue;
    try {
      const r = await callHello(url);
      await note({ cms_uid: r.j.cms_uid, cms_uuid: r.j.cms_uuid, name: r.j.name, location: r.j.location, version: r.j.version, url: url.replace(/\/+$/, '') }, { source: 'config', heard: true });
    } catch (_) { /* not up yet: tried again next round */ }
  }
  return `${rows.length} other CMS known, ${up} answering`;
}

// ------------------------------------------------------------------------------------------------------------------
// lifecycle
// ------------------------------------------------------------------------------------------------------------------
async function start() {
  if (running) return;
  if (!D.enabled) { console.log('CMS discovery: off (CMS_DISCOVERY in config/control-room.conf)'); return; }
  if (!D.port || !D.key) { console.warn('CMS discovery: CMS_DISCOVERY_PORT / CMS_CLUSTER_KEY are not set in config/control-room.conf - this CMS will not find the others'); return; }
  running = true;
  const me = await identity({ fresh: true });
  await event('start', `${me.name} (${me.cms_uid}) started - version ${config.version}`);
  sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (b, r) => { onBeacon(b, r); });
  sock.on('error', (e) => { console.warn(`CMS discovery: beacon socket: ${e.message} - the other CMS can still be found through CMS_SEED_URLS or by the CMS that know both`); try { sock.close(); } catch (_) { /* gone */ } sock = null; });
  await new Promise((resolve) => sock.bind(D.port, () => { try { sock.setBroadcast(true); } catch (_) { /* no broadcast */ } resolve(); })).catch(() => {});
  console.log(`CMS ${me.cms_uid} "${me.name}" looks for other CMS (beacon port ${D.port}/udp)`);
  const tick = async () => { try { await refresh(); } catch (e) { console.warn('directory refresh:', e.message); } };
  sendBeacon();
  beaconTimer = setInterval(sendBeacon, BEACON_EVERY_MS); beaconTimer.unref();
  setTimeout(tick, 1500).unref();
  helloTimer = setInterval(tick, HELLO_EVERY_MS); helloTimer.unref();
}
function stop() {
  running = false;
  clearInterval(beaconTimer); clearInterval(helloTimer);
  if (sock) { try { sock.close(); } catch (_) { /* gone */ } sock = null; }
}

// ------------------------------------------------------------------------------------------------------------------
// what the Cluster tab shows
// ------------------------------------------------------------------------------------------------------------------
async function localRow() {
  const me = await identity();
  const cluster = require('./cluster');
  return {
    cms_uid: me.cms_uid, cms_uuid: me.cms_uuid, name: me.name, location: me.location, url: ownUrl(), host: os.hostname(), version: config.version,
    is_me: true, status: 'online', reachable: true, rtt_ms: 0, skew_ms: 0, error: null, source: 'self', seen_age_s: 0,
    stats: await cluster.localStats(), trains: await trainsSummary(), uptime_s: Math.round((Date.now() - startedAt) / 1000),
  };
}
async function overview() {
  const me = await localRow();
  const rows = (await pool.query(`SELECT * FROM cms_directory ORDER BY cms_uid`)).rows;
  const now = Date.now();
  const peers = rows.map((r) => {
    const okAge = r.last_ok_at ? (now - new Date(r.last_ok_at).getTime()) / 1000 : null;
    const seenAge = r.last_seen ? (now - new Date(r.last_seen).getTime()) / 1000 : null;
    const forgotten = !!r.forgotten_at && !(r.last_seen && new Date(r.last_seen) > new Date(r.forgotten_at));
    const status = forgotten ? 'forgotten' : r.reachable && okAge != null && okAge < ALIVE_S ? 'online' : seenAge != null && seenAge < ALIVE_S ? 'unreachable' : 'offline';
    return { ...r, is_me: false, status, seen_age_s: seenAge == null ? null : Math.round(seenAge), ok_age_s: okAge == null ? null : Math.round(okAge) };
  });
  const shown = peers.filter((p) => p.status !== 'forgotten');
  const online = 1 + shown.filter((p) => p.status === 'online').length;
  const all = [me, ...shown];
  const sum = (f) => all.reduce((a, n) => a + (+((n.stats || {})[f]) || 0), 0);
  const trainSet = new Set(); let units = 0;
  for (const n of all) for (const t of n.trains || []) { if (t.train_no) trainSet.add(`${n.cms_uid}|${String(t.train_no).toLowerCase()}`); units += (t.units || []).length; }
  return {
    enabled: D.enabled, port: D.port, self: me, peers: shown, forgotten: peers.length - shown.length,
    summary: { cms: all.length, online, offline: all.length - online, mnvrs: units, mnvrs_online: sum('nvrs_online'), trains: trainSet.size },
  };
}
async function forget(uid) {
  const r = await pool.query(`UPDATE cms_directory SET forgotten_at = now() WHERE cms_uid = $1 AND NOT (reachable AND last_ok_at > now() - make_interval(secs => $2))`, [uid, ALIVE_S]);
  return r.rowCount > 0;
}
async function rename({ name, location }) {
  const me = await identity({ fresh: true });
  await pool.query(`UPDATE cms_identity SET name = COALESCE($1, name), location = COALESCE($2, location) WHERE id = 1`, [name, location]);
  idCache = { at: 0, row: null };
  sendBeacon();
  return me.cms_uid;
}

module.exports = { identity, hello, requireKey, start, stop, refresh, overview, forget, rename, note, ownUrl };
