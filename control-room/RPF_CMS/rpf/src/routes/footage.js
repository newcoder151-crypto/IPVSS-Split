const express = require('express');
const crypto = require('crypto');
const { pool, withTransaction } = require('../db');
const config = require('../config');
const { FOOTAGE_SELECT } = require('../services/requests');
const { resolveFootageFile, playableInBrowser, diagnose } = require('../services/storage');
const { postScopeSql, canSeePost } = require('../services/scope');
const { audit } = require('../services/audit');
const { parseId, parseLimit, parseTs, requireText } = require('../services/util');
const { HttpError, badRequest, notFound, conflict, wrap } = require('../errors');
const { hasFfmpeg } = require('../services/clip');
const localEvidence = require('../services/localEvidence');

const router = express.Router();

async function loadScoped(user, id) {
  const { rows } = await pool.query(`${FOOTAGE_SELECT} WHERE f.id = $1`, [id]);
  const f = rows[0];
  if (!f || !canSeePost(user, f.post_id, f.zone_id)) throw notFound('footage not found');
  return f;
}

/** GET /api/footage?limit= - footage CMS has delivered to the caller's scope. */
router.get('/', wrap(async (req, res) => {
  const params = [];
  const scope = postScopeSql(req.user, 'p', params);
  const limit = parseLimit(req.query.limit);
  const { rows } = await pool.query(`${FOOTAGE_SELECT} WHERE ${scope} ORDER BY f.id DESC LIMIT ${limit}`, params);
  res.json(rows.map((f) => ({ ...f, playable: playableInBrowser(f.format) })));
}));

router.get('/:id', wrap(async (req, res) => {
  const f = await loadScoped(req.user, parseId(req.params.id));
  const { rows: flags } = await pool.query(
    `SELECT e.id, e.retention, e.retain_from, e.retain_to, e.justification, e.status, e.flagged_at, u.username AS flagged_by_username,
            e.section_start_s, e.section_end_s, e.section_from, e.section_to, e.archive_status, e.archived_at
       FROM evidence_flag e JOIN users u ON u.id = e.flagged_by
      WHERE e.footage_id = $1 ORDER BY e.id DESC`,
    [f.id]
  );
  res.json({ footage: { ...f, playable: playableInBrowser(f.format) }, flags });
}));

/**
 * POST /api/footage/:id/access { purpose: 'view' | 'download', start_s?, end_s? }
 * Issues a short-lived link (a video_access_grant with only the token hash stored) and writes the
 * VIEW/DOWNLOAD entry to the audit log. Nothing is served without a grant, so nothing is served
 * without a log entry. With start_s/end_s a download is just that section of the file (stream-copied,
 * not re-encoded); the range is recorded in the audit entry.
 */
router.post('/:id/access', wrap(async (req, res) => {
  const f = await loadScoped(req.user, parseId(req.params.id));
  const body = req.body || {};
  const purpose = body.purpose;
  if (!['view', 'download'].includes(purpose)) throw badRequest("purpose must be 'view' or 'download'");

  let clip = null;
  if (body.start_s != null || body.end_s != null) {
    if (purpose !== 'download') throw badRequest('a section can only be requested for download');
    clip = parseSection(body.start_s, body.end_s, f.duration_s);
    if (!(await hasFfmpeg())) throw new HttpError(501, 'cutting a section needs ffmpeg on the RPF server; download the whole file instead');
  }

  // Fail here, clearly, if the file is not reachable from this host.
  const { rows: pathRows } = await pool.query('SELECT storage_path FROM delivered_footage WHERE id = $1', [f.id]);
  const file = await resolveFootageFile(pathRows[0].storage_path, f.sha256);
  if (!file) throw notFound(`footage file is not reachable from the RPF server [lookup v3] ${await diagnose(pathRows[0].storage_path)}`);

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + config.footageLinkMinutes * 60000);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO video_access_grant (request_id, user_id, token_hash, expires_at, footage_id, clip_start_s, clip_end_s, purpose)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [f.request_id, req.user.id, tokenHash, expiresAt, f.id, clip && clip.start, clip && clip.end, purpose]
    );
    await audit(client, {
      user: req.user, action: purpose === 'view' ? 'footage.view' : (clip ? 'footage.download.section' : 'footage.download'),
      entity: 'delivered_footage', entityId: f.id, zoneId: f.zone_id,
      details: { request_id: f.request_id, post_id: f.post_id, sha256: f.sha256, ...(clip ? { start_s: clip.start, end_s: clip.end } : {}) },
    });
  });

  res.json({
    url: `/api/media/${f.id}?token=${token}${purpose === 'download' ? '&download=1' : ''}`,
    expires_at: expiresAt, format: clip ? 'MP4' : f.format, playable: playableInBrowser(f.format), section: clip,
  });
}));

/** Offsets are seconds from the start of the delivered file. */
function parseSection(startRaw, endRaw, duration) {
  const start = Number(startRaw); const end = Number(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw badRequest('start_s and end_s must be numbers (seconds from the start of the file)');
  if (start < 0) throw badRequest('start_s cannot be negative');
  if (end <= start) throw badRequest('end_s must be after start_s');
  if (end - start < 1) throw badRequest('a section must be at least 1 second long');
  if (duration != null && start >= duration) throw badRequest(`start_s is beyond the end of the footage (${Math.round(duration)} s long)`);
  if (duration != null && end > duration + 0.5) throw badRequest(`end_s is beyond the end of the footage (${Math.round(duration)} s long)`);
  return { start: Math.round(start * 100) / 100, end: duration != null ? Math.min(Math.round(end * 100) / 100, duration) : Math.round(end * 100) / 100 };
}

/**
 * POST /api/footage/:id/flag { justification, retention: 'permanent' | 'timed', retain_to?, start_s?, end_s? }
 * Flags delivered footage - the whole file or one SECTION of it - for retention beyond the normal 30-day
 * policy (Cl. 3.15.6.2). retention 'permanent' keeps it for the life of the record; 'timed' keeps it until
 * retain_to (default DEFAULT_RETENTION_DAYS). CMS copies the section to permanent storage and its
 * retention job never deletes anything under an active flag. Justification is mandatory.
 */
router.post('/:id/flag', wrap(async (req, res) => {
  const f = await loadScoped(req.user, parseId(req.params.id));
  if (f.post_id !== req.user.post_id) throw notFound('footage not found');
  const body = req.body || {};
  const justification = requireText(body.justification, 'justification');
  const retention = body.retention === 'permanent' ? 'permanent' : 'timed';
  const storage = ['cms', 'local', 'both'].includes(body.storage) ? body.storage : 'cms';   // where the recording is kept

  const from = new Date();
  let to = null;
  if (retention === 'timed') {
    to = body.retain_to ? parseTs(body.retain_to, 'retain_to') : new Date(from.getTime() + config.defaultRetentionDays * 86400000);
    if (to <= from) throw badRequest('retain_to is already in the past');
  }

  let section = null;
  if (body.start_s != null || body.end_s != null) section = parseSection(body.start_s, body.end_s, f.duration_s);
  const base = f.start_time ? new Date(f.start_time) : new Date(f.window_start);
  const sectionFrom = section ? new Date(base.getTime() + section.start * 1000) : null;
  const sectionTo = section ? new Date(base.getTime() + section.end * 1000) : null;

  // A local copy is made BEFORE the flag row is written, so a failure (no ffmpeg, file missing) leaves nothing half-flagged.
  let tmpLocal = null;
  if (storage !== 'cms') {
    const { rows: sp } = await pool.query('SELECT id, storage_path FROM delivered_footage WHERE id = $1', [f.id]);
    tmpLocal = await localEvidence.prepare(sp[0], section);
  }

  let flag;
  try { flag = await withTransaction(async (client) => {
    const { rows: dup } = await client.query(
      `SELECT id FROM evidence_flag WHERE footage_id = $1 AND status = 'active'
          AND section_start_s IS NOT DISTINCT FROM $2 AND section_end_s IS NOT DISTINCT FROM $3 AND retention = $4 AND storage = $5 LIMIT 1`,
      [f.id, section && section.start, section && section.end, retention, storage]);
    if (dup.length) throw conflict(`flag #${dup[0].id} already covers exactly this ${section ? 'section' : 'footage'}`);

    const { rows: link } = await client.query(
      `SELECT r.incident_id AS rid, (SELECT i.id FROM incident i JOIN alert_delivery d ON d.id = i.alert_delivery_id
                                      WHERE d.alert_id = r.alert_id AND i.post_id = r.post_id ORDER BY i.id LIMIT 1) AS via_alert
         FROM video_request r WHERE r.id = $1`, [f.request_id]);
    const incidentId = link[0].rid || link[0].via_alert || null;

    const { rows } = await client.query(
      `INSERT INTO evidence_flag (footage_id, retention, retain_from, retain_to, justification, flagged_by, section_start_s, section_end_s, section_from, section_to, incident_id, storage, archive_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, retention, retain_from, retain_to, status, flagged_at, archive_status, storage`,
      [f.id, retention, from, to, justification, req.user.id, section && section.start, section && section.end, sectionFrom, sectionTo, incidentId, storage, storage === 'local' ? 'not_requested' : 'pending']);
    await audit(client, {
      user: req.user, action: 'footage.flag', entity: 'evidence_flag', entityId: rows[0].id, zoneId: f.zone_id,
      details: { footage_id: f.id, retention, retain_to: to, storage, section, incident_id: incidentId },
    });
    return rows[0];
  }); } catch (e) { if (tmpLocal) localEvidence.discard(tmpLocal); throw e; }

  // Local copy: move it into the post's store and record where it is. Failure here is reported, never hidden.
  let localError = null;
  if (tmpLocal) {
    try {
      const cam = await pool.query(`SELECT c.name AS camera_name, n.name AS nvr_name, n.train_no, u.username FROM video_request r JOIN camera c ON c.id = r.camera_id JOIN nvr_unit n ON n.id = c.nvr_id JOIN users u ON u.id = $2 WHERE r.id = $1`, [f.request_id, req.user.id]);
      const saved = await localEvidence.finalize(tmpLocal, flag, {
        post_id: f.post_id, post_name: f.post_name, footage_id: f.id, request_id: f.request_id, incident_id: null,
        camera: cam.rows[0] && cam.rows[0].camera_name, nvr: cam.rows[0] && cam.rows[0].nvr_name, train_no: cam.rows[0] && cam.rows[0].train_no,
        footage_start: f.start_time || f.window_start, section_start_s: section && section.start, section_end_s: section && section.end,
        section_from: sectionFrom, section_to: sectionTo,
        // everything the officer entered at the RPF
        entered: { retention, retain_until: to, storage, justification, flagged_by: cam.rows[0] && cam.rows[0].username, flagged_at: flag.flagged_at },
        source_footage_sha256: f.sha256,
      });
      await pool.query(`UPDATE evidence_flag SET local_path = $2, local_sha256 = $3, local_size_bytes = $4, local_saved_at = now(), local_error = NULL WHERE id = $1`, [flag.id, saved.rel, saved.sha256, saved.size]);
      await audit(null, { user: req.user, action: 'evidence.local_save', entity: 'evidence_flag', entityId: flag.id, zoneId: f.zone_id, details: { path: saved.rel, size: saved.size, sha256: saved.sha256 } });
      flag.local_saved = true;
    } catch (e) {
      localEvidence.discard(tmpLocal);
      localError = String(e.message).slice(0, 300);
      await pool.query(`UPDATE evidence_flag SET local_error = $2 WHERE id = $1`, [flag.id, localError]).catch(() => {});
    }
  }
  res.status(201).json({ ...flag, local_error: localError });
}));

module.exports = router;
