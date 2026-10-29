const { pool } = require('../db');
const config = require('../config');

let cache = null; let cacheAt = 0;
const TTL_MS = 5000;

async function all() {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache;
  const { rows } = await pool.query('SELECT key, value FROM setting');
  const out = { ...config.defaults };
  for (const r of rows) if (r.key in out) out[r.key] = r.value;
  cache = out; cacheAt = Date.now();
  return out;
}
async function get(key) { return (await all())[key]; }

const SCHEMA = {
  low_priority_mode: { type: 'choice', options: [['auto_deliver', 'Send to the nearest post automatically (the officer decides about an incident)'], ['operator_queue', 'Hold in the CMS queue until an operator forwards it']], label: 'Alerts BELOW the threshold' },
  priority_threshold: { type: 'int', min: 1, max: 10, label: 'Auto-dispatch priority threshold (alerts at or above go straight to a post)' },
  escalation_minutes: { type: 'int', min: 1, max: 1440, label: 'Escalate unacknowledged alerts after (minutes)' },
  request_max_window_min: { type: 'int', min: 1, max: 1440, label: 'Longest footage window per request (minutes)' },
  retention_days: { type: 'int', min: 1, max: 3650, label: 'Raw segment retention, FIFO (days)' },
  request_expiry_days: { type: 'int', min: 1, max: 3650, label: 'Expire a request still waiting for its NVR after (days)' },
  nvr_offline_after_s: { type: 'int', min: 10, max: 86400, label: 'Treat an NVR as offline after (seconds without heartbeat)' },
  auto_approve_requests: { type: 'bool', label: 'Auto-approve footage requests (demo / trusted posts only)' },
  retention_auto: { type: 'bool', label: 'Run the retention job automatically every hour' },
  notify_webhook_url: { type: 'text', label: 'Notification webhook URL (optional; receives every notification as JSON)' },
};

function coerce(key, v) {
  const s = SCHEMA[key];
  if (!s) throw new Error(`unknown setting '${key}'`);
  if (s.type === 'choice') { if (!s.options.some(([o]) => o === String(v))) throw new Error(`${key}: choose one of ${s.options.map(([x]) => x).join(', ')}`); return String(v); }
  if (s.type === 'bool') return v === true || v === 'true' || v === 1 || v === '1';
  if (s.type === 'int') {
    const n = Number(v);
    if (!Number.isInteger(n) || n < s.min || n > s.max) throw new Error(`${key} must be a whole number between ${s.min} and ${s.max}`);
    return n;
  }
  return String(v || '').trim().slice(0, 500);
}
async function set(key, value, userId) {
  const v = coerce(key, value);
  await pool.query(
    `INSERT INTO setting (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(v), userId || null]
  );
  cache = null;
  return v;
}
module.exports = { all, get, set, SCHEMA };
