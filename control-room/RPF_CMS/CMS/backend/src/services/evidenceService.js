const fs = require('fs');
const { pool, withTransaction } = require('../db');
const { badRequest, notFound, conflict } = require('../errors');
const { audit } = require('./audit');
const notify = require('./notify');
const { absPath, exists, sha256File, ensureDir } = require('./fsutil');
const { cutClip } = require('./footageService');
const { canSeeZone } = require('../middleware/auth');

const FLAG_SELECT = `
  SELECT e.id, e.footage_id, e.incident_id, e.retention, e.retain_from, e.retain_to, e.justification, e.status, e.flagged_at,
         e.section_start_s, e.section_end_s, e.section_from, e.section_to,
         e.archive_status, e.archive_path, e.archive_sha256, e.archive_size_bytes, e.archived_at, e.archive_error,
         e.released_at, e.release_note, e.storage, e.local_sha256, e.local_size_bytes, e.local_saved_at, e.local_error, (e.local_path IS NOT NULL) AS has_local, e.local_path, uf.username AS flagged_by_username, ur.username AS released_by_username,
         f.format, f.file_size_bytes, f.duration_s, r.id AS request_id, r.window_start, r.window_end,
         p.id AS post_id, p.name AS post_name, p.zone_id, c.id AS camera_id, c.name AS camera_name, n.name AS nvr_name
    FROM evidence_flag e
    JOIN users uf ON uf.id = e.flagged_by
    LEFT JOIN users ur ON ur.id = e.released_by
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
    `SELECT e.id, e.status, e.section_start_s, e.section_end_s, f.storage_path, p.zone_id, p.id AS post_id
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
    if (e.section_start_s != null) await cutClip(src, dst, e.section_start_s, e.section_end_s);
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
  const { rows } = await pool.query(`SELECT id FROM evidence_flag WHERE archive_status = 'pending' AND status = 'active' ORDER BY id LIMIT 20`);
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
    await client.query(`UPDATE evidence_flag SET status='released', released_by=$2, released_at=now(), release_note=$3 WHERE id=$1`, [id, user.id, String(note).trim().slice(0, 500)]);
    await audit(client, { user, action: 'evidence.release', entity: 'evidence_flag', entityId: id, zoneId: f.zone_id, details: { note, retention: f.retention } });
    await notify.send(client, { zone_id: f.zone_id, post_id: f.post_id, kind: 'evidence', ref_entity: 'evidence_flag', ref_id: id, title: `Evidence flag #${id} was released by CMS`, body: String(note).trim() });
  });
}

module.exports = { FLAG_SELECT, archiveFlag, archivePending, retryArchive, release };
