const fs = require('fs');
const { pool, withTransaction } = require('../db');
const { badRequest, notFound, conflict } = require('../errors');
const { parseTs } = require('./util');
const { audit } = require('./audit');
const notify = require('./notify');
const { absPath, exists, sha256File, ensureDir } = require('./fsutil');
const { cutClip } = require('./footageService');
const { canSeeZone } = require('../middleware/auth');
const checksumCheck = require('./checksumCheck');

const FLAG_SELECT = `
  SELECT e.id, e.footage_id, e.incident_id, e.retention, e.retain_from, e.retain_to, e.justification, e.status, e.flagged_at,
         e.section_start_s, e.section_end_s, e.section_from, e.section_to, e.copy_kind,
         e.archive_status, e.archive_path, e.archive_sha256, e.archive_size_bytes, e.archived_at, e.archive_error,
         e.released_at, e.release_note,
         CASE WHEN e.retention = 'permanent' OR e.retain_to IS NULL THEN NULL ELSE CEIL(EXTRACT(EPOCH FROM (e.retain_to - now())) / 86400.0)::int END AS days_left,
         e.ext_status, e.ext_retention, e.ext_retain_to, e.ext_justification, e.ext_requested_at, e.ext_decided_at, e.ext_decision_note, ux.username AS ext_requested_by_username, ud.username AS ext_decided_by_username,
         f.sha256 AS footage_sha256, f.end_time AS footage_end, f.file_name, e.storage, e.local_sha256, e.local_size_bytes, e.local_saved_at, e.local_error, (e.local_path IS NOT NULL) AS has_local, e.local_path, uf.username AS flagged_by_username, ur.username AS released_by_username,
         f.format, f.file_size_bytes, f.duration_s, r.id AS request_id, r.window_start, r.window_end,
         p.id AS post_id, p.name AS post_name, p.zone_id, c.id AS camera_id, c.name AS camera_name, n.name AS nvr_name, COALESCE(f.train_no, n.train_no) AS train_no, n.mnvr_uid, COALESCE(f.unit_no, n.unit_no, n.id) AS unit_no, COALESCE(f.camera_no, c.mnvr_camera_id, c.id) AS camera_no, f.start_time AS footage_start, f.train_request_id
    FROM evidence_flag e
    JOIN users uf ON uf.id = e.flagged_by
    LEFT JOIN users ur ON ur.id = e.released_by
    LEFT JOIN users ux ON ux.id = e.ext_requested_by
    LEFT JOIN users ud ON ud.id = e.ext_decided_by
    JOIN delivered_footage f ON f.id = e.footage_id
    JOIN video_request r ON r.id = f.video_request_id
    JOIN rpf_post p ON p.id = r.post_id
    JOIN camera c ON c.id = r.camera_id
    JOIN nvr_unit n ON n.id = c.nvr_id`;

/**
 * Copy the flagged section of a delivered file into permanent evidence storage, stream-copied (never
 * re-encoded) and hashed. Pending flags are picked up by the archive worker; failures stay visible
 * ('failed' + error) and can be retried from the console.
 */
async function archiveFlag(id) {
  const { rows } = await pool.query(
    `SELECT e.id, e.status, e.section_start_s, e.section_end_s, e.copy_kind, f.storage_path, p.zone_id, p.id AS post_id
       FROM evidence_flag e JOIN delivered_footage f ON f.id = e.footage_id JOIN video_request r ON r.id = f.video_request_id
       JOIN rpf_post p ON p.id = r.post_id
      WHERE e.id = $1`, [id]);
  const e = rows[0];
  if (!e || e.status !== 'active') return;
  const rel = `archive/zone-${e.zone_id}/flag-${id}.mp4`;
  try {
    const src = absPath(e.storage_path);
    if (!exists(src)) throw new Error('the delivered footage file is missing from the footage store');
    const dst = absPath(rel);
    // 'whole' (default): a byte-for-byte copy of the delivered file, so its SHA-256 equals the delivered file's. 'section' = the older cut-out.
    if (e.section_start_s != null && e.copy_kind === 'section') await cutClip(src, dst, e.section_start_s, e.section_end_s);
    else { ensureDir(dst); fs.copyFileSync(src, dst); }
    const sha = await sha256File(dst);
    const size = fs.statSync(dst).size;
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE evidence_flag SET archive_status='archived', archive_path=$2, archive_sha256=$3, archive_size_bytes=$4, archived_at=now(), archive_error=NULL WHERE id=$1`,
        [id, rel, sha, size]);
      await audit(client, { user: null, action: 'evidence.archive', entity: 'evidence_flag', entityId: id, zoneId: e.zone_id, details: { path: rel, size, sha256: sha } });
      await notify.send(client, { zone_id: e.zone_id, post_id: e.post_id, kind: 'evidence', ref_entity: 'evidence_flag', ref_id: id, title: `Evidence flag #${id} archived to the data centre`, body: 'The flagged section is stored safely and will not be deleted by the retention job.' });
    });
  } catch (err) {
    await pool.query(`UPDATE evidence_flag SET archive_status='failed', archive_error=$2 WHERE id=$1`, [id, String(err.message).slice(0, 500)]);
    await audit(null, { user: null, action: 'evidence.archive_failed', entity: 'evidence_flag', entityId: id, zoneId: e.zone_id, details: { error: err.message } });
  }
}

async function archivePending() {
  const { rows } = await pool.query(`SELECT id FROM evidence_flag WHERE archive_status = 'pending' AND status = 'active' AND cms_owns_strict(footage_id) ORDER BY id LIMIT 20`);
  for (const { id } of rows) await archiveFlag(id);
  return `${rows.length} flag(s) archived`;
}

async function retryArchive(user, id) {
  const { rows } = await pool.query(`${FLAG_SELECT} WHERE e.id = $1`, [id]);
  if (!rows.length || !canSeeZone(user, rows[0].zone_id)) throw notFound('flag not found');
  if (rows[0].status !== 'active') throw conflict('flag is not active');
  await pool.query(`UPDATE evidence_flag SET archive_status='pending', archive_error=NULL WHERE id=$1 AND archive_status IN ('failed','pending')`, [id]);
  await audit(null, { user, action: 'evidence.retry_archive', entity: 'evidence_flag', entityId: id, zoneId: rows[0].zone_id });
  await archiveFlag(id);
}

/** Zone/super admin ends a retention hold. The archived clip is kept (evidence is never deleted automatically). */
async function release(user, id, note) {
  if (!note || !String(note).trim()) throw badRequest('a note is required to release an evidence flag');
  const { rows } = await pool.query(`${FLAG_SELECT} WHERE e.id = $1`, [id]);
  if (!rows.length || !canSeeZone(user, rows[0].zone_id)) throw notFound('flag not found');
  const f = rows[0];
  if (f.status !== 'active') throw conflict('flag is already released');
  await withTransaction(async (client) => {
    await client.query(`UPDATE evidence_flag SET status='released', released_by=$2, released_at=now(), release_note=$3,
       ext_status = CASE WHEN ext_status = 'pending' THEN 'rejected' ELSE ext_status END, ext_decided_by = CASE WHEN ext_status = 'pending' THEN $2 ELSE ext_decided_by END, ext_decided_at = CASE WHEN ext_status = 'pending' THEN now() ELSE ext_decided_at END, ext_decision_note = CASE WHEN ext_status = 'pending' THEN 'the flag was released' ELSE ext_decision_note END WHERE id=$1`, [id, user.id, String(note).trim().slice(0, 500)]);
    await audit(client, { user, action: 'evidence.release', entity: 'evidence_flag', entityId: id, zoneId: f.zone_id, details: { note, retention: f.retention } });
    await notify.send(client, { zone_id: f.zone_id, post_id: f.post_id, kind: 'evidence', ref_entity: 'evidence_flag', ref_id: id, title: `Evidence flag #${id} was released by CMS`, body: String(note).trim() });
  });
}


// ---------------------------------------------------------------------------------------------------------------
// Longer retention. The RPF officer ASKS (writes the ext_* request columns itself); a CMS administrator decides here.
// ---------------------------------------------------------------------------------------------------------------
const DAY_MS = 86400000;
const MAX_DAYS = 36500;
const fmtD = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * The new end of a retention as one of: { retention: 'permanent' } | { add_days: N } (N days after the CURRENT end) | { retain_to: date }.
 * Only ever LONGER than now: shortening is what "release" is for. Returns { retention, retain_to }.
 */
function newEnd(flag, body) {
  if (flag.retention === 'permanent') throw conflict('this recording is already kept for life');
  const cur = new Date(flag.retain_to);
  if (body.retention === 'permanent') return { retention: 'permanent', retain_to: null };
  let to;
  if (body.add_days != null && body.add_days !== '') {
    const n = Number(body.add_days);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw badRequest(`the number of days must be a whole number from 1 to ${MAX_DAYS}`);
    to = new Date(Math.max(cur.getTime(), Date.now()) + n * DAY_MS);
  } else to = parseTs(body.retain_to, 'the new retention date');
  if (to <= cur) throw badRequest(`the new date must be after the current end of retention (${fmtD(cur)})`);
  if (to <= new Date()) throw badRequest('the new date is already in the past');
  return { retention: 'timed', retain_to: to };
}

async function loadForDecision(user, id) {
  const { rows } = await pool.query(`${FLAG_SELECT} WHERE e.id = $1`, [id]);
  if (!rows.length || !canSeeZone(user, rows[0].zone_id)) throw notFound('flag not found');
  return rows[0];
}

const endText = (e) => (e.retention === 'permanent' ? 'for life' : `until ${fmtD(e.retain_to)}`);

/** Approve a pending request (optionally with another date or "for life"), or reject it. A note is required to reject. */
async function decideExtension(user, id, approve, body = {}) {
  const f = await loadForDecision(user, id);
  if (f.ext_status !== 'pending') throw conflict('there is no pending retention request on this flag');
  if (f.status !== 'active') throw conflict('this flag is no longer active');
  const note = body.note ? String(body.note).trim().slice(0, 500) : '';
  if (!approve && !note) throw badRequest('say why the request is rejected (the post is told)');
  if (approve && f.retention === 'timed' && new Date(f.retain_to) <= new Date()) throw conflict('the retention period has already ended');
  let next = null;
  if (approve) {
    // what was asked for, unless the administrator picks another end
    const ask = body.retention === 'permanent' || body.retain_to || body.add_days
      ? body
      : (f.ext_retention === 'permanent' ? { retention: 'permanent' } : { retain_to: f.ext_retain_to });
    next = newEnd(f, ask);
  }
  await withTransaction(async (client) => {
    if (approve) {
      await client.query(
        `UPDATE evidence_flag SET retention=$2, retain_to=$3, ext_status='approved', ext_decided_by=$4, ext_decided_at=now(), ext_decision_note=$5 WHERE id=$1 AND ext_status='pending'`,
        [id, next.retention, next.retain_to, user.id, note || null]);
    } else {
      await client.query(
        `UPDATE evidence_flag SET ext_status='rejected', ext_decided_by=$2, ext_decided_at=now(), ext_decision_note=$3 WHERE id=$1 AND ext_status='pending'`,
        [id, user.id, note]);
    }
    await audit(client, { user, action: approve ? 'evidence.extend_approve' : 'evidence.extend_reject', entity: 'evidence_flag', entityId: id, zoneId: f.zone_id,
      details: { from: endText(f), to: approve ? endText(next) : null, requested: f.ext_retention === 'permanent' ? 'for life' : f.ext_retain_to ? `until ${fmtD(f.ext_retain_to)}` : null, note: note || null } });
    await notify.send(client, { zone_id: f.zone_id, post_id: f.post_id, kind: 'evidence', ref_entity: 'evidence_flag', ref_id: id,
      title: approve ? `Retention of flag #${id} extended - now kept ${endText(next)}` : `Retention request for flag #${id} was rejected`,
      body: note || (approve ? 'CMS approved your request.' : null) });
  });
}

/** An administrator extends a retention directly (no request needed). The justification is mandatory and goes to the audit trail. */
async function extend(user, id, body = {}) {
  const f = await loadForDecision(user, id);
  if (f.status !== 'active') throw conflict('this flag is no longer active');
  if (f.ext_status === 'pending') throw conflict('this flag has a pending request from the post: approve or reject it first');
  const why = body.note ? String(body.note).trim().slice(0, 500) : '';
  if (!why) throw badRequest('a justification is required to extend a retention');
  const next = newEnd(f, body);
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE evidence_flag SET retention=$2, retain_to=$3, ext_status='approved', ext_retention=$2, ext_retain_to=$3, ext_justification=$4, ext_requested_by=$5, ext_requested_at=now(), ext_decided_by=$5, ext_decided_at=now(), ext_decision_note='extended by CMS' WHERE id=$1`,
      [id, next.retention, next.retain_to, why, user.id]);
    await audit(client, { user, action: 'evidence.extend', entity: 'evidence_flag', entityId: id, zoneId: f.zone_id, details: { from: endText(f), to: endText(next), justification: why } });
    await notify.send(client, { zone_id: f.zone_id, post_id: f.post_id, kind: 'evidence', ref_entity: 'evidence_flag', ref_id: id,
      title: `CMS extended the retention of flag #${id} - now kept ${endText(next)}`, body: why });
  });
}


/**
 * Re-hash the archived file on disk and compare it with what was recorded when it was archived (and with the delivered file for a
 * whole-recording flag). Detects a damaged or replaced file. The result is written to the audit trail (chain of custody).
 */
async function verify(user, id) {
  const f = await loadForDecision(user, id);
  if (!f.archive_path) throw conflict('this flag has no archive copy at the data centre yet');
  const abs = absPath(f.archive_path);
  const checks = [];
  let actual = null;
  if (!exists(abs)) checks.push({ ok: false, text: 'The archived file is MISSING from the evidence store' });
  else {
    actual = await sha256File(abs);
    checks.push({ ok: actual === f.archive_sha256, text: actual === f.archive_sha256 ? 'The archived file still matches the SHA-256 recorded when it was archived' : 'The archived file has CHANGED since it was archived (SHA-256 differs from the record)' });
    if (f.section_start_s == null || f.copy_kind === 'whole') checks.push({ ok: actual === f.footage_sha256, text: actual === f.footage_sha256 ? 'It is identical to the delivered file' : 'It is NOT identical to the delivered file' });
    if (f.local_sha256) {
      const same = f.local_sha256 === f.archive_sha256;
      checks.push({ ok: same, text: same ? "The post's copy is identical" : "The post's copy DIFFERS - the post can repair it with Verify" });
    }
  }
  const ok = checks.every((c) => c.ok);
  await audit(null, { user, action: 'evidence.verify', entity: 'evidence_flag', entityId: id, zoneId: f.zone_id, details: { ok, result: ok ? 'passed' : 'FAILED', text: checks.map((c) => c.text).join('; '), sha256: actual } });
  return { ok, actual, recorded: f.archive_sha256, checks };
}

/**
 * N+1 for evidence: the archived clip of a flag is on the disk of the CMS that holds the footage. Every OTHER CMS keeps a verified copy
 * (so evidence survives the loss of one computer), and drops its copy when the flag is released or expires.
 */
async function mirrorArchives() {
  const cluster = require('./cluster');
  const me = await cluster.self();
  if (!me) return 'not clustered';
  const { rows } = await pool.query(
    `SELECT e.id, e.footage_id, e.archive_path, e.archive_sha256 FROM evidence_flag e
      WHERE e.archive_status = 'archived' AND e.status = 'active' AND e.archive_path IS NOT NULL AND NOT cms_owns_strict(e.footage_id) ORDER BY e.id LIMIT 300`);
  let got = 0; let failed = 0; let dropped = 0; let tried = 0;
  rows.sort(() => Math.random() - 0.5); // a clip that cannot be fetched must not hold back the ones behind it
  for (const f of rows) {
    if (got >= 3 || tried >= 60) break; // a few downloads per tick: big files, slow links
    const dest = absPath(f.archive_path);
    if (exists(dest)) continue;
    const ownerNo = cluster.nodeOfId(f.footage_id);
    const node = await cluster.nodeByNo(ownerNo);
    if (!node || !(await cluster.isAlive(ownerNo))) continue;
    tried++;
    try {
      const sha = await cluster.downloadFromNode(node, 'evidence', f.id, dest);
      if (sha !== f.archive_sha256) { fs.rmSync(dest, { force: true }); failed++; await cluster.event('mirror', ownerNo, `copy of evidence flag #${f.id} from ${node.name} did not match its checksum - discarded`); } else got++;
    } catch (_) { failed++; }
  }
  const { rows: gone } = await pool.query(
    `SELECT e.id, e.archive_path FROM evidence_flag e WHERE e.status <> 'active' AND e.archive_path IS NOT NULL AND NOT cms_owns_strict(e.footage_id) ORDER BY e.id DESC LIMIT 300`);
  for (const f of gone) { const p = absPath(f.archive_path); if (exists(p)) { try { fs.rmSync(p, { force: true }); dropped++; } catch (_) { /* ignore */ } } }
  return `${got} evidence clip(s) copied from other CMS, ${failed} failed, ${dropped} released cop${dropped === 1 ? 'y' : 'ies'} removed`;
}

module.exports = { FLAG_SELECT, mirrorArchives, archiveFlag, archivePending, retryArchive, release, decideExtension, extend, verify, checksumCheck };
