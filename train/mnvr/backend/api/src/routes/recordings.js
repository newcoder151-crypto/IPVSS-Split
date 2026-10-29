const express = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const router = express.Router();

// GET /api/recordings
router.get('/', authenticate, async (req, res) => {
  try {
    const { camera_id, start_date, end_date, status, q } = req.query;
    let limit = parseInt(req.query.limit, 10);
    let offset = parseInt(req.query.offset, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    if (limit > 500) limit = 500;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    const conds = [], params = [];
    if (camera_id)  { params.push(parseInt(camera_id)); conds.push(`r.camera_id=$${params.length}`); }
    if (start_date) { params.push(start_date); conds.push(`r.start_timestamp>=$${params.length}`); }
    if (end_date)   { params.push(end_date);   conds.push(`r.start_timestamp<=$${params.length}`); }
    if (status)     { params.push(status.toUpperCase()); conds.push(`r.status=$${params.length}`); }
    if (q && q.trim()) {
      // Free-text search across camera name / location, applied at the
      // query level (not just to whatever page happens to be loaded in
      // the browser) so it works correctly together with pagination.
      params.push(`%${q.trim()}%`);
      conds.push(`(c.camera_name ILIKE $${params.length} OR c.location_description ILIKE $${params.length})`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = parseInt((await query(
      `SELECT COUNT(*) FROM recordings r LEFT JOIN cameras c ON r.camera_id=c.camera_id ${where}`,
      params)).rows[0].count);
    params.push(limit, offset);
    const rows = await query(
      `SELECT r.recording_id, r.camera_id, r.file_path, r.file_name,
              r.file_size_bytes, r.duration_seconds, r.start_timestamp, r.end_timestamp,
              r.video_codec, r.resolution_width, r.resolution_height, r.fps_actual,
              r.has_audio, r.recording_mode, r.status, r.hls_playlist_path,
              r.gps_latitude, r.gps_longitude, r.gps_speed_kmh, r.created_at,
              c.camera_name, c.location_description, c.camera_type, c.ip_address
       FROM recordings r
       LEFT JOIN cameras c ON r.camera_id=c.camera_id
       ${where}
       ORDER BY r.start_timestamp DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params);
    res.json({ recordings: rows.rows, total, limit, offset });
  } catch (err) { console.error('[route-error]', err); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
