/**
 * All settings come from the environment (or bridge/.env). Nothing here touches the M-NVR, CMS or RPF code.
 */
const fs = require('fs');
const path = require('path');

// tiny .env loader (no extra dependency); real environment variables win
(function loadEnv() {
  const file = process.env.BRIDGE_ENV_FILE || path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const env = process.env;
const num = (k, d) => { const v = Number(env[k]); return env[k] !== undefined && env[k] !== '' && Number.isFinite(v) ? v : d; };
const bool = (k, d) => (env[k] === undefined || env[k] === '' ? d : /^(1|true|yes|on)$/i.test(env[k]));

function parseCameraMap(s) { // "1:10,2:11"  =  mNVR camera 1 -> CMS camera 10 ...
  const m = new Map();
  for (const part of String(s || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [a, b] = part.split(':').map(Number);
    if (Number.isInteger(a) && Number.isInteger(b)) m.set(a, b);
  }
  return m;
}

const config = {
  cmsUrl: (env.CMS_URL || 'http://localhost:7080').replace(/\/+$/, ''),
  fingerprint: env.NVR_FINGERPRINT || '',

  db: {
    host: env.MNVR_DB_HOST || 'localhost', port: num('MNVR_DB_PORT', 5432),
    database: env.MNVR_DB_NAME || 'mnvr', user: env.MNVR_DB_USER || 'mnvr', password: env.MNVR_DB_PASSWORD || '',
  },
  stateDir: path.resolve(env.STATE_DIR || path.join(__dirname, '..', 'state')),
  statusPort: num('STATUS_PORT', 8095),         // 0 = no status endpoint
  recordingsDir: env.RECORDINGS_DIR || '',      // only used to report disk usage in the heartbeat

  heartbeatS: num('HEARTBEAT_S', 5),
  gpsTrackMinIntervalS: num('GPS_TRACK_MIN_INTERVAL_S', 5),
  gpsBatch: Math.min(500, num('GPS_BATCH', 300)),
  gpsStaleS: num('GPS_STALE_S', 30),

  alertPollMs: num('ALERT_POLL_MS', 1000),
  alertBackfillMin: num('ALERT_BACKFILL_MIN', 0),   // on the very first start: also send events from the last N minutes
  alertGpsMaxAgeS: num('ALERT_GPS_MAX_AGE_S', 120), // how far from the event a GPS fix may be to be used as its position
  alertGpsWaitS: num('ALERT_GPS_WAIT_S', 30),       // how long to wait for a fix before giving up on an alert
  fallbackLat: env.FALLBACK_LAT ? Number(env.FALLBACK_LAT) : null,
  fallbackLon: env.FALLBACK_LON ? Number(env.FALLBACK_LON) : null,
  alertRulesFile: path.resolve(env.ALERT_RULES_FILE || path.join(__dirname, '..', 'config', 'alert-rules.json')),

  chunkBytes: num('CHUNK_BYTES', 1024 * 1024),
  uploadPatienceH: num('UPLOAD_PATIENCE_H', 24),    // how long a transfer waits for the signal before giving up (it is retried later anyway)
  uploadMaxKbps: num('UPLOAD_MAX_KBPS', 0),         // 0 = unlimited
  uploadConcurrency: Math.max(1, num('UPLOAD_CONCURRENCY', 2)),
  openSegmentExtraWaitS: num('OPEN_SEGMENT_EXTRA_WAIT_S', 75), // + segment length: how long to wait for the segment being recorded

  autoUploadOnAlert: bool('AUTO_UPLOAD_ON_ALERT', false),      // push footage around a serious alert before anyone asks
  autoPreS: num('AUTO_UPLOAD_PRE_S', 60),
  autoPostS: num('AUTO_UPLOAD_POST_S', 60),
  autoMinPriority: num('AUTO_UPLOAD_MIN_PRIORITY', 7),

  cameraMap: parseCameraMap(env.CAMERA_MAP),
};

module.exports = config;
