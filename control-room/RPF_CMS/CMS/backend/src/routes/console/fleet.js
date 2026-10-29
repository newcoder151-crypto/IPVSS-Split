const express = require('express');
const { pool } = require('../../db');
const { zoneScope, canSeeZone, requireAdmin } = require('../../middleware/auth');
const settings = require('../../services/settings');
const retention = require('../../services/retentionService');
const reqs = require('../../services/requestService');
const { audit } = require('../../services/audit');
const { parseId, parseLimit, parseOffset, parseTs, where } = require('../../services/util');
const { badRequest, notFound, conflict, wrap } = require('../../errors');

const router = express.Router();

router.get('/nvrs', wrap(async (req, res) => {
  const cfg = await settings.all();
  const w = where(); w.params.push(cfg.nvr_offline_after_s);
  w.raw(zoneScope(req.user, 'n.current_zone_id', w.params, req.query.zone_id));
  const { rows } = await pool.query(
    `SELECT n.id, n.name, n.train_no, n.status, n.firmware, n.current_zone_id AS zone_id, z.name AS zone_name, n.last_seen, n.last_lat AS lat, n.last_lon AS lon,
            n.last_speed_mps, n.health, (n.last_seen > now() - make_interval(secs => $1)) AS online,
            (SELECT COUNT(*) FROM camera c WHERE c.nvr_id = n.id AND c.active) AS cameras,
            (SELECT COUNT(*) FROM nvr_command m WHERE m.nvr_id = n.id AND m.status IN ('queued','sent','acked')) AS open_commands,
            (SELECT COUNT(*) FROM video_segment s WHERE s.nvr_id = n.id AND s.upload_status IN ('pending','partial')) AS uploading,
            (SELECT COUNT(*) FROM alert a WHERE a.nvr_id = n.id AND a.event_time > now() - interval '24 hours') AS alerts_24h,
            (SELECT COUNT(*) FROM video_request r JOIN camera c ON c.id = r.camera_id WHERE c.nvr_id = n.id AND r.status = 'awaiting_upload') AS waiting_requests
       FROM nvr_unit n LEFT JOIN zone z ON z.id = n.current_zone_id ${w.sql()} ORDER BY n.name`, w.params);
  res.json(rows);
}));

router.get('/nvrs/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query(`SELECT n.*, z.name AS zone_name FROM nvr_unit n LEFT JOIN zone z ON z.id = n.current_zone_id WHERE n.id = $1`, [id]);
  const n = rows[0];
  if (!n || !canSeeZone(req.user, n.current_zone_id)) throw notFound('NVR not found');
  delete n.cert_fingerprint;
  const [cams, cmds, track, assign, segs] = await Promise.all([
    pool.query(`SELECT c.id, c.name, c.mount_position, c.active,
                       (SELECT MAX(end_time) FROM video_segment s WHERE s.camera_id = c.id AND s.upload_status = 'complete') AS last_segment,
                       (SELECT COUNT(*) FROM video_segment s WHERE s.camera_id = c.id AND s.upload_status = 'complete') AS segments
                  FROM camera c WHERE c.nvr_id = $1 ORDER BY c.name`, [id]),
    pool.query(`SELECT id, kind, status, camera_id, window_start, window_end, request_id, created_at, sent_at, completed_at, result FROM nvr_command WHERE nvr_id = $1 ORDER BY id DESC LIMIT 15`, [id]),
    pool.query(`SELECT ts, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon, speed_mps FROM gps_point WHERE nvr_id = $1 AND ts > now() - interval '6 hours' ORDER BY ts DESC LIMIT 300`, [id]),
    pool.query(`SELECT a.assigned_from, a.assigned_until, z.name AS zone_name FROM nvr_zone_assignment a JOIN zone z ON z.id = a.zone_id WHERE a.nvr_id = $1 ORDER BY a.assigned_from DESC`, [id]),
    pool.query(`SELECT upload_status, COUNT(*) AS n FROM video_segment WHERE nvr_id = $1 GROUP BY 1`, [id]),
  ]);
  res.json({ nvr: n, cameras: cams.rows, commands: cmds.rows, track: track.rows.reverse(), assignments: assign.rows, segments: segs.rows });
}));

/** Operator-issued commands: upload a window now (no request), ping, sync clock. */
router.post('/nvrs/:id/command', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query('SELECT id, current_zone_id FROM nvr_unit WHERE id = $1', [id]);
  if (!rows.length || !canSeeZone(req.user, rows[0].current_zone_id)) throw notFound('NVR not found');
  const kind = req.body && req.body.kind;
  if (!['upload_now', 'ping', 'sync_clock'].includes(kind)) throw badRequest("kind must be 'upload_now', 'ping' or 'sync_clock'");
  let cam = null; let from = null; let to = null;
  if (kind === 'upload_now') {
    cam = parseId(req.body.camera_id, 'camera_id');
    from = parseTs(req.body.window_start, 'window_start'); to = parseTs(req.body.window_end, 'window_end');
    if (to <= from) throw badRequest('window_end must be after window_start');
    const { rows: c } = await pool.query('SELECT 1 FROM camera WHERE id = $1 AND nvr_id = $2', [cam, id]);
    if (!c.length) throw badRequest('camera does not belong to this NVR');
  }
  const { rows: ins } = await pool.query(`INSERT INTO nvr_command (nvr_id, kind, camera_id, window_start, window_end, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [id, kind, cam, from, to, req.user.id]);
  await audit(null, { user: req.user, action: `nvr.command.${kind}`, entity: 'nvr_unit', entityId: id, zoneId: rows[0].current_zone_id, details: { command_id: ins[0].id } });
  res.status(201).json({ id: ins[0].id });
}));
router.post('/commands/:id/cancel', wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT m.id, n.current_zone_id FROM nvr_command m JOIN nvr_unit n ON n.id = m.nvr_id WHERE m.id = $1`, [parseId(req.params.id)]);
  if (!rows.length || !canSeeZone(req.user, rows[0].current_zone_id)) throw notFound('command not found');
  const r = await pool.query(`UPDATE nvr_command SET status='cancelled', completed_at=now() WHERE id=$1 AND status IN ('queued','sent','acked')`, [rows[0].id]);
  if (!r.rowCount) throw conflict('command already finished');
  res.json({ ok: true });
}));

router.get('/segments', wrap(async (req, res) => {
  const w = where();
  w.raw(zoneScope(req.user, 's.zone_id', w.params, req.query.zone_id));
  const q = req.query;
  if (q.status) w.add('s.upload_status = ?::upload_status', q.status);
  if (q.nvr_id) w.add('s.nvr_id = ?', Number(q.nvr_id));
  if (q.camera_id) w.add('s.camera_id = ?', Number(q.camera_id));
  if (q.from) w.add('s.end_time >= ?', new Date(q.from));
  if (q.to) w.add('s.start_time <= ?', new Date(q.to));
  const limit = parseLimit(q.limit, 50, 200); const offset = parseOffset(q.offset);
  const [rows, total] = await Promise.all([
    pool.query(`SELECT s.id, s.nvr_id, n.name AS nvr_name, s.camera_id, c.name AS camera_name, s.start_time, s.end_time, s.size_bytes, s.sha256, s.upload_status, s.uploaded_at,
                       u.bytes_received, u.total_bytes
                  FROM video_segment s JOIN nvr_unit n ON n.id = s.nvr_id JOIN camera c ON c.id = s.camera_id LEFT JOIN upload_session u ON u.segment_id = s.id
                 ${w.sql()} ORDER BY s.start_time DESC LIMIT ${limit} OFFSET ${offset}`, w.params),
    pool.query(`SELECT COUNT(*) AS n FROM video_segment s ${w.sql()}`, w.params),
  ]);
  res.json({ rows: rows.rows, total: total.rows[0].n });
}));

router.get('/retention', requireAdmin, wrap(async (req, res) => {
  const [pv, lastRuns] = await Promise.all([retention.preview(), pool.query(`SELECT occurred_at, details, (SELECT username FROM users WHERE id = actor_id) AS actor FROM audit_log WHERE action = 'retention.run' ORDER BY id DESC LIMIT 10`)]);
  res.json({ ...pv, runs: lastRuns.rows });
}));
router.post('/retention/run', requireAdmin, wrap(async (req, res) => {
  if (req.user.role !== 'super_admin') throw conflict('only a super admin can run retention manually (it is global across zones)');
  res.json(await retention.run({ user: req.user }));
}));

module.exports = router;
