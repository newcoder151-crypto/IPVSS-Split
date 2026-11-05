const { pool } = require('../db');

// Footage is delivered per camera of a train request: one file per camera, named <TRAIN>_M<nn>_C<nn>_<start>_<end>.mp4
const FOOTAGE_SELECT = `
  SELECT f.id, f.video_request_id AS request_id, f.format, f.sha256,
         f.file_size_bytes, f.delivered_at, f.start_time, f.end_time, f.duration_s, f.segment_count,
         r.incident_id, r.reason AS request_reason,
         COALESCE(f.file_name, regexp_replace(f.storage_path, '^.*/', '')) AS file_name,
         f.train_request_id, COALESCE(f.train_no, n.train_no) AS train_no, COALESCE(f.unit_no, n.unit_no, n.id) AS unit_no, COALESCE(f.camera_no, c.mnvr_camera_id, c.id) AS camera_no,
         NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.entity = 'delivered_footage' AND a.entity_id = f.id
                      AND a.action IN ('footage.view', 'footage.download', 'footage.download.section')) AS is_new,
         r.post_id, p.name AS post_name, p.zone_id,
         r.camera_id, c.name AS camera_name, n.name AS nvr_name,
         r.window_start, r.window_end, r.alert_id,
         (SELECT COUNT(*) FROM evidence_flag e
           WHERE e.footage_id = f.id AND e.status = 'active') AS active_flags
    FROM delivered_footage f
    JOIN video_request r ON r.id = f.video_request_id
    JOIN rpf_post p ON p.id = r.post_id
    JOIN camera c ON c.id = r.camera_id
    JOIN nvr_unit n ON n.id = c.nvr_id`;

/** Footage of the given train requests (one file per camera of the train). */
async function footageForTrainRequests(trainRequestIds) {
  const { rows } = await pool.query(
    `${FOOTAGE_SELECT} WHERE f.train_request_id = ANY($1) ORDER BY f.train_no, f.unit_no, f.camera_no, f.id`,
    [trainRequestIds]);
  return rows.map((f) => ({ ...f, playable: String(f.format || '').toLowerCase() === 'mp4' }));
}

module.exports = { FOOTAGE_SELECT, footageForTrainRequests };
