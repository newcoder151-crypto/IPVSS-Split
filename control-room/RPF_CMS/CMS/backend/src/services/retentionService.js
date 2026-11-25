const fs = require('fs');
const { pool, withTransaction } = require('../db');
const settings = require('./settings');
const { audit } = require('./audit');
const { absPath } = require('./fsutil');
const notify = require('./notify');

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
    await pool.query(`UPDATE evidence_flag SET status='released', released_at=now(), release_note='retention period elapsed',
       ext_decision_note = CASE WHEN ext_status = 'pending' THEN 'the retention period ended before the request was decided' ELSE ext_decision_note END, ext_decided_at = CASE WHEN ext_status = 'pending' THEN now() ELSE ext_decided_at END, ext_status = CASE WHEN ext_status = 'pending' THEN 'rejected' ELSE ext_status END,
       archive_status = CASE WHEN archive_path IS NULL THEN archive_status ELSE 'purged' END WHERE id=$1`, [e.id]);
    await audit(null, { user, action: 'evidence.expire', entity: 'evidence_flag', entityId: e.id, zoneId: e.zone_id });
  }
  if (deleted || exp.length) await audit(null, { user, action: 'retention.run', entity: 'video_segment', details: { deleted, bytes, flags_expired: exp.length, retention_days: days } });
  if (!dryRun) await pool.query(`DELETE FROM console_notice WHERE read_at < now() - interval '60 days'`).catch(() => {}); // old, already-read bell notices
  return { deleted, bytes, flags_expired: exp.length };
}

/**
 * Tell the post and the CMS console when a retention is about to end - at 30, 7 and 1 day(s) left - so a recording is never lost by
 * accident: the post can ask for longer (or let it go), CMS can extend. Not sent while a request for longer is already waiting.
 * Each reminder is sent once per flag.
 */
async function remindExpiring() {
  const { rows } = await pool.query(
    `SELECT e.id, e.retain_to, CEIL(EXTRACT(EPOCH FROM (e.retain_to - now())) / 86400.0)::int AS days_left, p.id AS post_id, p.name AS post_name, p.zone_id
       FROM evidence_flag e JOIN delivered_footage f ON f.id = e.footage_id JOIN video_request r ON r.id = f.video_request_id JOIN rpf_post p ON p.id = r.post_id
      WHERE e.status = 'active' AND e.retention = 'timed' AND e.retain_to IS NOT NULL AND COALESCE(e.ext_status, '') <> 'pending'
        AND CEIL(EXTRACT(EPOCH FROM (e.retain_to - now())) / 86400.0)::int IN (30, 7, 1)`);
  let sent = 0;
  for (const f of rows) {
    const when = f.days_left === 1 ? 'tomorrow' : `in ${f.days_left} days`;
    const title = `Retention of evidence flag #${f.id} ends ${when}`;
    const dup = await pool.query(`SELECT 1 FROM notification WHERE ref_entity = 'evidence_flag' AND ref_id = $1 AND title = $2 LIMIT 1`, [f.id, title]);
    if (dup.rowCount) continue;
    await withTransaction(async (client) => {
      await notify.send(client, { zone_id: f.zone_id, post_id: f.post_id, kind: 'evidence', ref_entity: 'evidence_flag', ref_id: f.id, title,
        body: 'After that date the recording is released and its archive copy deleted. If it is still needed, ask CMS for a longer retention from the Retention tab.' });
      await client.query(
        `INSERT INTO console_notice (zone_id, post_id, kind, title, body, ref_entity, ref_id) VALUES ($1, $2, 'retention', $3, $4, 'evidence_flag', $5)`,
        [f.zone_id, f.post_id, title, `${f.post_name} - ends ${new Date(f.retain_to).toISOString().slice(0, 10)}. Extend it now, or let it expire.`, f.id]);
    });
    sent++;
  }
  return sent;
}

async function runIfEnabled() {
  if (!(await settings.get('retention_auto'))) return 'automatic retention is switched off';
  const r = await run({});
  return `${r.deleted} segment(s) deleted, ${r.flags_expired} flag(s) expired`;
}

module.exports = { preview, run, runIfEnabled, remindExpiring };
