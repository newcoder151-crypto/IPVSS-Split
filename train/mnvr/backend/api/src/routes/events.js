const express = require('express');
const { query, queryOne } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { broadcast } = require('../websocket');
const router = express.Router();

// GET /api/events
router.get('/', authenticate, async (req, res) => {
  try {
    const { camera_id, severity, event_type, acknowledged, start_date, end_date } = req.query;
    let limit = parseInt(req.query.limit, 10);
    let offset = parseInt(req.query.offset, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 100;
    if (limit > 500) limit = 500;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    const conds = [], params = [];
    if (camera_id)  { params.push(parseInt(camera_id)); conds.push(`e.camera_id=$${params.length}`); }
    if (severity)   { params.push(severity.toUpperCase()); conds.push(`e.severity=$${params.length}`); }
    if (event_type) { params.push(event_type.toUpperCase()); conds.push(`e.event_type=$${params.length}`); }
    if (acknowledged !== undefined) {
      params.push(acknowledged === 'true' ? 1 : 0);
      conds.push(`e.is_acknowledged=$${params.length}`);
    }
    if (start_date) { params.push(start_date); conds.push(`e.occurred_at>=$${params.length}`); }
    if (end_date)   { params.push(end_date);   conds.push(`e.occurred_at<=$${params.length}`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = parseInt((await query(`SELECT COUNT(*) FROM events e ${where}`, params)).rows[0].count);
    params.push(limit, offset);
    const rows = await query(
      `SELECT e.event_id, e.event_type, e.severity, e.title, e.description,
              e.camera_id, e.status, e.is_acknowledged, e.acknowledged_by, e.acknowledged_at,
              e.occurred_at, e.created_at, e.snapshot_path, e.video_clip_path,
              e.gps_latitude, e.gps_longitude, e.coach_location,
              c.camera_name, c.location_description, c.ip_address
       FROM events e
       LEFT JOIN cameras c ON e.camera_id=c.camera_id
       ${where} ORDER BY e.occurred_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`, params);
    res.json({ events: rows.rows, total, limit, offset });
  } catch (err) { console.error('[route-error]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── IMPORTANT: Static routes BEFORE /:id to prevent "batch" being parsed as an ID ──

// PUT /api/events/all/acknowledge
router.put('/all/acknowledge', authenticate, requireRole('ADMIN','OPERATOR'), async (req, res) => {
  try {
    const result = await query(
      `UPDATE events SET is_acknowledged=1, acknowledged_by=$1, acknowledged_at=NOW(),
       status='ACKNOWLEDGED', updated_at=NOW()
       WHERE is_acknowledged=0 RETURNING event_id`,
      [req.user.username]);
    broadcast({ type: 'events.batch_acknowledged', data: { count: result.rowCount } });
    res.json({ acknowledged: result.rowCount });
  } catch (err) { console.error('[route-error]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/events/batch/acknowledge
router.put('/batch/acknowledge', authenticate, requireRole('ADMIN','OPERATOR'), async (req, res) => {
  try {
    const { event_ids } = req.body;
    if (!Array.isArray(event_ids) || !event_ids.length)
      return res.status(400).json({ error: 'event_ids array required' });
    const placeholders = event_ids.map((_, i) => `$${i + 2}`).join(',');
    const result = await query(
      `UPDATE events SET is_acknowledged=1, acknowledged_by=$1, acknowledged_at=NOW(),
       status='ACKNOWLEDGED', updated_at=NOW()
       WHERE event_id IN (${placeholders}) RETURNING event_id`,
      [req.user.username, ...event_ids]);
    broadcast({ type: 'events.batch_acknowledged', data: { count: result.rowCount } });
    res.json({ acknowledged: result.rowCount });
  } catch (err) { console.error('[route-error]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/events
router.post('/', authenticate, requireRole('ADMIN','OPERATOR'), async (req, res) => {
  try {
    const { event_type, title, severity = 'INFO', camera_id, description,
            event_data, snapshot_path, video_clip_path, coach_location,
            gps_latitude, gps_longitude } = req.body;
    if (!event_type || !title) return res.status(400).json({ error: 'event_type and title required' });
    const event = await queryOne(
      `INSERT INTO events(event_type, title, severity, camera_id, description, event_data,
         snapshot_path, video_clip_path, coach_location, gps_latitude, gps_longitude, occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) RETURNING *`,
      [event_type.toUpperCase(), title, severity.toUpperCase(), camera_id || null,
       description || null, event_data ? JSON.stringify(event_data) : null,
       snapshot_path || null, video_clip_path || null, coach_location || null,
       gps_latitude || null, gps_longitude || null]);
    broadcast({ type: 'event.new', data: event });
    res.status(201).json(event);
  } catch (err) { console.error('[route-error]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── /:id routes AFTER static routes ──────────────────────────────────────────


router.put('/:id/acknowledge', authenticate, requireRole('ADMIN','OPERATOR'), async (req, res) => {
  try {
    const eventId = parseInt(req.params.id);
    if (isNaN(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
    const event = await queryOne(
      `UPDATE events SET is_acknowledged=1, acknowledged_by=$2, acknowledged_at=NOW(),
       status='ACKNOWLEDGED', updated_at=NOW()
       WHERE event_id=$1 RETURNING *`,
      [eventId, req.user.username]);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    broadcast({ type: 'event.acknowledged', data: event });
    res.json(event);
  } catch (err) { console.error('[route-error]', err); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
