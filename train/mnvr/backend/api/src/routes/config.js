const express = require('express');
const os = require('os');
const { query, queryOne } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const router = express.Router();

// GET /api/config/status — system dashboard stats
router.get('/status', authenticate, async (req, res) => {
  try {
    const [cams, evts, recs, health, storage] = await Promise.all([
      query(`SELECT status, COUNT(*) as count FROM cameras GROUP BY status`),
      query(`SELECT severity, COUNT(*) as count FROM events WHERE is_acknowledged=0 GROUP BY severity`),
      query(`SELECT COUNT(*) as total, COUNT(CASE WHEN status='RECORDING' THEN 1 END) as active FROM recordings`),
      queryOne(`SELECT * FROM system_health ORDER BY timestamp DESC LIMIT 1`),
      query(`SELECT * FROM storage_devices ORDER BY storage_id`),
    ]);
    const cameraStats = cams.rows.reduce((a, r) => { a[r.status] = parseInt(r.count); return a; }, {});
    const eventsBySev = evts.rows.reduce((a, r) => { a[r.severity] = parseInt(r.count); return a; }, {});
    res.json({
      system: {
        uptime_seconds: Math.floor(process.uptime()),
        version: '2.0.0',
        hostname: os.hostname(),
        memory: process.memoryUsage(),
        load_avg: os.loadavg(),
      },
      cameras: { total: Object.values(cameraStats).reduce((s, v) => s + v, 0), ...cameraStats },
      events: { unacknowledged: Object.values(eventsBySev).reduce((s, v) => s + v, 0), by_severity: eventsBySev },
      recordings: { total: parseInt(recs.rows[0]?.total || 0), active: parseInt(recs.rows[0]?.active || 0) },
      health: health || null,
      storage: storage.rows,
    });
  } catch (err) { console.error('[route-error]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/config/dashboard — alias used by frontend useDashboardStats
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [cameras, events] = await Promise.all([
      query(`SELECT camera_id, camera_name, status, location_description, camera_type FROM cameras ORDER BY camera_name`),
      query(`SELECT event_id, severity, is_acknowledged, event_type, camera_id, title, description, occurred_at
             FROM events WHERE occurred_at>=$1 ORDER BY occurred_at DESC LIMIT 100`, [since24h]),
    ]);
    const activeCameras = cameras.rows.filter(c => c.status === 'ACTIVE').length;
    const unacknowledgedAlerts = events.rows.filter(e => e.is_acknowledged === 0).length;
    res.json({
      activeCameras,
      totalCameras: cameras.rows.length,
      totalEvents: events.rows.length,
      unacknowledgedAlerts,
      recentAlerts: events.rows.filter(e => e.is_acknowledged === 0).slice(0, 5),
      cameras: cameras.rows,
    });
  } catch (err) { console.error('[route-error]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/config
router.get('/', authenticate, async (req, res) => {
  try {
    const rows = await query(`SELECT * FROM system_config ORDER BY config_key`);
    res.json({ config: rows.rows });
  } catch (err) { console.error('[route-error]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/config/:key
router.get('/:key', authenticate, async (req, res) => {
  try {
    const row = await queryOne(`SELECT * FROM system_config WHERE config_key=$1`, [req.params.key]);
    if (!row) return res.status(404).json({ error: 'Config key not found' });
    res.json(row);
  } catch (err) { console.error('[route-error]', err); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/config/:key
router.put('/:key', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const { config_value } = req.body;
    if (config_value === undefined) return res.status(400).json({ error: 'config_value required' });
    const existing = await queryOne(`SELECT is_readonly FROM system_config WHERE config_key=$1`, [req.params.key]);
    if (existing?.is_readonly === 1) return res.status(403).json({ error: 'This config key is read-only' });
    const row = await queryOne(
      `UPDATE system_config SET config_value=$1, last_modified_at=NOW(), last_modified_by=$2
       WHERE config_key=$3 RETURNING *`,
      [config_value, req.user.username, req.params.key]);
    if (!row) return res.status(404).json({ error: 'Config key not found' });
    res.json(row);
  } catch (err) { console.error('[route-error]', err); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
