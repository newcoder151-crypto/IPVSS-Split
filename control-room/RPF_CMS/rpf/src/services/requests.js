const { pool } = require('../db');
const config = require('../config');
const { badRequest, notFound, conflict } = require('../errors');
const { parseTs, requireText } = require('./util');
const { audit } = require('./audit');

const OPEN_STATUSES = ['submitted', 'approved', 'amended', 'awaiting_upload'];

const REQUEST_SELECT = `
  SELECT r.id, r.post_id, p.name AS post_name, p.zone_id,
         r.requested_by, ur.username AS requested_by_username,
         r.alert_id, r.alert_event_time,
         r.camera_id, c.name AS camera_name, n.name AS nvr_name,
         r.window_start, r.window_end, r.reason, r.status, r.incident_id, r.failure_reason, r.fulfilled_at,
         r.orig_window_start, r.orig_window_end, n.train_no,
         r.operator_id, uo.username AS operator_username,
         r.decided_at, r.decision_note, r.created_at,
         (SELECT COUNT(*) FROM delivered_footage f WHERE f.video_request_id = r.id) AS footage_count
    FROM video_request r
    JOIN rpf_post p ON p.id = r.post_id
    JOIN users ur ON ur.id = r.requested_by
    JOIN camera c ON c.id = r.camera_id
    JOIN nvr_unit n ON n.id = c.nvr_id
    LEFT JOIN users uo ON uo.id = r.operator_id`;

const FOOTAGE_SELECT = `
  SELECT f.id, f.video_request_id AS request_id, f.format, f.sha256,
         f.file_size_bytes, f.delivered_at, f.start_time, f.end_time, f.duration_s, f.segment_count,
         r.incident_id, r.reason AS request_reason,
         regexp_replace(f.storage_path, '^.*/', '') AS file_name,
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

/**
 * Creates a video_request for the officer's post. Validation mirrors what
 * CMS would enforce, so a bad request fails here with a clear message
 * instead of sitting in the operator queue.
 */
async function createRequest(client, user, input) {
  const start = parseTs(input.window_start, 'window_start');
  const end = parseTs(input.window_end, 'window_end');
  if (end <= start) throw badRequest('window_end must be after window_start');
  const minutes = (end - start) / 60000;
  if (minutes > config.maxRequestWindowMin) {
    throw badRequest(`window is ${Math.round(minutes)} min; the maximum per request is ${config.maxRequestWindowMin} min`);
  }
  if (start > new Date()) throw badRequest('window_start is in the future - there is no footage to request yet');
  const reason = requireText(input.reason, 'reason');
  const incidentId = input.incident_id != null ? Number(input.incident_id) : null;
  if (incidentId != null) {
    if (!Number.isInteger(incidentId) || incidentId <= 0) throw badRequest('incident_id is not valid');
    const own = await client.query('SELECT 1 FROM incident WHERE id = $1 AND post_id = $2', [incidentId, user.post_id]);
    if (!own.rowCount) throw notFound('incident not found');   // another post's incident is never confirmed to exist
  }
  const cameraId = Number(input.camera_id);
  if (!Number.isInteger(cameraId) || cameraId <= 0) throw badRequest('camera_id is required');

  // The camera must sit on an NVR unit currently assigned to this post's zone.
  // (Windows that span a zone handover are resolved by CMS, not by RPF.)
  const { rows: cams } = await client.query(
    `SELECT c.id FROM camera c JOIN nvr_unit n ON n.id = c.nvr_id
      WHERE c.id = $1 AND c.active AND n.current_zone_id = $2`,
    [cameraId, user.zone_id]
  );
  if (!cams.length) throw badRequest(`camera ${cameraId} is not an active camera in your zone`);

  let alertId = null;
  let alertEventTime = null;
  if (input.alert_id != null) {
    const { rows } = await client.query(
      `SELECT alert_event_time FROM alert_delivery
        WHERE alert_id = $1 AND post_id = $2 ORDER BY id DESC LIMIT 1`,
      [Number(input.alert_id), user.post_id]
    );
    if (!rows.length) throw notFound(`alert ${input.alert_id} was not delivered to your post`);
    alertId = Number(input.alert_id);
    alertEventTime = rows[0].alert_event_time;
  }

  // No duplicate ingestion (Cl. 3.14): same post + camera + overlapping window while still open.
  const { rows: dup } = await client.query(
    `SELECT id FROM video_request
      WHERE post_id = $1 AND camera_id = $2 AND status = ANY($3)
        AND window_start < $5 AND window_end > $4
      LIMIT 1`,
    [user.post_id, cameraId, OPEN_STATUSES, start, end]
  );
  if (dup.length) throw conflict(`an open request (#${dup[0].id}) already covers this camera and time window`);

  const { rows } = await client.query(
    `INSERT INTO video_request
       (post_id, requested_by, alert_id, alert_event_time, camera_id, window_start, window_end, reason, incident_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [user.post_id, user.id, alertId, alertEventTime, cameraId, start, end, reason, incidentId]
  );
  const id = rows[0].id;
  await audit(client, {
    user, action: 'request.create', entity: 'video_request', entityId: id,
    details: { camera_id: cameraId, window_start: start, window_end: end, alert_id: alertId, incident_id: incidentId },
  });
  return id;
}

async function footageForRequests(ids) {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `${FOOTAGE_SELECT} WHERE f.video_request_id = ANY($1) ORDER BY f.id`,
    [ids]
  );
  return rows.map((f) => ({ ...f, playable: String(f.format || '').toLowerCase() === 'mp4' }));
}

module.exports = { REQUEST_SELECT, FOOTAGE_SELECT, OPEN_STATUSES, createRequest, footageForRequests };
