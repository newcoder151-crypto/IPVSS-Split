const express = require('express');
const crypto = require('crypto');
const { pool, withTransaction } = require('../db');
const config = require('../config');
const { postScopeSql, canSeePost } = require('../services/scope');
const { audit } = require('../services/audit');
const { parseId, parseLimit } = require('../services/util');
const { badRequest, notFound, wrap } = require('../errors');

const router = express.Router();

const FLAG_SELECT = `
  SELECT e.id, e.footage_id, e.incident_id, e.retention, e.retain_from, e.retain_to, e.justification, e.status, e.flagged_at,
         e.section_start_s, e.section_end_s, e.section_from, e.section_to,
         e.archive_status, e.archive_size_bytes, e.archived_at, e.archive_sha256, e.archive_error, e.released_at, e.release_note,
         e.storage, (e.local_path IS NOT NULL) AS has_local, e.local_sha256, e.local_size_bytes, e.local_saved_at, e.local_error, e.local_path,
         u.username AS flagged_by_username,
         f.format, f.file_size_bytes, f.duration_s, r.id AS request_id, r.window_start, r.window_end,
         p.id AS post_id, p.name AS post_name, p.zone_id, c.name AS camera_name, n.name AS nvr_name
    FROM evidence_flag e
    JOIN users u ON u.id = e.flagged_by
    JOIN delivered_footage f ON f.id = e.footage_id
    JOIN video_request r ON r.id = f.video_request_id
    JOIN rpf_post p ON p.id = r.post_id
    JOIN camera c ON c.id = r.camera_id
    JOIN nvr_unit n ON n.id = c.nvr_id`;

/** GET /api/flags?post_id=&status=&limit= - evidence flags in scope, with footage details and archive state. */
router.get('/', wrap(async (req, res) => {
  const params = [];
  const where = [postScopeSql(req.user, 'p', params)];
  if (req.query.status) { params.push(String(req.query.status)); where.push(`e.status = $${params.length}`); }
  const limit = parseLimit(req.query.limit);
  const { rows } = await pool.query(`${FLAG_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ${limit}`, params);
  res.json(rows);
}));

/**
 * POST /api/flags/:id/access { purpose: 'view' | 'download', source?: 'cms' | 'local' }
 * source 'cms'   = the clip CMS archived to permanent storage
 * source 'local' = the copy this post saved locally
 * (default: CMS copy if it exists, else the local one). Same short-lived, audited link as any footage.
 */
router.post('/:id/access', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const purpose = req.body && req.body.purpose;
  if (!['view', 'download'].includes(purpose)) throw badRequest("purpose must be 'view' or 'download'");
  const { rows } = await pool.query(`${FLAG_SELECT} WHERE e.id = $1`, [id]);
  const f = rows[0];
  if (!f || !canSeePost(req.user, f.post_id, f.zone_id)) throw notFound('flag not found');
  let source = req.body.source;
  if (!['cms', 'local'].includes(source)) source = f.archive_status === 'archived' ? 'cms' : 'local';
  if (source === 'cms' && f.archive_status !== 'archived') throw badRequest(f.storage === 'local' ? 'this recording is kept locally only; CMS holds no copy' : f.archive_status === 'failed' ? 'CMS could not archive this flag yet - see its status' : 'the clip has not been archived by CMS yet; try again in a moment');
  if (source === 'local' && !f.has_local) throw badRequest(f.local_error ? `the local copy failed: ${f.local_error}` : 'no local copy was saved for this flag');

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + config.footageLinkMinutes * 60000);
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO video_access_grant (request_id, user_id, token_hash, expires_at, footage_id, flag_id, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [f.request_id, req.user.id, tokenHash, expiresAt, f.footage_id, f.id, source === 'local' ? `${purpose}_local` : purpose]);
    await audit(client, { user: req.user, action: `${purpose === 'view' ? 'evidence.view' : 'evidence.download'}${source === 'local' ? '.local' : ''}`, entity: 'evidence_flag', entityId: f.id, zoneId: f.zone_id,
      details: { footage_id: f.footage_id, source, sha256: source === 'local' ? f.local_sha256 : f.archive_sha256 } });
  });
  res.json({ url: `/api/media/${f.footage_id}?token=${token}${purpose === 'download' ? '&download=1' : ''}`, expires_at: expiresAt, format: 'MP4', playable: true, source });
}));

module.exports = router;
