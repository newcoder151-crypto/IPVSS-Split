/**
 * GET /api/media/:id?token=...[&download=1]
 * Authenticated by a short-lived grant token (a <video> tag cannot send an
 * Authorization header). Supports HTTP Range so the browser can seek.
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { pool } = require('../db');
const path = require('path');
const { resolveFootageFile, mimeFor, diagnose } = require('../services/storage');
const { clipFile } = require('../services/clip');
const localEvidence = require('../services/localEvidence');
const { canSeePost } = require('../services/scope');
const { audit } = require('../services/audit');
const { parseId } = require('../services/util');
const { HttpError, unauthorized, notFound, wrap } = require('../errors');

const router = express.Router();

router.get('/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const token = String(req.query.token || '');
  if (!/^[0-9a-f]{64}$/.test(token)) throw unauthorized('missing or malformed link token');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const { rows } = await pool.query(
    `SELECT g.user_id, g.flag_id, g.purpose, g.clip_start_s, g.clip_end_s, f.id, f.storage_path, f.format, f.sha256, f.video_request_id, r.post_id, p.zone_id,
            u.role AS user_role, u.post_id AS user_post, u.status AS user_status
       FROM video_access_grant g
       JOIN delivered_footage f ON f.video_request_id = g.request_id AND f.id = $2
       JOIN video_request r ON r.id = f.video_request_id
       JOIN rpf_post p ON p.id = r.post_id
       JOIN users u ON u.id = g.user_id
      WHERE g.token_hash = $1 AND g.revoked_at IS NULL AND g.expires_at > now()`,
    [tokenHash, id]
  );
  const g = rows[0];
  if (!g || g.user_status !== 'active') throw unauthorized('link expired or not valid for this footage');
  if (g.user_role !== 'post_user' || !canSeePost({ post_id: g.user_post }, g.post_id)) throw notFound('footage not found');

  let file; let sha256 = g.sha256; let format = g.format;
  if (g.flag_id) { // the archived evidence clip of a flag
    if (String(g.purpose).endsWith('_local')) { // the copy this post saved locally
      const { rows: lr } = await pool.query(`SELECT local_path, local_sha256 FROM evidence_flag WHERE id = $1 AND local_path IS NOT NULL`, [g.flag_id]);
      if (!lr.length) throw notFound('local copy not found');
      const abs = localEvidence.localAbs(lr[0].local_path);
      if (!localEvidence.exists(abs)) throw notFound('the local copy is missing from the local evidence store');
      file = { file: abs, size: fs.statSync(abs).size };
      sha256 = lr[0].local_sha256; format = 'MP4';
    } else {
      const { rows: fr } = await pool.query(`SELECT archive_path, archive_sha256 FROM evidence_flag WHERE id = $1 AND archive_status = 'archived'`, [g.flag_id]);
      if (!fr.length) throw notFound('archived clip not found');
      file = await resolveFootageFile(fr[0].archive_path, fr[0].archive_sha256);
      sha256 = fr[0].archive_sha256; format = 'MP4';
    }
  } else {
    file = await resolveFootageFile(g.storage_path, g.sha256);
  }
  if (!file) throw notFound(`footage file is not reachable from the RPF server [lookup v3] ${await diagnose(g.storage_path)}`);
  if (!g.flag_id && g.clip_start_s != null) { // a section of the delivered file
    try {
      const clip = await clipFile(file.file, g.id, g.clip_start_s, g.clip_end_s);
      file = { file: clip.file, size: clip.size, name: `footage-${g.id}-${Math.round(g.clip_start_s)}s-${Math.round(g.clip_end_s)}s.mp4` };
      sha256 = clip.sha256; format = 'MP4';
    } catch (e) {
      if (e.status) throw new HttpError(e.status, e.message);
      console.error('clip failed:', e.stderr || e.message);
      throw new HttpError(500, 'could not cut that section out of the footage');
    }
  } else if (g.flag_id) file = { ...file, name: `evidence-flag-${g.flag_id}.mp4` };

  const download = req.query.download === '1';
  const mime = mimeFor(format);
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Content-SHA256': sha256, // lets the recipient verify the file against the recorded hash
  };
  if (download) {
    headers['Content-Disposition'] = `attachment; filename="${file.name.replace(/[^\w.\-]/g, '_')}"`;
  }

  let start = 0;
  let end = file.size - 1;
  const range = req.get('range');
  let status = 200;
  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (m[1] === '' && m[2] === '')) throw new HttpError(416, 'malformed range');
    if (m[1] === '') { // suffix range: last N bytes
      start = Math.max(0, file.size - Number(m[2]));
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(Number(m[2]), file.size - 1);
    }
    if (start > end || start >= file.size) {
      res.set('Content-Range', `bytes */${file.size}`);
      throw new HttpError(416, 'range not satisfiable');
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
  }
  headers['Content-Length'] = end - start + 1;

  // A completed download is a chain-of-custody event of its own.
  if (download && status === 200) {
    await audit(null, {
      user: { id: g.user_id, zone_id: g.user_zone }, action: 'footage.download.served',
      entity: 'delivered_footage', entityId: g.id, zoneId: g.zone_id, details: { ip: req.ip, ...(g.flag_id ? { flag_id: g.flag_id } : {}), ...(g.clip_start_s != null ? { start_s: g.clip_start_s, end_s: g.clip_end_s } : {}) },
    });
  }

  res.writeHead(status, headers);
  fs.createReadStream(file.file, { start, end }).on('error', () => res.destroy()).pipe(res);
}));

module.exports = router;
