const express = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// POST /api/ai/index-detection
//
// Internal ingest endpoint called by backend/ai/indexer.py for every person
// crop it detects on a camera's live stream. Each row feeds person_detections,
// which POST /api/search/smart ranks against the operator's description.

const CAMERA_ID_RE = /^\d+$/;
const THUMBNAIL_PATH_RE = /^\d+\/[a-zA-Z0-9_-]+\.jpg$/;

function safeCameraId(id) {
  return CAMERA_ID_RE.test(String(id)) ? String(id) : null;
}

function safeConfidence(requested, fallback) {
  const n = parseFloat(requested);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

router.post('/index-detection', authenticate, async (req, res) => {
  try {
    const { camera_id, occurred_at, bbox, confidence, thumbnail_path, embedding, attributes } = req.body || {};

    const cameraId = safeCameraId(camera_id);
    if (!cameraId) return res.status(400).json({ error: 'valid camera_id required' });

    if (typeof thumbnail_path !== 'string' || !THUMBNAIL_PATH_RE.test(thumbnail_path)) {
      return res.status(400).json({ error: 'invalid thumbnail_path' });
    }

    if (!Array.isArray(embedding) || embedding.length === 0 || embedding.length > 2048 ||
        !embedding.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return res.status(400).json({ error: 'embedding must be a non-empty array of finite numbers' });
    }

    const ts = occurred_at ? new Date(occurred_at) : new Date();
    if (Number.isNaN(ts.getTime())) return res.status(400).json({ error: 'invalid occurred_at' });

    const bx = Array.isArray(bbox) && bbox.length === 4 && bbox.every((n) => typeof n === 'number')
      ? bbox : [null, null, null, null];

    await query(
      `INSERT INTO person_detections
         (camera_id, occurred_at, bbox_x1, bbox_y1, bbox_x2, bbox_y2, confidence, thumbnail_path, embedding, attributes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [cameraId, ts, bx[0], bx[1], bx[2], bx[3], safeConfidence(confidence, null),
       thumbnail_path, JSON.stringify(embedding), JSON.stringify(attributes || {})],
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[ai:index-detection]', err.message);
    res.status(500).json({ error: 'Failed to index detection' });
  }
});

module.exports = router;
