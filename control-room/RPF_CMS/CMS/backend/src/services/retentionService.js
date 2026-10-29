const fs = require('fs');
const { pool, withTransaction } = require('../db');
const settings = require('./settings');
const { audit } = require('./audit');
const { absPath } = require('./fsutil');

/**
 * 30-day FIFO on RAW segments only. A segment is protected while any ACTIVE evidence flag's section
 * overlaps it on the same camera (a permanent flag protects for ever; a timed one until retain_to).
 * Delivered footage, archived evidence clips and the audit trail are never touched by this job.
 */
async function candidates(days, limit = 5000) {
  const { rows } = await pool.query(
    `SELECT s.id, s.camera_id, s.zone_id, s.start_time, s.end_time, s.object_key, s.size_bytes, s.upload_status,
            EXISTS (
              SELECT 1 FROM evidence_flag e
                JOIN delivered_footage f ON f.id = e.footage_id JOIN video_request r ON r.id = f.video_request_id
               WHERE r.camera_id = s.camera_id AND e.status = 'active' AND e.storage <> 'local' AND (e.retain_to IS NULL OR e.retain_to > now())
                 AND COALESCE(e.section_from, f.start_time, r.window_start) < s.end_time
                 AND COALESCE(e.section_to,   f.end_time,   r.window_end)   > s.start_time
            ) AS protected
       FROM video_segment s WHERE s.end_time < now() - make_interval(days => $1) ORDER BY s.start_time LIMIT $2`, [days, limit]);
  return rows;
}

async function preview() {
  const days = await settings.get('retention_days');
  const rows = await candidates(days);
  const due = rows.filter((r) => !r.protected);
  return {
    retention_days: days,
    due_count: due.length, due_bytes: due.reduce((a, r) => a + Number(r.size_bytes || 0), 0),
    protected_count: rows.length - due.length, protected_bytes: rows.filter((r) => r.protected).reduce((a, r) => a + Number(r.size_bytes || 0), 0),
    oldest_due: due.length ? due[0].start_time : null,
    sample: due.slice(0, 10).map((r) => ({ id: r.id, camera_id: r.camera_id, start_time: r.start_time, size_bytes: r.size_bytes })),
  };
}

async function run({ dryRun = false, user = null } = {}) {
  const days = await settings.get('retention_days');
  const rows = (await candidates(days)).filter((r) => !r.protected);
  if (dryRun) return { deleted: 0, would_delete: rows.length };
  let deleted = 0; let bytes = 0;
  for (const s of rows) {
    try {
      for (const f of [absPath(s.object_key), absPath(s.object_key + '.part')]) fs.rmSync(f, { force: true });
    } catch (_) { /* path outside root: just drop the row */ }
    await withTransaction(async (c) => {
      await c.query('DELETE FROM upload_session WHERE segment_id = $1', [s.id]);
      await c.query('DELETE FROM video_segment WHERE id = $1', [s.id]);
    });
    deleted++; bytes += Number(s.size_bytes || 0);
  }
  // timed flags whose retention has elapsed: release them and remove their archived clip
  const { rows: exp } = await pool.query(
    `SELECT e.id, e.archive_path, p.zone_id FROM evidence_flag e JOIN delivered_footage f ON f.id=e.footage_id
       JOIN video_request r ON r.id=f.video_request_id JOIN rpf_post p ON p.id=r.post_id
      WHERE e.status='active' AND e.retention='timed' AND e.retain_to <= now()`);
  for (const e of exp) {
    if (e.archive_path) { try { fs.rmSync(absPath(e.archive_path), { force: true }); } catch (_) { /* ignore */ } }
    await pool.query(`UPDATE evidence_flag SET status='released', released_at=now(), release_note='retention period elapsed', archive_status = CASE WHEN archive_path IS NULL THEN archive_status ELSE 'purged' END WHERE id=$1`, [e.id]);
    await audit(null, { user, action: 'evidence.expire', entity: 'evidence_flag', entityId: e.id, zoneId: e.zone_id });
  }
  if (deleted || exp.length) await audit(null, { user, action: 'retention.run', entity: 'video_segment', details: { deleted, bytes, flags_expired: exp.length, retention_days: days } });
  return { deleted, bytes, flags_expired: exp.length };
}

async function runIfEnabled() {
  if (!(await settings.get('retention_auto'))) return 'automatic retention is switched off';
  const r = await run({});
  return `${r.deleted} segment(s) deleted, ${r.flags_expired} flag(s) expired`;
}

module.exports = { preview, run, runIfEnabled };
