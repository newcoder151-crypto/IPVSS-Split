/**
 * Smart Search (CLIP-based) — "find a person in a red t-shirt between 2 and
 * 4pm" style natural-language queries over live-indexed footage.
 *
 * How it works:
 *  1. Parse an explicit clock time range out of the prompt if present
 *     ("2 to 4pm", "between 14:00 and 16:00", ...), else fall back to named
 *     time-of-day words, else default to the last 24h.
 *  2. Send whatever text is left (the actual description, e.g. "person in a
 *     red t-shirt") to the sidecar's CLIP text tower for an embedding.
 *  3. Pull candidate rows from person_detections within that time window
 *     (indexed near-real-time by backend/ai/indexer.py) and rank them by
 *     cosine similarity against the query embedding.
 *  4. For each result, build a thumbnail URL and a clip URL that reuses the
 *     EXISTING /api/streaming/recordings/export range-export endpoint — no
 *     new clip-extraction logic needed, it already stitches/trims recording
 *     segments for an arbitrary [start,end] window.
 *
 * NOTE on timestamps: this file deliberately never calls .toISOString() —
 * see toApiDateTime()'s comment in src/lib/utils.ts. recordings.start_timestamp
 * (and, by the same convention, person_detections.occurred_at) is a
 * timezone-naive column compared against naive "local wall clock" strings;
 * mixing in a UTC-converted ISO string here would silently shift the window
 * exactly like the bug that comment describes.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { query, queryOne } = require('../db');
const { authenticate, authenticateMedia } = require('../middleware/auth');
const router = express.Router();

const YOLO_URL = () => process.env.YOLO_SIDECAR_URL || 'http://localhost:8000';
const STORAGE_PATH = path.resolve(process.env.STORAGE_PATH || '/storage');
const THUMBS_PATH = path.join(STORAGE_PATH, 'search_thumbs');

const SIMILARITY_FLOOR = 0.18; // below this, CLIP cosine similarity is noise, not a match
const CLIP_LEAD_IN_SECS = 8;
const CLIP_TAIL_SECS = 12;
const MAX_CANDIDATES = 3000;

// Same formatting as src/lib/utils.ts's toApiDateTime — naive local wall
// clock, no timezone conversion, no trailing 'Z'.
function toNaiveLocalString(date) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

// Matches "2 to 4pm", "2pm to 4pm", "between 2 and 4 pm", "14:00-16:00", etc.
function parseClockRange(lowerText) {
  const re = /(?:between\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-|and)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
  const m = lowerText.match(re);
  if (!m) return null;
  let [, h1, min1, ap1, h2, min2, ap2] = m;
  h1 = parseInt(h1, 10); h2 = parseInt(h2, 10);
  min1 = min1 ? parseInt(min1, 10) : 0;
  min2 = min2 ? parseInt(min2, 10) : 0;
  if (h1 > 23 || h2 > 23) return null; // avoid false-positives like "camera 3 to 5"

  const period1 = ap1 || ap2; // "2 to 4pm" applies the trailing "pm" to both
  const period2 = ap2 || ap1;
  const to24 = (h, period) => {
    if (!period) return h;
    period = period.toLowerCase();
    if (period === 'am') return h === 12 ? 0 : h;
    return h === 12 ? 12 : h + 12;
  };
  return {
    from_hour: to24(h1, period1), from_min: min1,
    to_hour: to24(h2, period2), to_min: min2,
    matchedText: m[0],
  };
}

const NAMED_TIME_OF_DAY = {
  morning: [6, 12], afternoon: [12, 17], evening: [17, 21], night: [21, 24], midnight: [0, 4], dawn: [4, 7],
};

function resolveTimeWindow(lowerText) {
  const now = new Date();
  const dayBase = new Date(now);
  dayBase.setHours(0, 0, 0, 0);
  if (/\byesterday\b/.test(lowerText)) dayBase.setDate(dayBase.getDate() - 1);

  const clock = parseClockRange(lowerText);
  if (clock) {
    const start = new Date(dayBase); start.setHours(clock.from_hour, clock.from_min, 0, 0);
    const end = new Date(dayBase); end.setHours(clock.to_hour, clock.to_min, 0, 0);
    if (end <= start) end.setDate(end.getDate() + 1); // range crosses midnight
    return { start, end, label: clock.matchedText, matched: clock.matchedText };
  }

  const namedKey = Object.keys(NAMED_TIME_OF_DAY).find((k) => lowerText.includes(k));
  if (namedKey) {
    const [fh, th] = NAMED_TIME_OF_DAY[namedKey];
    const start = new Date(dayBase); start.setHours(fh, 0, 0, 0);
    const end = new Date(dayBase); end.setHours(th, 0, 0, 0);
    return { start, end, label: namedKey, matched: namedKey };
  }

  if (/\byesterday\b/.test(lowerText)) {
    const end = new Date(dayBase); end.setDate(end.getDate() + 1);
    return { start: dayBase, end, label: 'yesterday', matched: 'yesterday' };
  }

  // Default: last 24 hours — keeps a query with no time phrase useful
  // instead of erroring out.
  return { start: new Date(now.getTime() - 24 * 3600 * 1000), end: now, label: null, matched: null };
}

function cosineSimilarity(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// POST /api/search/smart — { prompt, limit? }
router.post('/', authenticate, async (req, res) => {
  try {
    const { prompt = '', limit = 24 } = req.body || {};
    if (!prompt.trim()) return res.status(400).json({ error: 'prompt is required' });
    const lower = prompt.toLowerCase();

    const { start, end, matched } = resolveTimeWindow(lower);

    let cameraId = null;
    const camMatch = lower.match(/(?:camera|cam)\s*(\d+)/);
    if (camMatch) cameraId = parseInt(camMatch[1], 10);

    // Strip the matched time phrase + a few structural words so the CLIP
    // text embedding is computed on the actual visual description, not on
    // "between 2 and 4pm" noise.
    let descText = prompt;
    if (matched) descText = descText.replace(new RegExp(matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '');
    descText = descText
      .replace(/\bbetween\b/ig, '')
      .replace(/\b(morning|afternoon|evening|night|midnight|dawn|today|yesterday)\b/ig, '')
      .replace(/(?:camera|cam)\s*\d+/ig, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!descText) descText = prompt.trim();

    let queryEmbedding;
    try {
      const embedTextParams = new URLSearchParams({ text: descText });
      const r = await axios.post(`${YOLO_URL()}/embed-text`, embedTextParams, { timeout: 15000 });
      queryEmbedding = r.data.embedding;
    } catch (err) {
      console.error('[smart-search:embed-text]', err.message);
      return res.status(502).json({
        error: 'Smart search AI service unavailable',
        hint: `Is the sidecar running at ${YOLO_URL()}? (needs the CLIP dependencies installed)`,
      });
    }

    const conds = ['occurred_at >= $1', 'occurred_at <= $2'];
    const params = [toNaiveLocalString(start), toNaiveLocalString(end)];
    if (cameraId) { params.push(cameraId); conds.push(`camera_id = $${params.length}`); }

    const candidates = (await query(
      `SELECT d.detection_id, d.camera_id, d.occurred_at, d.thumbnail_path, d.embedding, d.attributes,
              c.camera_name, c.location_description
       FROM person_detections d
       LEFT JOIN cameras c ON d.camera_id = c.camera_id
       WHERE ${conds.join(' AND ')}
       ORDER BY d.occurred_at DESC
       LIMIT ${MAX_CANDIDATES}`,
      params,
    )).rows;

    const scored = candidates
      .map((row) => {
        let embedding = [];
        try { embedding = JSON.parse(row.embedding); } catch { /* leave empty — scores 0 */ }
        return { row, similarity: cosineSimilarity(queryEmbedding, embedding) };
      })
      .filter((s) => s.similarity >= SIMILARITY_FLOOR)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, Math.max(1, Math.min(parseInt(limit, 10) || 24, 50)));

    const results = scored.map(({ row, similarity }) => {
      const occurred = new Date(row.occurred_at);
      const clipStart = new Date(occurred.getTime() - CLIP_LEAD_IN_SECS * 1000);
      const clipEnd = new Date(occurred.getTime() + CLIP_TAIL_SECS * 1000);
      let attrs = {};
      try { attrs = JSON.parse(row.attributes || '{}'); } catch { /* default {} */ }

      return {
        detection_id: row.detection_id,
        camera_id: row.camera_id,
        camera_name: row.camera_name,
        location: row.location_description,
        occurred_at: row.occurred_at,
        similarity: Math.round(similarity * 1000) / 1000,
        caption: attrs.caption || null,
        thumbnail_url: `/api/search/smart/thumbnail/${row.detection_id}`,
        // Fed straight into the EXISTING exportRecordingRange()/export
        // endpoint on the frontend — no new clip-extraction code needed,
        // it already stitches/trims recording segments for [start,end].
        clip_start: toNaiveLocalString(clipStart),
        clip_end: toNaiveLocalString(clipEnd),
      };
    });

    res.json({
      query: prompt,
      interpreted: {
        time_range: { start: toNaiveLocalString(start), end: toNaiveLocalString(end) },
        time_phrase: matched,
        camera_id: cameraId,
        description_used: descText,
      },
      candidates_scanned: candidates.length,
      results,
    });
  } catch (err) {
    console.error('[smart-search]', err);
    res.status(500).json({ error: 'Smart search failed' });
  }
});

// GET /api/search/smart/thumbnail/:id — serves the stored person-crop JPEG.
// Uses authenticateMedia (bearer OR ?token=) the same way HLS segments do,
// since an <img src> can't attach an Authorization header.
router.get('/thumbnail/:id', authenticateMedia, async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).end();
    const row = await queryOne('SELECT thumbnail_path FROM person_detections WHERE detection_id=$1', [req.params.id]);
    if (!row) return res.status(404).end();

    const resolved = path.resolve(THUMBS_PATH, row.thumbnail_path);
    // Reject anything that would resolve outside THUMBS_PATH — thumbnail_path
    // is already validated at write time (POST /api/ai/index-detection), but
    // this is cheap insurance against any future writer being less careful.
    if (!resolved.startsWith(THUMBS_PATH + path.sep)) return res.status(400).end();
    if (!fs.existsSync(resolved)) return res.status(404).end();

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(resolved);
  } catch (err) {
    console.error('[smart-search:thumbnail]', err.message);
    res.status(500).end();
  }
});

module.exports = router;
