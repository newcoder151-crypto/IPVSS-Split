const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const config = require('../../config');
const { zoneScope, canSeeZone } = require('../../middleware/auth');
const ev = require('../../services/evidenceService');
const { absPath, exists, mimeFor } = require('../../services/fsutil');
const { serveFile } = require('../../services/mediaServe');
const { audit } = require('../../services/audit');
const { parseId, parseLimit, parseOffset, requireText, where } = require('../../services/util');
const { badRequest, notFound, unauthorized, wrap } = require('../../errors');
const fs = require('fs');

const router = express.Router();
const media = express.Router(); // mounted WITHOUT bearer auth: link-token authenticated

const FOOTAGE_LIST = `
  SELECT f.id, f.video_request_id AS request_id, f.format, f.sha256, f.file_size_bytes, f.duration_s, f.start_time, f.end_time, f.segment_count, f.delivered_at,
         p.id AS post_id, p.name AS post_name, p.zone_id, c.name AS camera_name, n.name AS nvr_name, n.train_no,
         r.window_start, r.window_end, r.reason,
         (SELECT COUNT(*) FROM evidence_flag e WHERE e.footage_id = f.id AND e.status = 'active') AS active_flags
    FROM delivered_footage f
    JOIN video_request r ON r.id = f.video_request_id JOIN rpf_post p ON p.id = r.post_id
    JOIN camera c ON c.id = r.camera_id JOIN nvr_unit n ON n.id = c.nvr_id`;

router.get('/footage', wrap(async (req, res) => {
  const w = where();
  w.raw(zoneScope(req.user, 'p.zone_id', w.params, req.query.zone_id));
  if (req.query.post_id) w.add('p.id = ?', Number(req.query.post_id));
  const limit = parseLimit(req.query.limit, 50, 200); const offset = parseOffset(req.query.offset);
  const [rows, total] = await Promise.all([
    pool.query(`${FOOTAGE_LIST} ${w.sql()} ORDER BY f.id DESC LIMIT ${limit} OFFSET ${offset}`, w.params),
    pool.query(`SELECT COUNT(*) AS n FROM delivered_footage f JOIN video_request r ON r.id=f.video_request_id JOIN rpf_post p ON p.id=r.post_id ${w.sql()}`, w.params)]);
  res.json({ rows: rows.rows, total: total.rows[0].n });
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
  if (!exists(absPath(rows[0].storage_path))) throw notFound('footage file is missing from the footage store');
  const t = jwt.sign({ k: 'footage', id: f.id, u: req.user.id, d: purpose === 'download' }, config.jwtSecret, { expiresIn: `${config.footageLinkMinutes}m`, issuer: 'cms-media' });
  await audit(null, { user: req.user, action: `console.footage.${purpose}`, entity: 'delivered_footage', entityId: f.id, zoneId: f.zone_id, details: { sha256: f.sha256 } });
  res.json({ url: `/media/footage/${f.id}?t=${t}`, format: f.format, playable: String(f.format).toLowerCase() === 'mp4' });
}));

// ---- evidence flags --------------------------------------------------------------------------
router.get('/evidence', wrap(async (req, res) => {
  const w = where();
  w.raw(zoneScope(req.user, 'p.zone_id', w.params, req.query.zone_id));
  const q = req.query;
  if (q.status) w.add('e.status = ?', q.status);
  if (q.archive_status) w.add('e.archive_status = ?', q.archive_status);
  if (q.retention) w.add('e.retention = ?', q.retention);
  if (q.post_id) w.add('p.id = ?', Number(q.post_id));
  const limit = parseLimit(q.limit, 50, 200); const offset = parseOffset(q.offset);
  const [rows, total] = await Promise.all([
    pool.query(`${ev.FLAG_SELECT} ${w.sql()} ORDER BY e.id DESC LIMIT ${limit} OFFSET ${offset}`, w.params),
    pool.query(`SELECT COUNT(*) AS n, COALESCE(SUM(e.archive_size_bytes),0) AS bytes FROM evidence_flag e JOIN delivered_footage f ON f.id=e.footage_id JOIN video_request r ON r.id=f.video_request_id JOIN rpf_post p ON p.id=r.post_id ${w.sql()}`, w.params)]);
  res.json({ rows: rows.rows, total: total.rows[0].n, archive_bytes: total.rows[0].bytes });
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
  res.json({ flag: f, custody: log });
}));
router.post('/evidence/:id/link', wrap(async (req, res) => {
  const f = await loadFlag(req.user, parseId(req.params.id));
  if (f.archive_status !== 'archived' || !exists(absPath(f.archive_path))) throw badRequest('this flag has no archived clip yet');
  const purpose = req.body && req.body.purpose === 'download' ? 'download' : 'view';
  const t = jwt.sign({ k: 'evidence', id: f.id, u: req.user.id, d: purpose === 'download' }, config.jwtSecret, { expiresIn: `${config.footageLinkMinutes}m`, issuer: 'cms-media' });
  await audit(null, { user: req.user, action: `console.evidence.${purpose}`, entity: 'evidence_flag', entityId: f.id, zoneId: f.zone_id, details: { sha256: f.archive_sha256 } });
  res.json({ url: `/media/evidence/${f.id}?t=${t}` });
}));
router.post('/evidence/:id/retry-archive', wrap(async (req, res) => { await ev.retryArchive(req.user, parseId(req.params.id)); res.json({ ok: true }); }));
router.post('/evidence/:id/release', wrap(async (req, res) => { await ev.release(req.user, parseId(req.params.id), req.body && req.body.note); res.json({ ok: true }); }));

// ---- media (token authenticated; <video> cannot send headers) ----------------------------------
media.get('/:kind/:id', wrap(async (req, res) => {
  let p;
  try { p = jwt.verify(String(req.query.t || ''), config.jwtSecret, { issuer: 'cms-media' }); } catch (_) { throw unauthorized('link expired or invalid'); }
  const id = parseId(req.params.id);
  if (p.k !== req.params.kind || p.id !== id) throw unauthorized('link is not valid for this file');
  const { rows: u } = await pool.query(`SELECT status FROM users WHERE id = $1`, [p.u]);
  if (!u.length || u[0].status !== 'active') throw unauthorized('account not active');

  let rel; let format = 'mp4'; let sha = null; let name;
  if (p.k === 'footage') {
    const { rows } = await pool.query('SELECT storage_path, format, sha256 FROM delivered_footage WHERE id = $1', [id]);
    if (!rows.length) throw notFound('footage not found');
    ({ storage_path: rel, format, sha256: sha } = rows[0]); name = `footage-${id}.${String(format).toLowerCase()}`;
  } else {
    const { rows } = await pool.query(`SELECT archive_path, archive_sha256 FROM evidence_flag WHERE id = $1 AND archive_status = 'archived'`, [id]);
    if (!rows.length) throw notFound('archived clip not found');
    rel = rows[0].archive_path; sha = rows[0].archive_sha256; name = `evidence-${id}.mp4`;
  }
  const file = absPath(rel);
  if (!exists(file)) throw notFound('file missing from the footage store');
  serveFile(req, res, { file, size: fs.statSync(file).size, mime: mimeFor(format), download: !!p.d, filename: name, sha256: sha });
}));

module.exports = router;
module.exports.media = media;
