const express = require('express');
const { pool } = require('../../db');
const { zoneScope } = require('../../middleware/auth');
const settings = require('../../services/settings');
const { wrap } = require('../../errors');

const router = express.Router();

/** GET /dashboard - every number on the console home page, zone-scoped. */
router.get('/dashboard', wrap(async (req, res) => {
  const cfg = await settings.all();
  const z = (col, params) => zoneScope(req.user, col, params, req.query.zone_id);
  const age = (sec) => { sec = Math.round(sec || 0); return sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} min` : sec < 172800 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86400)} days`; };
  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
  const many = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const offline = cfg.nvr_offline_after_s;

  let p = [offline];
  const nvr = await one(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE last_seen > now() - make_interval(secs => $1)) AS online,
            COUNT(*) FILTER (WHERE status <> 'active') AS suspended
       FROM nvr_unit n WHERE ${z('n.current_zone_id', p)}`, p);

  p = [];
  const alerts = await one(
    `SELECT COUNT(*) FILTER (WHERE a.event_time > now() - interval '24 hours') AS last_24h,
            COUNT(*) FILTER (WHERE a.event_time > now() - interval '24 hours' AND a.priority >= $${p.push(cfg.priority_threshold)}) AS high_24h,
            COUNT(*) FILTER (WHERE a.status = 'new') AS queue,
            COUNT(*) FILTER (WHERE a.status = 'escalated') AS escalated,
            EXTRACT(EPOCH FROM now() - MIN(a.received_time) FILTER (WHERE a.status = 'new')) AS oldest_queue_s
       FROM alert a WHERE ${z('a.zone_id', p)} AND a.event_time > now() - interval '30 days'`, p);

  p = [];
  const byHour = await many(
    `SELECT date_trunc('hour', a.event_time) AS hour, COUNT(*) AS n, COUNT(*) FILTER (WHERE a.priority >= $${p.push(cfg.priority_threshold)}) AS high
       FROM alert a WHERE ${z('a.zone_id', p)} AND a.event_time > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`, p);
  p = [];
  const byType = await many(
    `SELECT a.alert_type, COUNT(*) AS n FROM alert a WHERE ${z('a.zone_id', p)} AND a.event_time > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, p);

  p = [];
  const unacked = await one(
    `SELECT COUNT(DISTINCT d.alert_id) AS n, EXTRACT(EPOCH FROM now() - MIN(d.sent_at)) AS oldest_s
       FROM alert_delivery d JOIN alert a ON a.id = d.alert_id AND a.event_time = d.alert_event_time JOIN rpf_post po ON po.id = d.post_id
      WHERE d.ack_at IS NULL AND a.status IN ('routed','escalated') AND ${z('po.zone_id', p)}`, p);

  p = [];
  const requests = await one(
    `SELECT COUNT(*) FILTER (WHERE r.status = 'submitted') AS needs_decision,
            COUNT(*) FILTER (WHERE r.status = 'awaiting_upload') AS awaiting_upload,
            COUNT(*) FILTER (WHERE r.status = 'fulfilled' AND r.fulfilled_at > now() - interval '24 hours') AS fulfilled_24h,
            COUNT(*) FILTER (WHERE r.status IN ('failed','expired') AND r.created_at > now() - interval '7 days') AS failed_7d,
            EXTRACT(EPOCH FROM now() - MIN(r.created_at) FILTER (WHERE r.status = 'submitted')) AS oldest_s
       FROM video_request r JOIN rpf_post po ON po.id = r.post_id WHERE ${z('po.zone_id', p)}`, p);

  p = [];
  const incidents = await one(
    `SELECT COUNT(*) FILTER (WHERE i.status = 'open') AS open, COUNT(*) FILTER (WHERE i.status = 'under_review') AS under_review,
            COUNT(*) FILTER (WHERE i.created_at > now() - interval '24 hours') AS last_24h
       FROM incident i JOIN rpf_post po ON po.id = i.post_id WHERE ${z('po.zone_id', p)}`, p);

  p = [];
  const segs = await one(
    `SELECT COUNT(*) FILTER (WHERE upload_status IN ('pending','partial')) AS uploading,
            COUNT(*) FILTER (WHERE upload_status = 'failed') AS failed,
            COUNT(*) FILTER (WHERE upload_status = 'complete') AS stored,
            COALESCE(SUM(size_bytes) FILTER (WHERE upload_status = 'complete'), 0) AS stored_bytes
       FROM video_segment s WHERE ${z('s.zone_id', p)}`, p);

  p = [];
  const evidence = await one(
    `SELECT COUNT(*) FILTER (WHERE e.status = 'active') AS active,
            COUNT(*) FILTER (WHERE e.status = 'active' AND e.retention = 'permanent') AS permanent,
            COUNT(*) FILTER (WHERE e.status = 'active' AND e.archive_status = 'pending') AS pending_archive,
            COUNT(*) FILTER (WHERE e.status = 'active' AND e.archive_status = 'failed') AS failed_archive,
            COALESCE(SUM(e.archive_size_bytes), 0) AS archive_bytes
       FROM evidence_flag e JOIN delivered_footage f ON f.id = e.footage_id JOIN video_request r ON r.id = f.video_request_id
       JOIN rpf_post po ON po.id = r.post_id WHERE ${z('po.zone_id', p)}`, p);

  p = [];
  const attention = [];
  if (+alerts.queue > 0) attention.push({ level: alerts.oldest_queue_s > 300 ? 'red' : 'amber', text: `${alerts.queue} low-priority alert(s) waiting for an operator (oldest ${age(alerts.oldest_queue_s)})`, view: 'queue' });
  if (+alerts.escalated > 0) attention.push({ level: 'red', text: `${alerts.escalated} alert(s) escalated - no post acknowledged`, view: 'alerts', params: { status: 'escalated' } });
  if (+requests.needs_decision > 0) attention.push({ level: 'amber', text: `${requests.needs_decision} footage request(s) waiting for approval`, view: 'requests', params: { tab: 'decide' } });
  if (+evidence.failed_archive > 0) attention.push({ level: 'red', text: `${evidence.failed_archive} evidence archive(s) failed`, view: 'evidence' });
  if (+segs.failed > 0) attention.push({ level: 'amber', text: `${segs.failed} segment upload(s) failed verification`, view: 'segments', params: { status: 'failed' } });
  const stuck = await many(
    `SELECT DISTINCT n.name FROM video_request r JOIN camera c ON c.id = r.camera_id JOIN nvr_unit n ON n.id = c.nvr_id JOIN rpf_post po ON po.id = r.post_id
      WHERE r.status = 'awaiting_upload' AND (n.last_seen IS NULL OR n.last_seen < now() - make_interval(secs => $1)) AND ${z('po.zone_id', (p = [offline]))}`, p);
  if (stuck.length) attention.push({ level: 'amber', text: `Waiting for offline NVR(s): ${stuck.map((s) => s.name).join(', ')}`, view: 'fleet' });

  p = [];
  const activity = await many(
    `SELECT a.id, a.occurred_at, a.action, a.entity, a.entity_id, u.username AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE ${req.user.role === 'super_admin' ? 'TRUE' : z('a.zone_id', p)} ORDER BY a.id DESC LIMIT 12`, p);
  const jobs = await many('SELECT name, last_run_at, last_ok, last_message FROM job_status ORDER BY name');

  res.json({ nvr, alerts, unacked, requests, incidents, segments: segs, evidence, by_hour: byHour, by_type: byType, attention, activity, jobs,
    threshold: cfg.priority_threshold, generated_at: new Date() });
}));

/** GET /counts - the few numbers the navigation badges need; cheap enough to refetch on every live event. */
router.get('/counts', wrap(async (req, res) => {
  let p = [];
  const a = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'new') AS queue, COUNT(*) FILTER (WHERE status = 'escalated') AS escalated,
    (SELECT COUNT(DISTINCT d.alert_id) FROM alert_delivery d JOIN alert a2 ON a2.id = d.alert_id AND a2.event_time = d.alert_event_time JOIN rpf_post po ON po.id = d.post_id WHERE d.ack_at IS NULL AND a2.status IN ('routed','escalated') AND ${zoneScope(req.user, 'po.zone_id', p, req.query.zone_id)}) AS unacked
    FROM alert a WHERE a.event_time > now() - interval '30 days' AND ${zoneScope(req.user, 'a.zone_id', p, req.query.zone_id)}`, p)).rows[0];
  p = [];
  const r = (await pool.query(`SELECT COUNT(*) FILTER (WHERE r.status = 'submitted') AS decide, COUNT(*) FILTER (WHERE r.status = 'awaiting_upload') AS waiting FROM video_request r JOIN rpf_post po ON po.id = r.post_id WHERE ${zoneScope(req.user, 'po.zone_id', p, req.query.zone_id)}`, p)).rows[0];
  p = [];
  const e = (await pool.query(`SELECT COUNT(*) AS failed FROM evidence_flag e JOIN delivered_footage f ON f.id = e.footage_id JOIN video_request r ON r.id = f.video_request_id JOIN rpf_post po ON po.id = r.post_id WHERE e.archive_status = 'failed' AND e.status = 'active' AND ${zoneScope(req.user, 'po.zone_id', p, req.query.zone_id)}`, p)).rows[0];
  res.json({ queue: +a.queue, escalated: +a.escalated, unacked: +a.unacked, decide: +r.decide, waiting: +r.waiting, archive_failed: +e.failed });
}));

/** GET /map - posts, units (last position) and the last day's alerts, for the geo plot. */
router.get('/map', wrap(async (req, res) => {
  const cfg = await settings.all();
  let p = [];
  const posts = (await pool.query(
    `SELECT po.id, po.name, po.zone_id, z.name AS zone_name, ST_Y(po.location::geometry) AS lat, ST_X(po.location::geometry) AS lon, po.active
       FROM rpf_post po JOIN zone z ON z.id = po.zone_id WHERE ${zoneScope(req.user, 'po.zone_id', p, req.query.zone_id)}`, p)).rows;
  p = [cfg.nvr_offline_after_s];
  const nvrs = (await pool.query(
    `SELECT n.id, n.name, n.train_no, n.current_zone_id AS zone_id, n.last_lat AS lat, n.last_lon AS lon, n.last_speed_mps, n.last_seen,
            (n.last_seen > now() - make_interval(secs => $1)) AS online
       FROM nvr_unit n WHERE n.last_lat IS NOT NULL AND ${zoneScope(req.user, 'n.current_zone_id', p, req.query.zone_id)}`, p)).rows;
  p = [];
  const alerts = (await pool.query(
    `SELECT a.id, a.alert_type, a.priority, a.status, a.event_time, ST_Y(a.location::geometry) AS lat, ST_X(a.location::geometry) AS lon, n.name AS nvr_name
       FROM alert a JOIN nvr_unit n ON n.id = a.nvr_id
      WHERE a.event_time > now() - interval '24 hours' AND ${zoneScope(req.user, 'a.zone_id', p, req.query.zone_id)} ORDER BY a.event_time DESC LIMIT 300`, p)).rows;
  res.json({ posts, nvrs, alerts, threshold: cfg.priority_threshold });
}));

module.exports = router;
