const express = require('express');
const crypto = require('crypto');
const { pool, withTransaction } = require('../db');
const config = require('../config');
const { postScopeSql, canSeePost } = require('../services/scope');
const { audit } = require('../services/audit');
const { parseId, parseLimit, parseTs, requireText, rangeSql, likeSql, trainSql, mnvrSql } = require('../services/util');
const { badRequest, notFound, conflict, wrap } = require('../errors');
const checksumCheck = require('../services/checksumCheck');
const { auditText } = require('../services/incidentTrail');
const { localAbs, exists, sha256File, replaceLocal } = require('../services/localEvidence');
const { resolveFootageFile } = require('../services/storage');

const router = express.Router();

const FLAG_SELECT = `
  SELECT e.id, e.footage_id, e.incident_id, e.retention, e.retain_from, e.retain_to, e.justification, e.status, e.flagged_at,
         e.section_start_s, e.section_end_s, e.section_from, e.section_to, e.copy_kind,
         e.archive_status, e.archive_size_bytes, e.archived_at, e.archive_sha256, e.archive_error, e.released_at, e.release_note,
         e.storage, (e.local_path IS NOT NULL) AS has_local, e.local_sha256, e.local_size_bytes, e.local_saved_at, e.local_error, e.local_path,
         u.username AS flagged_by_username,
         CASE WHEN e.retention = 'permanent' OR e.retain_to IS NULL THEN NULL ELSE CEIL(EXTRACT(EPOCH FROM (e.retain_to - now())) / 86400.0)::int END AS days_left,
         e.ext_status, e.ext_retention, e.ext_retain_to, e.ext_justification, e.ext_requested_at, e.ext_decided_at, e.ext_decision_note, ux.username AS ext_requested_by_username, ud.username AS ext_decided_by_username,
         f.sha256 AS footage_sha256, f.end_time AS footage_end, f.file_name,
         f.format, f.file_size_bytes, f.duration_s, r.id AS request_id, r.window_start, r.window_end,
         p.id AS post_id, p.name AS post_name, p.zone_id, c.name AS camera_name, n.name AS nvr_name, COALESCE(f.train_no, n.train_no) AS train_no, n.mnvr_uid, COALESCE(f.unit_no, n.unit_no, n.id) AS unit_no, COALESCE(f.camera_no, c.mnvr_camera_id, c.id) AS camera_no, f.start_time AS footage_start, f.train_request_id
    FROM evidence_flag e
    JOIN users u ON u.id = e.flagged_by
    LEFT JOIN users ux ON ux.id = e.ext_requested_by
    LEFT JOIN users ud ON ud.id = e.ext_decided_by
    JOIN delivered_footage f ON f.id = e.footage_id
    JOIN video_request r ON r.id = f.video_request_id
    JOIN rpf_post p ON p.id = r.post_id
    JOIN camera c ON c.id = r.camera_id
    JOIN nvr_unit n ON n.id = c.nvr_id`;

const TRAIN_COL = 'COALESCE(f.train_no, n.train_no)';
const MNVR = { uid: 'n.mnvr_uid', name: 'n.name', no: 'COALESCE(f.unit_no, n.unit_no, n.id)' };

/**
 * GET /api/flags?status=&kept=permanent|timed&expiring=<days>&ext=pending&storage=&q=&train_no=&from=&to=&date_by=recorded|flagged&sort=new|old|expiry&limit=
 * Evidence flags of this post, with footage details, archive state, SHA-256 checksums and the days of retention left.
 * `q` also matches a SHA-256 (or its beginning). `expiring=30` = timed retentions that end within 30 days.
 */
router.get('/', wrap(async (req, res) => {
  const params = [];
  const where = [postScopeSql(req.user, 'p', params)];
  const q = req.query;
  if (q.status) { params.push(String(q.status)); where.push(`e.status = $${params.length}`); }
  if (['permanent', 'timed'].includes(q.kept)) { params.push(q.kept); where.push(`e.retention = $${params.length}`); }
  if (['cms', 'local', 'both'].includes(q.storage)) { params.push(q.storage); where.push(`e.storage = $${params.length}`); }
  if (q.ext === 'pending') where.push(`e.ext_status = 'pending'`);
  const exp = Number(q.expiring);
  if (Number.isInteger(exp) && exp > 0) { params.push(Math.min(exp, 36500)); where.push(`(e.retain_to IS NOT NULL AND e.retain_to <= now() + make_interval(days => $${params.length}))`); }
  trainSql(where, params, q.train_no, TRAIN_COL);
  mnvrSql(where, params, q.mnvr, MNVR);
  rangeSql(where, params, q.from, q.to, q.date_by === 'flagged' ? 'e.flagged_at' : 'COALESCE(f.start_time, r.window_start)');
  likeSql(where, params, q.q, ['e.id', 'e.justification', 'e.archive_sha256', 'e.local_sha256', 'f.sha256', 'c.name', 'n.name', 'n.mnvr_uid', TRAIN_COL]);
  const ORDER = { new: 'e.id DESC', old: 'e.id ASC', expiry: 'e.retain_to ASC NULLS LAST, e.id DESC' };
  const limit = parseLimit(q.limit);
  const { rows } = await pool.query(`${FLAG_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${ORDER[q.sort] || ORDER.new} LIMIT ${limit}`, params);
  res.json(rows.map((r) => ({ ...r, checksum_check: checksumCheck(r) })));
}));

const MAX_DAYS = () => config.maxRetentionDays;
const fmtD = (d) => new Date(d).toISOString().slice(0, 10);

/** GET /api/flags/:id/history - everything that happened to this retained recording, oldest first (who did what, on which side). */
router.get('/:id/history', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query(`${FLAG_SELECT} WHERE e.id = $1`, [id]);
  const f = rows[0];
  if (!f || !canSeePost(req.user, f.post_id, f.zone_id)) throw notFound('flag not found');
  const { rows: log } = await pool.query(
    `SELECT a.occurred_at, a.action, a.details, u.username AS actor, u.post_id AS actor_post FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.entity = 'evidence_flag' AND a.entity_id = $1 ORDER BY a.occurred_at, a.id`, [id]);
  const events = [{ at: f.flagged_at, title: `Flagged (${f.retention === 'permanent' ? 'kept for life' : `kept until ${new Date(f.retain_to).toISOString().slice(0, 10)}`})`, body: f.justification, actor: f.flagged_by_username, side: 'post', tone: '', icon: 'flag' }];
  for (const a of log) {
    if (a.actor_post != null && a.actor_post !== f.post_id) continue;
    const t = auditText(a);
    if (!t) continue;
    events.push({ at: a.occurred_at, title: t[0], body: t[1] || null, tone: t[2] || '', icon: t[3] || 'clock', actor: a.actor, side: !a.actor ? 'system' : a.actor_post ? 'post' : 'cms' });
  }
  res.json(events);
}));

/**
 * POST /api/flags/:id/verify { repair?: true }
 * Re-hashes the post's own copy of the evidence and compares it with the CMS archive copy (or the delivered file for a whole
 * recording). With repair=true a post copy that differs is REPLACED by the CMS archive copy (which is the authoritative one: it was
 * hashed at the data centre). Everything is written to the audit trail.
 */
router.post('/:id/verify', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query(`${FLAG_SELECT} WHERE e.id = $1`, [id]);
  const f = rows[0];
  if (!f || !canSeePost(req.user, f.post_id, f.zone_id)) throw notFound('flag not found');
  if (!f.local_path) throw conflict('this flag has no copy saved at the post');
  const abs = localAbs(f.local_path);
  const whole = f.section_start_s == null || f.copy_kind === 'whole';
  const want = whole ? f.footage_sha256 : f.archive_sha256; // what the local copy must equal
  const checks = [];
  let actual = exists(abs) ? await sha256File(abs) : null;
  if (!actual) checks.push({ ok: false, text: "The post's copy is MISSING from the local evidence folder" });
  else checks.push({ ok: actual === f.local_sha256, text: actual === f.local_sha256 ? "The post's copy still matches the SHA-256 recorded when it was saved" : "The post's copy has CHANGED since it was saved (SHA-256 differs from the record)" });
  if (want) checks.push({ ok: actual === want, text: actual === want ? (whole ? 'It is identical to the delivered file' : "It is identical to the CMS copy of the section") : (whole ? 'It is NOT identical to the delivered file' : 'It is NOT identical to the CMS copy of the section') });
  else checks.push({ ok: null, text: 'The CMS has not archived this flag yet, so there is nothing to compare with' });
  let repaired = false;
  if (req.body && req.body.repair && want && actual !== want) {
    let src = null;
    if (whole) { // repair from the delivered file itself (its checksum is the reference)
      const dp = (await pool.query('SELECT storage_path FROM delivered_footage WHERE id = $1', [f.footage_id])).rows[0];
      src = dp ? await resolveFootageFile(dp.storage_path, f.footage_sha256) : null;
    } else if (f.archive_status === 'archived') src = await resolveFootageFile(f.archive_path || `archive/zone-${f.zone_id}/flag-${id}.mp4`, f.archive_sha256);
    const from = src && src.file;
    if (!from) throw conflict('the CMS archive copy cannot be reached from this post, so the local copy cannot be repaired automatically');
    const fixedSha = await replaceLocal(abs, from);
    if (fixedSha !== want) throw conflict('the source copy itself does not match its recorded checksum - tell CMS');
    await withTransaction(async (client) => {
      await client.query(`UPDATE evidence_flag SET local_sha256 = $2, local_size_bytes = $3, local_saved_at = now(), local_error = NULL WHERE id = $1`, [id, fixedSha, require('fs').statSync(abs).size]);
      await audit(client, { user: req.user, action: 'evidence.local_resync', entity: 'evidence_flag', entityId: id, zoneId: f.zone_id, details: { from_sha256: actual, to_sha256: fixedSha } });
    });
    actual = fixedSha; repaired = true;
    checks.length = 0;
    checks.push({ ok: true, text: "The post's copy was replaced by the CMS archive copy and now matches" });
  }
  const ok = checks.every((c) => c.ok !== false);
  await audit(null, { user: req.user, action: 'evidence.verify', entity: 'evidence_flag', entityId: id, zoneId: f.zone_id, details: { ok, result: ok ? (repaired ? 'repaired' : 'passed') : 'FAILED', text: checks.map((c) => c.text).join('; '), sha256: actual } });
  res.json({ ok, repaired, actual, checks });
}));

/**
 * POST /api/flags/:id/extend { justification, retention?: 'permanent', add_days? | retain_to? }
 * The officer ASKS CMS to keep a flagged recording longer: N more days (counted from the current end), until a new date,
 * or for life. Nothing changes until a CMS administrator approves; the post is told the decision. One request at a time.
 */
router.post('/:id/extend', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body || {};
  const why = requireText(body.justification, 'justification');
  const { rows } = await pool.query(`${FLAG_SELECT} WHERE e.id = $1`, [id]);
  const f = rows[0];
  if (!f || !canSeePost(req.user, f.post_id, f.zone_id)) throw notFound('flag not found');
  if (f.status !== 'active') throw conflict('this flag is no longer active, so its retention cannot be extended');
  if (f.retention === 'permanent') throw conflict('this recording is already kept for life');
  if (f.ext_status === 'pending') throw conflict('a request for this recording is already waiting for CMS to decide');
  const cur = new Date(f.retain_to);
  if (cur <= new Date()) throw conflict('the retention period has already ended');

  let retention = 'timed'; let to = null;
  if (body.retention === 'permanent') retention = 'permanent';
  else if (body.add_days != null && body.add_days !== '') {
    const n = Number(body.add_days);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS()) throw badRequest(`the number of days must be a whole number from 1 to ${MAX_DAYS()}`);
    to = new Date(cur.getTime() + n * 86400000);
  } else to = parseTs(body.retain_to, 'the new retention date');
  if (to && to <= cur) throw badRequest(`the new date must be after the current end of retention (${fmtD(cur)})`);
  if (to && to > new Date(Date.now() + MAX_DAYS() * 86400000)) throw badRequest(`the retention cannot be longer than ${MAX_DAYS()} days; ask for "for life" instead`);

  await withTransaction(async (client) => {
    const up = await client.query(
      `UPDATE evidence_flag SET ext_status='pending', ext_retention=$2, ext_retain_to=$3, ext_justification=$4, ext_requested_by=$5, ext_requested_at=now(),
              ext_decided_by=NULL, ext_decided_at=NULL, ext_decision_note=NULL
        WHERE id=$1 AND status='active' AND ext_status IS DISTINCT FROM 'pending'`,
      [id, retention, to, why, req.user.id]);
    if (!up.rowCount) throw conflict('a request for this recording is already waiting for CMS to decide');
    await audit(client, { user: req.user, action: 'evidence.extend_request', entity: 'evidence_flag', entityId: id, zoneId: f.zone_id,
      details: { from: `until ${fmtD(cur)}`, to: retention === 'permanent' ? 'for life' : `until ${fmtD(to)}`, justification: why } });
  });
  const { rows: out } = await pool.query(`${FLAG_SELECT} WHERE e.id = $1`, [id]);
  res.status(201).json(out[0]);
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
  // a whole-file copy of a flagged section plays just the section (media fragment); a download is always the whole, checksum-identical file
  const frag = purpose !== 'download' && f.copy_kind === 'whole' && f.section_start_s != null ? `#t=${f.section_start_s},${f.section_end_s}` : '';
  res.json({ url: `/api/media/${f.footage_id}?token=${token}${purpose === 'download' ? '&download=1' : ''}${frag}`, expires_at: expiresAt, format: 'MP4', playable: true, source });
}));

module.exports = router;
