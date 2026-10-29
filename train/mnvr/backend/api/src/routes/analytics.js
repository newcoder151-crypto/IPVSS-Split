/**
 * AI analytics — per-camera configuration + event ingest for the analytics
 * worker (backend/ai/analytics/worker.py).
 *
 *   GET  /api/analytics/config                    worker: enabled analytics per ACTIVE camera
 *   GET  /api/analytics/cameras/:id               UI: every analytic row for one camera
 *   PUT  /api/analytics/cameras/:id/:analytic     ADMIN: enable/disable + params
 *   POST /api/analytics/events                    worker: raise an event (-> events table + WebSocket)
 *   GET  /api/analytics/snapshot/:eventId         event snapshot JPEG (authenticateMedia)
 *
 * The worker logs in as a dedicated API_CLIENT user (see backend/ai/analytics/README.md).
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { query, queryOne } = require('../db');
const { authenticate, authenticateMedia, requireRole } = require('../middleware/auth');
const { broadcast } = require('../websocket');
const { listAnalyzers, ANALYZERS_DIR } = require('../services/analyzerRegistry');

const router = express.Router();

const STORAGE_PATH = path.resolve(process.env.STORAGE_PATH || '/storage');
const SNAPS_PATH = path.join(STORAGE_PATH, 'event_snaps');

// analytic -> event_type values it may raise. Add new analytics here.
const ANALYTICS = {
  fake:          ['AI_TEST'],
  fall_lean:     ['PASSENGER_FALLEN', 'PASSENGER_LEANING_OUT'],
  smoke:         ['SMOKE_DETECTED'],
  crowd:         ['CROWD_DENSITY'],            // the Events page already has an icon + filter for this type
  rail_obstacle: ['TRACK_OBSTACLE', 'TRACK_NOT_VISIBLE'],
};
// The analyzers the worker really has = REGISTRY in backend/ai/analytics/analyzers/__init__.py (read live). An analyzer that is
// registered there is accepted here without editing this file; ANALYTICS above only pins the event types of the known ones.
const registryNames = () => { const l = listAnalyzers().map((a) => a.name); return l.length ? l : Object.keys(ANALYTICS); };
const isKnownAnalytic = (a) => registryNames().includes(a) || Object.prototype.hasOwnProperty.call(ANALYTICS, a);
const EVENT_TYPE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const SEVERITIES = ['INFO', 'WARNING', 'ERROR', 'CRITICAL', 'EMERGENCY'];
const ID_RE = /^\d+$/;
const SNAPSHOT_RE = /^\d+\/[a-zA-Z0-9_-]+\.jpg$/;   // same shape as search_thumbs
const MAX_JSON_BYTES = 16 * 1024;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const jsonSize = (v) => Buffer.byteLength(JSON.stringify(v));

// ── worker: what should be running ───────────────────────────────────────────
router.get('/config', authenticate, requireRole('ADMIN', 'API_CLIENT'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT ca.camera_id, c.camera_name, ca.analytic, ca.params
       FROM camera_analytics ca
       JOIN cameras c ON c.camera_id = ca.camera_id
       WHERE ca.enabled AND c.status = 'ACTIVE' AND c.ai_detection_enabled
       ORDER BY ca.camera_id, ca.analytic`);
    const byCamera = new Map();
    for (const r of rows) {
      if (!byCamera.has(r.camera_id)) {
        byCamera.set(r.camera_id, { camera_id: r.camera_id, camera_name: r.camera_name, analytics: [] });
      }
      byCamera.get(r.camera_id).analytics.push({ analytic: r.analytic, params: r.params || {} });
    }
    res.json({ cameras: [...byCamera.values()] });
  } catch (err) {
    console.error('[analytics:config]', err.message);
    res.status(500).json({ error: 'Failed to load analytics config' });
  }
});

// UI: the drop-down of AI models, read live from analyzers/__init__.py
router.get('/models', authenticate, requireRole('ADMIN', 'OPERATOR'), (req, res) => {
  try {
    const list = listAnalyzers();
    if (!list.length) console.warn(`[analytics:models] no analyzers found in ${ANALYZERS_DIR}/__init__.py - using the built-in list`);
    res.json({
      source: list.length ? 'registry' : 'builtin',      // 'builtin' = __init__.py could not be read
      models: list.length ? list : Object.keys(ANALYTICS).map((name) => ({ name, label: name })),
    });
  } catch (err) {
    console.error('[analytics:models]', err.message);
    res.status(500).json({ error: 'Failed to read the analyzer list' });
  }
});

// ── UI: read / write one camera's analytics ─────────────────────────────────
router.get('/cameras/:id', authenticate, requireRole('ADMIN', 'OPERATOR'), async (req, res) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid camera id' });
    const { rows } = await query(
      `SELECT camera_id, analytic, enabled, params, updated_at, updated_by
       FROM camera_analytics WHERE camera_id=$1 ORDER BY analytic`, [req.params.id]);
    res.json({ camera_id: parseInt(req.params.id, 10), available: registryNames(), analytics: rows });
  } catch (err) {
    console.error('[analytics:get]', err.message);
    res.status(500).json({ error: 'Failed to load camera analytics' });
  }
});

router.put('/cameras/:id/:analytic', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const { id, analytic } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid camera id' });
    if (!isKnownAnalytic(analytic)) {
      return res.status(400).json({ error: `analytic must be one of: ${registryNames().join(', ')}` });
    }
    const { enabled, params } = req.body || {};
    if (enabled === undefined && params === undefined) {
      return res.status(400).json({ error: 'enabled and/or params required' });
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if (params !== undefined && (!isPlainObject(params) || jsonSize(params) > MAX_JSON_BYTES)) {
      return res.status(400).json({ error: 'params must be a JSON object under 16 KB' });
    }
    if (!(await queryOne('SELECT 1 AS ok FROM cameras WHERE camera_id=$1', [id]))) {
      return res.status(404).json({ error: 'Camera not found' });
    }
    const row = await queryOne(
      `INSERT INTO camera_analytics (camera_id, analytic, enabled, params, updated_by)
       VALUES ($1, $2, COALESCE($3::boolean, FALSE), COALESCE($4::jsonb, '{}'::jsonb), $5)
       ON CONFLICT (camera_id, analytic) DO UPDATE SET
         enabled    = COALESCE($3::boolean, camera_analytics.enabled),
         params     = COALESCE($4::jsonb, camera_analytics.params),
         updated_at = NOW(), updated_by = $5
       RETURNING camera_id, analytic, enabled, params, updated_at, updated_by`,
      [id, analytic, enabled === undefined ? null : enabled,
       params === undefined ? null : JSON.stringify(params), req.user.username || String(req.user.sub)]);
    res.json(row);
  } catch (err) {
    console.error('[analytics:put]', err.message);
    res.status(500).json({ error: 'Failed to save camera analytics' });
  }
});

// ── worker: raise an event ──────────────────────────────────────────────────
router.post('/events', authenticate, requireRole('ADMIN', 'API_CLIENT'), async (req, res) => {
  try {
    const { camera_id, analytic, event_type, severity = 'WARNING', title,
            description = '', data = {}, snapshot_path = null } = req.body || {};

    if (!ID_RE.test(String(camera_id))) return res.status(400).json({ error: 'valid camera_id required' });
    if (!isKnownAnalytic(analytic)) {
      return res.status(400).json({ error: 'unknown analytic' });
    }
    if (!ANALYTICS[analytic] && !(typeof event_type === 'string' && EVENT_TYPE_RE.test(event_type))) {
      return res.status(400).json({ error: 'event_type must be UPPER_SNAKE_CASE' });
    }
    if (ANALYTICS[analytic] && !ANALYTICS[analytic].includes(event_type)) {
      return res.status(400).json({ error: `event_type for ${analytic} must be one of: ${ANALYTICS[analytic].join(', ')}` });
    }
    if (!SEVERITIES.includes(severity)) return res.status(400).json({ error: `severity must be one of: ${SEVERITIES.join(', ')}` });
    if (typeof title !== 'string' || !title.trim() || title.length > 200) {
      return res.status(400).json({ error: 'title required (max 200 chars)' });
    }
    if (typeof description !== 'string' || description.length > 1000) {
      return res.status(400).json({ error: 'description must be a string (max 1000 chars)' });
    }
    if (!isPlainObject(data) || jsonSize(data) > MAX_JSON_BYTES) {
      return res.status(400).json({ error: 'data must be a JSON object under 16 KB' });
    }
    if (snapshot_path !== null && (typeof snapshot_path !== 'string' || !SNAPSHOT_RE.test(snapshot_path))) {
      return res.status(400).json({ error: 'invalid snapshot_path' });
    }
    if (!(await queryOne('SELECT 1 AS ok FROM cameras WHERE camera_id=$1', [camera_id]))) {
      return res.status(404).json({ error: 'Camera not found' });
    }

    const event = await queryOne(
      `INSERT INTO events (event_type, event_subtype, severity, source_device_type, source_device_id,
                           title, description, event_data, camera_id, snapshot_path, occurred_at)
       VALUES ($1,$2,$3,'CAMERA',$4,$5,$6,$7,$4,$8,NOW()) RETURNING *`,
      [event_type, analytic, severity, parseInt(camera_id, 10), title.trim(), description,
       JSON.stringify(data), snapshot_path]);
    broadcast({ type: 'event.new', data: event });
    res.status(201).json(event);
  } catch (err) {
    console.error('[analytics:event]', err.message);
    res.status(500).json({ error: 'Failed to record event' });
  }
});

// ── snapshot JPEG ────────────────────────────────────────────────────────────
router.get('/snapshot/:eventId', authenticateMedia, async (req, res) => {
  try {
    if (!ID_RE.test(req.params.eventId)) return res.status(400).end();
    const row = await queryOne('SELECT snapshot_path FROM events WHERE event_id=$1', [req.params.eventId]);
    if (!row || !row.snapshot_path) return res.status(404).end();
    // events.snapshot_path can be written by other routes with no validation,
    // so contain it here regardless of what is in the column.
    const resolved = path.resolve(SNAPS_PATH, row.snapshot_path);
    if (!resolved.startsWith(SNAPS_PATH + path.sep)) return res.status(400).end();
    if (!fs.existsSync(resolved)) return res.status(404).end();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(resolved);
  } catch (err) {
    console.error('[analytics:snapshot]', err.message);
    res.status(500).end();
  }
});

module.exports = router;
module.exports.ANALYTICS = ANALYTICS;
