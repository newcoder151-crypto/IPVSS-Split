/**
 * Footage requests BY TRAIN NUMBER (RPF side).
 *
 * The officer names a train and a time window - never a camera. RPF files one train_request; CMS approves it and
 * fans it out to every camera of every M-NVR unit of that train. Each camera's footage comes back as its own file,
 * named  <TRAIN>_M<nn>_C<nn>_<start>_<end>.mp4  (train number, M-NVR no., camera no.), and is listed here as it arrives.
 */
const { pool } = require('../db');
const config = require('../config');
const { badRequest, notFound, conflict } = require('../errors');
const { parseTs, requireText } = require('./util');
const { audit } = require('./audit');

const OPEN_TRAIN_STATUSES = ['submitted', 'approved', 'awaiting_upload'];
const TRAIN_STATUSES = ['submitted', 'approved', 'awaiting_upload', 'fulfilled', 'partial', 'rejected', 'failed', 'expired', 'cancelled'];

const TRAIN_REQUEST_SELECT = `
  SELECT t.id, t.train_no, t.post_id, p.name AS post_name, t.zone_id,
         t.requested_by, ur.username AS requested_by_username,
         t.alert_id, t.alert_event_time, t.incident_id,
         t.window_start, t.window_end, t.orig_window_start, t.orig_window_end, t.reason, t.status,
         t.operator_id, uo.username AS operator_username, t.decided_at, t.decision_note,
         t.units_total, t.cameras_total, t.cameras_fulfilled, t.cameras_open, t.cameras_failed,
         t.skipped, t.failure_reason, t.fulfilled_at, t.created_at, t.updated_at,
         (SELECT COUNT(*) FROM delivered_footage f WHERE f.train_request_id = t.id) AS footage_count
    FROM train_request t
    JOIN rpf_post p ON p.id = t.post_id
    JOIN users ur ON ur.id = t.requested_by
    LEFT JOIN users uo ON uo.id = t.operator_id`;

/** Trains this post can ask about: the train numbers reported by M-NVR units in the post's zone, with those units and their cameras. */
async function trainsInZone(zoneId) {
  const { rows } = await pool.query(
    `SELECT n.train_no, n.id AS nvr_id, n.name AS nvr_name, COALESCE(n.unit_no, n.id) AS unit_no,
            (n.last_seen > now() - make_interval(secs => 60)) AS online, n.last_seen,
            c.id AS camera_id, COALESCE(c.mnvr_camera_id, c.id) AS camera_no, c.name AS camera_name, c.mount_position
       FROM nvr_unit n
       LEFT JOIN camera c ON c.nvr_id = n.id AND c.active
      WHERE n.status = 'active' AND n.train_no IS NOT NULL AND btrim(n.train_no) <> ''
        AND lower(btrim(n.train_no)) IN (SELECT lower(btrim(z.train_no)) FROM nvr_unit z WHERE z.current_zone_id = $1 AND z.train_no IS NOT NULL)
      ORDER BY n.train_no, 4, 7`, [zoneId]);
  const trains = new Map();
  for (const r of rows) {
    const key = r.train_no.trim().toLowerCase();
    if (!trains.has(key)) trains.set(key, { train_no: r.train_no.trim(), units: new Map() });
    const t = trains.get(key);
    if (!t.units.has(r.nvr_id)) t.units.set(r.nvr_id, { nvr_id: r.nvr_id, name: r.nvr_name, unit_no: r.unit_no, online: r.online, last_seen: r.last_seen, cameras: [] });
    if (r.camera_id) t.units.get(r.nvr_id).cameras.push({ id: r.camera_id, camera_no: r.camera_no, name: r.camera_name, mount_position: r.mount_position });
  }
  return [...trains.values()].map((t) => {
    const units = [...t.units.values()];
    return { train_no: t.train_no, units_total: units.length, units_online: units.filter((u) => u.online).length,
      cameras_total: units.reduce((a, u) => a + u.cameras.length, 0), units };
  });
}

/**
 * input: { train_no, window_start, window_end, reason, incident_id?, alert_id? }
 * Validation mirrors CMS so a bad request fails here, not in the operator queue.
 */
async function createTrainRequest(client, user, input) {
  const start = parseTs(input.window_start, 'window_start');
  const end = parseTs(input.window_end, 'window_end');
  if (end <= start) throw badRequest('window_end must be after window_start');
  const minutes = (end - start) / 60000;
  if (minutes > config.maxRequestWindowMin) throw badRequest(`window is ${Math.round(minutes)} min; the maximum per request is ${config.maxRequestWindowMin} min`);
  if (start > new Date()) throw badRequest('window_start is in the future - there is no footage to request yet');
  const reason = requireText(input.reason, 'reason');

  const trainNo = typeof input.train_no === 'string' ? input.train_no.trim() : '';
  if (!trainNo) throw badRequest('train_no is required');
  // The train is whatever its M-NVR units report as their train number. One with no unit in this zone is reported like an unknown
  // train: nothing about other zones is revealed.
  const { rows: inZone } = await client.query(
    `SELECT MIN(n.train_no) AS train_no, COUNT(*)::int AS units,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM camera c WHERE c.nvr_id = n.id AND c.active))::int AS with_cameras
       FROM nvr_unit n WHERE lower(btrim(n.train_no)) = lower($1) AND n.status = 'active'
        AND EXISTS (SELECT 1 FROM nvr_unit z WHERE lower(btrim(z.train_no)) = lower(btrim(n.train_no)) AND z.current_zone_id = $2)`, [trainNo, user.zone_id]);
  if (!inZone[0].units) throw badRequest(`train ${trainNo} is not known in your zone`);
  if (!inZone[0].with_cameras) throw badRequest(`train ${inZone[0].train_no} has no active camera to request`);
  const train = { train_no: inZone[0].train_no.trim() };

  const incidentId = input.incident_id != null ? Number(input.incident_id) : null;
  if (incidentId != null) {
    if (!Number.isInteger(incidentId) || incidentId <= 0) throw badRequest('incident_id is not valid');
    const own = await client.query('SELECT status FROM incident WHERE id = $1 AND post_id = $2', [incidentId, user.post_id]);
    if (!own.rowCount) throw notFound('incident not found');
    if (own.rows[0].status === 'closed') throw conflict('this incident is closed - footage can no longer be requested for it');
  }
  let alertId = null; let alertEventTime = null;
  if (input.alert_id != null) {
    const { rows } = await client.query(`SELECT alert_event_time FROM alert_delivery WHERE alert_id = $1 AND post_id = $2 ORDER BY id DESC LIMIT 1`, [Number(input.alert_id), user.post_id]);
    if (!rows.length) throw notFound(`alert ${input.alert_id} was not delivered to your post`);
    alertId = Number(input.alert_id); alertEventTime = rows[0].alert_event_time;
  }

  const { rows: dup } = await client.query(
    `SELECT id FROM train_request WHERE post_id = $1 AND lower(btrim(train_no)) = lower($2) AND status = ANY($3) AND window_start < $5 AND window_end > $4 LIMIT 1`,
    [user.post_id, train.train_no, OPEN_TRAIN_STATUSES, start, end]);
  if (dup.length) throw conflict(`an open request (#${dup[0].id}) already covers train ${train.train_no} in this time window`);

  const { rows } = await client.query(
    `INSERT INTO train_request (train_no, post_id, zone_id, requested_by, alert_id, alert_event_time, incident_id, window_start, window_end, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [train.train_no, user.post_id, user.zone_id, user.id, alertId, alertEventTime, incidentId, start, end, reason]);
  const id = rows[0].id;
  await audit(client, { user, action: 'train_request.create', entity: 'train_request', entityId: id,
    details: { train_no: train.train_no, window_start: start, window_end: end, alert_id: alertId, incident_id: incidentId } });
  return id;
}

/** Per camera: unit / camera number, state, and the delivered file once there is one. */
async function cameraProgress(trainRequestId) {
  const { rows } = await pool.query(
    `SELECT r.id AS request_id, r.status, r.failure_reason,
            n.id AS nvr_id, COALESCE(n.unit_no, n.id) AS unit_no, n.name AS nvr_name, (n.last_seen > now() - make_interval(secs => 60)) AS unit_online, n.last_seen,
            c.id AS camera_id, COALESCE(c.mnvr_camera_id, c.id) AS camera_no, c.name AS camera_name, c.mount_position,
            f.id AS footage_id, f.file_name, f.file_size_bytes, f.duration_s, f.start_time AS footage_start, f.end_time AS footage_end, f.delivered_at
       FROM video_request r
       JOIN camera c ON c.id = r.camera_id
       JOIN nvr_unit n ON n.id = c.nvr_id
       LEFT JOIN LATERAL (SELECT * FROM delivered_footage d WHERE d.video_request_id = r.id ORDER BY d.id DESC LIMIT 1) f ON TRUE
      WHERE r.train_request_id = $1 ORDER BY 5, 10`, [trainRequestId]);
  return rows;
}

module.exports = { TRAIN_REQUEST_SELECT, OPEN_TRAIN_STATUSES, TRAIN_STATUSES, trainsInZone, createTrainRequest, cameraProgress };
