const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const config = require('../../config');
const { zoneScope, canSeeZone } = require('../../middleware/auth');
const ev = require('../../services/evidenceService');
const { absPath, exists, mimeFor } = require('../../services/fsutil');
const { serveFile } = require('../../services/mediaServe');
const { audit } = require('../../services/audit');
const { parseId, parseLimit, parseOffset, requireText, where, rangeFilter, trainFilter, mnvrFilter, searchFilter } = require('../../services/util');
const { badRequest, notFound, unauthorized, wrap } = require('../../errors');
const fs = require('fs');

const router = express.Router();
const media = express.Router(); // mounted WITHOUT bearer auth: link-token authenticated
const cluster = require('../../services/cluster');
const { HttpError } = require('../../errors');

/**
 * The file of a recording is on the disk of the CMS that made it. If that is ANOTHER CMS of the cluster, return its registry row
 * (so the console can still play it: this CMS streams it from there). Null = the file should be on this CMS. Throws a clear message
 * when that other CMS is offline.
 */
async function heldElsewhere(ownerId) {
  const me = await cluster.self();
  if (!me) return null;
  const owner = cluster.nodeOfId(ownerId);
  if (owner === me.node_no) return null;
  const n = await cluster.nodeByNo(owner);
  if (!n || n.removed_at) throw new HttpError(404, 'the CMS that held this recording is no longer part of the cluster');
  if (!(await cluster.isAlive(owner))) throw new HttpError(502, `This recording is on "${n.name}"${n.location ? ` (${n.location})` : ''}, which is offline right now. Try again when it is back.`);
  return n;
}

const FOOTAGE_LIST = `
  SELECT f.id, f.video_request_id AS request_id, f.train_request_id, f.file_name, COALESCE(f.unit_no, n.unit_no, n.id) AS unit_no, COALESCE(f.camera_no, c.mnvr_camera_id, c.id) AS camera_no, r.incident_id, f.format, f.sha256, f.file_size_bytes, f.duration_s, f.start_time, f.end_time, f.segment_count, f.delivered_at,
         p.id AS post_id, p.name AS post_name, p.zone_id, c.name AS camera_name, n.name AS nvr_name, COALESCE(f.train_no, n.train_no) AS train_no, n.mnvr_uid,
         r.window_start, r.window_end, r.reason,
         (SELECT COUNT(*) FROM evidence_flag e WHERE e.footage_id = f.id AND e.status = 'active') AS active_flags
    FROM delivered_footage f
    JOIN video_request r ON r.id = f.video_request_id JOIN rpf_post p ON p.id = r.post_id
    JOIN camera c ON c.id = r.camera_id JOIN nvr_unit n ON n.id = c.nvr_id`;

const TRAIN_COL = 'COALESCE(f.train_no, n.train_no)';
const MNVR = { uid: 'n.mnvr_uid', name: 'n.name', no: 'COALESCE(f.unit_no, n.unit_no, n.id)' };
/** The M-NVRs that have recordings in the user's zone(s): the choices offered while typing an M-NVR. */
async function mnvrChoices(user, zoneId, fromSql) {
  const w = where(); w.raw(zoneScope(user, 'p.zone_id', w.params, zoneId));
  const { rows } = await pool.query(`SELECT DISTINCT n.mnvr_uid AS uid, n.name ${fromSql} ${w.sql()} ORDER BY 1 LIMIT 1000`, w.params);
  return rows;
}
const FOOTAGE_FROM = `FROM delivered_footage f JOIN video_request r ON r.id=f.video_request_id JOIN rpf_post p ON p.id=r.post_id JOIN camera c ON c.id=r.camera_id JOIN nvr_unit n ON n.id=c.nvr_id`;
const EVID_FROM = `FROM evidence_flag e JOIN delivered_footage f ON f.id=e.footage_id JOIN video_request r ON r.id=f.video_request_id JOIN rpf_post p ON p.id=r.post_id JOIN camera c ON c.id=r.camera_id JOIN nvr_unit n ON n.id=c.nvr_id`;
/** Train numbers that exist in the user's zone(s): the choices offered while typing a train number. */
async function trainChoices(user, zoneId, fromSql) {
  const w = where(); w.raw(zoneScope(user, 'p.zone_id', w.params, zoneId));
  const { rows } = await pool.query(`SELECT DISTINCT ${TRAIN_COL} AS t ${fromSql} ${w.sql()} ORDER BY 1 LIMIT 1000`, w.params);
  return rows.map((x) => x.t).filter(Boolean);
}

/**
 * GET /footage?q=&train_no=&from=&to=&date_by=recorded|delivered&flagged=yes|no&post_id=&sort=new|old&limit=&offset=
 * from/to: ISO timestamps (from inclusive, to exclusive) made by the console from the operator's calendar days.
 */
router.get('/footage', wrap(async (req, res) => {
  const q = req.query; const w = where();
  w.raw(zoneScope(req.user, 'p.zone_id', w.params, q.zone_id));
  if (q.post_id) w.add('p.id = ?', Number(q.post_id));
  trainFilter(w, q.train_no, TRAIN_COL);
  mnvrFilter(w, q.mnvr, MNVR);
  rangeFilter(w, q.from, q.to, q.date_by === 'delivered' ? 'f.delivered_at' : 'COALESCE(f.start_time, r.window_start)');
  if (q.flagged === 'yes') w.raw(`EXISTS (SELECT 1 FROM evidence_flag e WHERE e.footage_id = f.id AND e.status = 'active')`);
  if (q.flagged === 'no') w.raw(`NOT EXISTS (SELECT 1 FROM evidence_flag e WHERE e.footage_id = f.id AND e.status = 'active')`);
  searchFilter(w, q.q, ['f.id', 'f.video_request_id', 'f.sha256', 'f.file_name', 'c.name', 'n.name', 'n.mnvr_uid', TRAIN_COL, 'p.name']);
  const order = q.sort === 'old' ? 'COALESCE(f.start_time, r.window_start) ASC, f.id ASC' : 'COALESCE(f.start_time, r.window_start) DESC, f.id DESC';
  const limit = parseLimit(q.limit, 50, q.export ? 5000 : 200); const offset = parseOffset(q.offset);
  const [rows, total, trains, mnvrs] = await Promise.all([
    pool.query(`${FOOTAGE_LIST} ${w.sql()} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, w.params),
    pool.query(`SELECT COUNT(*) AS n ${FOOTAGE_FROM} ${w.sql()}`, w.params),
    q.export ? [] : trainChoices(req.user, q.zone_id, FOOTAGE_FROM),
    q.export ? [] : mnvrChoices(req.user, q.zone_id, FOOTAGE_FROM)]);
  res.json({ rows: rows.rows, total: total.rows[0].n, trains, mnvrs });
}));

async function loadFootage(user, id) {
  const { rows } = await pool.query(`${FOOTAGE_LIST} WHERE f.id = $1`, [id]);
  if (!rows.length || !canSeeZone(user, rows[0].zone_id)) throw notFound('footage not found');
  return rows[0];
}

/** POST /footage/:id/link {purpose} -> short-lived signed URL; issuing it is audited (view and download alike). */
router.post('/footage/:id/link', wrap(async (req, res) => {
  const f = await loadFootage(req.user, parseId(req.params.id));
  const purpose = req.body && req.body.purpose === 'download' ? 'download' : 'view';
  const { rows } = await pool.query('SELECT storage_path FROM delivered_footage WHERE id = $1', [f.id]);
  let heldBy = null;
  if (!exists(absPath(rows[0].storage_path))) { heldBy = await heldElsewhere(f.id); if (!heldBy) throw notFound('footage file is missing from the footage store'); }
  const t = jwt.sign({ k: 'footage', id: f.id, u: req.user.id, d: purpose === 'download' }, config.jwtSecret, { expiresIn: `${config.footageLinkMinutes}m`, issuer: 'cms-media' });
  await audit(null, { user: req.user, action: `console.footage.${purpose}`, entity: 'delivered_footage', entityId: f.id, zoneId: f.zone_id, details: { sha256: f.sha256, ...(heldBy ? { held_by: heldBy.name } : {}) } });
  res.json({ url: `/media/footage/${f.id}?t=${t}`, format: f.format, playable: String(f.format).toLowerCase() === 'mp4', held_by: heldBy ? heldBy.name : null });
}));

// ---- evidence flags --------------------------------------------------------------------------
/**
 * GET /evidence?status=&kept=permanent|timed&expiring=<days>&ext=pending&storage=&archive_status=&post_id=&q=&train_no=&from=&to=&date_by=recorded|flagged&sort=new|old|expiry&limit=&offset=
 * `q` also matches a SHA-256 (or its beginning), so a checksum from a report finds its recording.
 * `expiring=30` = held recordings whose timed retention ends within 30 days (already-ended ones included).
 */
router.get('/evidence', wrap(async (req, res) => {
  const w = where();
  w.raw(zoneScope(req.user, 'p.zone_id', w.params, req.query.zone_id));
  const q = req.query;
  if (q.status) w.add('e.status = ?', q.status);
  if (q.archive_status) w.add('e.archive_status = ?', q.archive_status);
  if (q.retention || q.kept) w.add('e.retention = ?', q.retention || q.kept);
  if (q.storage) w.add('e.storage = ?', q.storage);
  if (q.post_id) w.add('p.id = ?', Number(q.post_id));
  if (q.ext === 'pending') w.raw(`e.ext_status = 'pending'`);
  const exp = Number(q.expiring);
  if (Number.isInteger(exp) && exp > 0) w.add(`(e.retain_to IS NOT NULL AND e.retain_to <= now() + make_interval(days => ?))`, Math.min(exp, 36500));
  trainFilter(w, q.train_no, TRAIN_COL);
  mnvrFilter(w, q.mnvr, MNVR);
  rangeFilter(w, q.from, q.to, q.date_by === 'flagged' ? 'e.flagged_at' : 'COALESCE(f.start_time, r.window_start)');
  searchFilter(w, q.q, ['e.id', 'e.justification', 'e.archive_sha256', 'e.local_sha256', 'f.sha256', 'c.name', 'n.name', 'n.mnvr_uid', TRAIN_COL, 'p.name']);
  const ORDER = { new: 'e.id DESC', old: 'e.id ASC', expiry: 'e.retain_to ASC NULLS LAST, e.id DESC', recorded: 'COALESCE(f.start_time, r.window_start) DESC, e.id DESC' };
  const limit = parseLimit(q.limit, 50, q.export ? 5000 : 200); const offset = parseOffset(q.offset);
  const [rows, total, trains, mnvrs] = await Promise.all([
    pool.query(`${ev.FLAG_SELECT} ${w.sql()} ORDER BY ${ORDER[q.sort] || ORDER.new} LIMIT ${limit} OFFSET ${offset}`, w.params),
    pool.query(`SELECT COUNT(*) AS n, COALESCE(SUM(e.archive_size_bytes),0) AS bytes ${EVID_FROM} ${w.sql()}`, w.params),
    q.export ? [] : trainChoices(req.user, q.zone_id, EVID_FROM),
    q.export ? [] : mnvrChoices(req.user, q.zone_id, EVID_FROM)]);
  // the tiles on top of the retention register: counts of everything held in the zone(s), whatever the filters are
  const sw = where(); sw.raw(zoneScope(req.user, 'p.zone_id', sw.params, req.query.zone_id)); sw.raw(`e.status = 'active'`);
  const stats = q.export ? null : (await pool.query(
    `SELECT COUNT(*)::int AS held, COUNT(*) FILTER (WHERE e.retention = 'permanent')::int AS life,
            COUNT(*) FILTER (WHERE e.retention = 'timed' AND e.retain_to <= now() + interval '7 days')::int AS ending7,
            COUNT(*) FILTER (WHERE e.retention = 'timed' AND e.retain_to <= now() + interval '30 days')::int AS ending30,
            COUNT(*) FILTER (WHERE e.ext_status = 'pending')::int AS pending
       ${EVID_FROM} ${sw.sql()}`, sw.params)).rows[0];
  res.json({ rows: rows.rows.map((r) => ({ ...r, checksum_check: ev.checksumCheck(r) })), total: total.rows[0].n, archive_bytes: total.rows[0].bytes, trains, mnvrs, stats });
}));

async function loadFlag(user, id) {
  const { rows } = await pool.query(`${ev.FLAG_SELECT} WHERE e.id = $1`, [id]);
  if (!rows.length || !canSeeZone(user, rows[0].zone_id)) throw notFound('flag not found');
  return rows[0];
}
router.get('/evidence/:id', wrap(async (req, res) => {
  const f = await loadFlag(req.user, parseId(req.params.id));
  const { rows: log } = await pool.query(`SELECT a.occurred_at, a.action, a.details, u.username AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     WHERE (a.entity = 'evidence_flag' AND a.entity_id = $1) OR (a.entity = 'delivered_footage' AND a.entity_id = $2) ORDER BY a.id`, [f.id, f.footage_id]);
  res.json({ flag: { ...f, checksum_check: ev.checksumCheck(f) }, custody: log });
}));
router.post('/evidence/:id/link', wrap(async (req, res) => {
  const f = await loadFlag(req.user, parseId(req.params.id));
  let heldBy = null;
  if (f.archive_status !== 'archived' || !f.archive_path) throw badRequest('this flag has no archived clip yet');
  if (!exists(absPath(f.archive_path))) { heldBy = await heldElsewhere(f.footage_id); if (!heldBy) throw badRequest('the archived clip is missing from the evidence store'); }
  const purpose = req.body && req.body.purpose === 'download' ? 'download' : 'view';
  const t = jwt.sign({ k: 'evidence', id: f.id, u: req.user.id, d: purpose === 'download' }, config.jwtSecret, { expiresIn: `${config.footageLinkMinutes}m`, issuer: 'cms-media' });
  await audit(null, { user: req.user, action: `console.evidence.${purpose}`, entity: 'evidence_flag', entityId: f.id, zoneId: f.zone_id, details: { sha256: f.archive_sha256, ...(heldBy ? { held_by: heldBy.name } : {}) } });
  const frag = purpose !== 'download' && f.copy_kind === 'whole' && f.section_start_s != null ? `#t=${f.section_start_s},${f.section_end_s}` : ''; // plays just the flagged section of the whole-file copy
  res.json({ url: `/media/evidence/${f.id}?t=${t}${frag}`, held_by: heldBy ? heldBy.name : null });
}));
router.post('/evidence/:id/retry-archive', wrap(async (req, res) => { await ev.retryArchive(req.user, parseId(req.params.id)); res.json({ ok: true }); }));
router.post('/evidence/:id/release', wrap(async (req, res) => { await ev.release(req.user, parseId(req.params.id), req.body && req.body.note); res.json({ ok: true }); }));
// Longer retention: a console user (operator or administrator) of the zone decides what an officer asked for, or extends directly.
// Re-hash the archived file and compare it with the record (and with the delivered file) - written to the audit trail.
router.post('/evidence/:id/verify', wrap(async (req, res) => { res.json(await ev.verify(req.user, parseId(req.params.id))); }));
router.post('/evidence/:id/extension/approve', wrap(async (req, res) => { await ev.decideExtension(req.user, parseId(req.params.id), true, req.body || {}); res.json({ ok: true }); }));
router.post('/evidence/:id/extension/reject', wrap(async (req, res) => { await ev.decideExtension(req.user, parseId(req.params.id), false, req.body || {}); res.json({ ok: true }); }));
router.post('/evidence/:id/extend', wrap(async (req, res) => { await ev.extend(req.user, parseId(req.params.id), req.body || {}); res.json({ ok: true }); }));

// ---- media (token authenticated; <video> cannot send headers) ----------------------------------
media.get('/:kind/:id', wrap(async (req, res) => {
  let p;
  try { p = jwt.verify(String(req.query.t || ''), config.jwtSecret, { issuer: 'cms-media' }); } catch (_) { throw unauthorized('link expired or invalid'); }
  const id = parseId(req.params.id);
  if (p.k !== req.params.kind || p.id !== id) throw unauthorized('link is not valid for this file');
  const { rows: u } = await pool.query(`SELECT status FROM users WHERE id = $1`, [p.u]);
  if (!u.length || u[0].status !== 'active') throw unauthorized('account not active');

  let rel; let format = 'mp4'; let sha = null; let name; let holder = id;
  if (p.k === 'footage') {
    const { rows } = await pool.query('SELECT storage_path, format, sha256 FROM delivered_footage WHERE id = $1', [id]);
    if (!rows.length) throw notFound('footage not found');
    ({ storage_path: rel, format, sha256: sha } = rows[0]); name = `footage-${id}.${String(format).toLowerCase()}`;
  } else {
    const { rows } = await pool.query(`SELECT archive_path, archive_sha256, footage_id FROM evidence_flag WHERE id = $1 AND archive_status = 'archived'`, [id]);
    if (!rows.length) throw notFound('archived clip not found');
    rel = rows[0].archive_path; sha = rows[0].archive_sha256; name = `evidence-${id}.mp4`; holder = rows[0].footage_id;
  }
  const file = absPath(rel);
  if (!exists(file)) {
    // not on this CMS's disk: it is on another CMS of the cluster - stream it from there, byte for byte
    const me = await cluster.self();
    if (me && cluster.nodeOfId(holder) !== me.node_no) {
      try { return await cluster.proxyMedia(req, res, cluster.nodeOfId(holder), p.k, id); } catch (e) { throw new HttpError(e.status || 502, e.message); }
    }
    throw notFound('file missing from the footage store');
  }
  serveFile(req, res, { file, size: fs.statSync(file).size, mime: mimeFor(format), download: !!p.d, filename: name, sha256: sha });
}));

module.exports = router;
module.exports.media = media;
