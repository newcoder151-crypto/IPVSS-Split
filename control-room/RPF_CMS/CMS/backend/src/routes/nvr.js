/**
 * M-NVR -> CMS interface. Everything here is called BY the train unit:
 *   POST /heartbeat            position, health, GPS track  ->  returns waiting commands
 *   POST /alerts               alert with GPS + original event time (idempotent)
 *   POST /segments             announce a recorded segment (catalogue entry)
 *   PUT  /segments/:id/chunks/:n   upload a chunk (resumable)
 *   POST /segments/:id/complete    verify + store
 *   GET  /commands, POST /commands/:id/(ack|done|fail)
 * The unit authenticates with its certificate fingerprint (mTLS at the gateway in production).
 */
const express = require('express');
const { pool } = require('../db');
const { requireNvr } = require('../middleware/auth');
const { ingestAlert } = require('../services/alertService');
const seg = require('../services/segmentService');
const reqs = require('../services/requestService');
const { parseId } = require('../services/util');
const live = require('../services/live');
const { badRequest, notFound, wrap } = require('../errors');

const router = express.Router();
router.use(requireNvr);
router.use(wrap(async (req, res, next) => { // any contact counts as "seen"
  await pool.query(`UPDATE nvr_unit SET last_seen = now() WHERE id = $1 AND (last_seen IS NULL OR last_seen < now() - interval '3 seconds')`, [req.nvr.id]);
  next();
}));

async function waitingCommands(nvrId, markSent) {
  if (markSent) await pool.query(`UPDATE nvr_command SET status='sent', sent_at=now() WHERE nvr_id=$1 AND status='queued'`, [nvrId]);
  const { rows } = await pool.query(
    `SELECT id, kind, camera_id, window_start, window_end, request_id, status FROM nvr_command
      WHERE nvr_id = $1 AND status IN ('queued','sent','acked') ORDER BY id LIMIT 20`, [nvrId]);
  return rows;
}

/** The unit asks who it is: its registered cameras and the server clock (to check clock drift). */
router.get('/self', wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT id, name, mount_position FROM camera WHERE nvr_id = $1 AND active ORDER BY id`, [req.nvr.id]);
  res.json({ nvr: { id: req.nvr.id, name: req.nvr.name, zone_id: req.nvr.zone_id }, cameras: rows, server_time: new Date().toISOString() });
}));

router.post('/heartbeat', wrap(async (req, res) => {
  const b = req.body || {};
  const sets = []; const params = [req.nvr.id];
  const add = (col, v, cast = '') => { params.push(v); sets.push(`${col} = $${params.length}${cast}`); };
  if (Number.isFinite(Number(b.lat)) && Number.isFinite(Number(b.lon)) && b.lat != null) { add('last_lat', Number(b.lat)); add('last_lon', Number(b.lon)); }
  if (b.speed_mps != null && Number.isFinite(Number(b.speed_mps))) add('last_speed_mps', Number(b.speed_mps));
  if (b.health && typeof b.health === 'object') add('health', JSON.stringify(b.health), '::jsonb');
  if (typeof b.firmware === 'string') add('firmware', b.firmware.slice(0, 60));
  await pool.query(`UPDATE nvr_unit SET last_seen = now()${sets.length ? ', ' + sets.join(', ') : ''} WHERE id = $1`, params);

  const pts = Array.isArray(b.gps) ? b.gps.slice(0, 500).filter((p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)) && !Number.isNaN(new Date(p.ts).getTime())) : [];
  if (pts.length) {
    try {
      await pool.query(
        `INSERT INTO gps_point (nvr_id, ts, location, speed_mps, fix_quality)
         SELECT $1, t.ts, ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography, t.speed, $6
           FROM unnest($2::timestamptz[], $3::float8[], $4::float8[], $5::real[]) AS t(ts, lon, lat, speed)
         ON CONFLICT DO NOTHING`,
        [req.nvr.id, pts.map((p) => new Date(p.ts)), pts.map((p) => Number(p.lon)), pts.map((p) => Number(p.lat)), pts.map((p) => (p.speed_mps == null ? null : Number(p.speed_mps))), b.fix_quality || null]);
    } catch (e) { console.warn(`gps insert for ${req.nvr.name}: ${e.message}`); }
  }
  res.json({ server_time: new Date().toISOString(), commands: await waitingCommands(req.nvr.id, true) });
}));

router.post('/alerts', wrap(async (req, res) => {
  const r = await ingestAlert(req.nvr, req.body || {});
  res.status(r.duplicate ? 200 : 201).json(r);
}));

router.post('/segments', wrap(async (req, res) => res.status(201).json(await seg.registerSegment(req.nvr, req.body || {}))));
router.get('/segments/:id', wrap(async (req, res) => {
  const s = await seg.loadOwned(req.nvr, parseId(req.params.id));
  res.json({ id: s.id, upload_status: s.upload_status, bytes_received: s.bytes_received, last_chunk_index: s.last_chunk_index, size_bytes: s.size_bytes });
}));
router.put('/segments/:id/chunks/:index', express.raw({ type: '*/*', limit: '8mb' }), wrap(async (req, res) => {
  res.json(await seg.uploadChunk(req.nvr, parseId(req.params.id), Number(req.params.index), Buffer.isBuffer(req.body) ? req.body : null, req.get('x-chunk-sha256')));
}));
router.post('/segments/:id/complete', wrap(async (req, res) => res.json(await seg.completeSegment(req.nvr, parseId(req.params.id)))));

/**
 * Long poll: returns as soon as a command is waiting for this unit (instantly if one already is), or [] after
 * `timeout` seconds. A unit with coverage keeps one of these open, so "upload now" reaches it in milliseconds
 * rather than at the next heartbeat.
 */
router.get('/commands/wait', wrap(async (req, res) => {
  const timeout = Math.min(30, Math.max(1, Number(req.query.timeout) || 25)) * 1000;
  const first = await waitingCommands(req.nvr.id, true);
  if (first.length) return res.json(first);
  let done = false; let off; let timer;
  const finish = async () => {
    if (done) return; done = true; clearTimeout(timer); off && off();
    try { res.json(await waitingCommands(req.nvr.id, true)); } catch (e) { if (!res.headersSent) res.status(500).json({ error: 'internal server error' }); }
  };
  off = live.subscribe((e) => { if (e.t === 'nvr_command' && Number(e.n) === Number(req.nvr.id) && e.op === 'INSERT') finish(); });
  timer = setTimeout(finish, timeout);
  req.on('close', () => { done = true; clearTimeout(timer); off && off(); });
}));
router.get('/commands', wrap(async (req, res) => res.json(await waitingCommands(req.nvr.id, true))));

async function loadCommand(req) {
  const { rows } = await pool.query(`SELECT id, request_id, status FROM nvr_command WHERE id = $1 AND nvr_id = $2`, [parseId(req.params.id), req.nvr.id]);
  if (!rows.length) throw notFound('command not found');
  return rows[0];
}
router.post('/commands/:id/ack', wrap(async (req, res) => {
  const c = await loadCommand(req);
  await pool.query(`UPDATE nvr_command SET status='acked', acked_at=now() WHERE id=$1 AND status IN ('queued','sent')`, [c.id]);
  res.json({ ok: true });
}));
router.post('/commands/:id/done', wrap(async (req, res) => {
  const c = await loadCommand(req);
  const missing = Array.isArray(req.body && req.body.missing) ? req.body.missing.slice(0, 50) : [];
  await pool.query(`UPDATE nvr_command SET status='done', completed_at=now(), result=$2 WHERE id=$1 AND status IN ('queued','sent','acked')`, [c.id, JSON.stringify({ missing })]);
  if (c.request_id) await reqs.processRequest(c.request_id).catch((e) => console.error(e.message));
  res.json({ ok: true });
}));
router.post('/commands/:id/fail', wrap(async (req, res) => {
  const c = await loadCommand(req);
  const error = String((req.body && req.body.error) || 'unspecified').slice(0, 300);
  await pool.query(`UPDATE nvr_command SET status='failed', completed_at=now(), result=$2 WHERE id=$1 AND status IN ('queued','sent','acked')`, [c.id, JSON.stringify({ error })]);
  if (c.request_id) await reqs.processRequest(c.request_id).catch((e) => console.error(e.message));
  res.json({ ok: true });
}));

module.exports = router;
