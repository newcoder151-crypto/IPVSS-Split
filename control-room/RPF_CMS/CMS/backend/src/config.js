require('dotenv').config();
const path = require('path');
const crypto = require('crypto');

const int = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };

let jwtSecret = process.env.CMS_JWT_SECRET || process.env.JWT_SECRET || '';
let ephemeralSecret = false;
if (jwtSecret.length < 32) { jwtSecret = crypto.randomBytes(48).toString('hex'); ephemeralSecret = true; }

module.exports = {
  version: '0.2.1',
  port: int('PORT', 7080),
  // If the port is taken, try the next ones (development). Off in production, or with PORT_AUTO=0.
  portAuto: process.env.PORT_AUTO ? process.env.PORT_AUTO === '1' : process.env.NODE_ENV !== 'production',
  env: process.env.NODE_ENV || 'development',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: int('DB_PORT', 5432),
    database: process.env.DB_NAME || 'cms',
    user: process.env.DB_USER || 'cms',
    password: process.env.DB_PASSWORD,
  },
  jwtSecret, ephemeralSecret,
  sessionHours: int('SESSION_HOURS', 8),
  // Footage store (object-storage stand-in). Shared with the RPF server, which reads delivered
  // footage and archived clips from the same root.
  mediaRoot: path.resolve(process.env.MEDIA_ROOT || path.join(__dirname, '..', '..', 'media')),
  footageLinkMinutes: int('FOOTAGE_LINK_MINUTES', 15),
  workers: process.env.CMS_WORKERS !== '0',
  // Defaults for runtime settings (the console overrides them in the `setting` table).
  defaults: {
    priority_threshold: int('PRIORITY_THRESHOLD', 7),   // >= : auto-dispatch to nearest post + incident
    escalation_minutes: int('ESCALATION_MINUTES', 10),  // unacknowledged this long -> next post
    low_priority_mode: ['auto_deliver', 'operator_queue'].includes(process.env.LOW_PRIORITY_MODE) ? process.env.LOW_PRIORITY_MODE : 'auto_deliver',   // alerts below the threshold: deliver to the nearest post, or hold for an operator
    request_max_window_min: int('MAX_REQUEST_WINDOW_MIN', 240),
    retention_days: int('RETENTION_DAYS', 30),          // 30-day FIFO on raw segments
    request_expiry_days: int('REQUEST_EXPIRY_DAYS', 25),// a request waiting this long for its NVR expires
    nvr_offline_after_s: int('NVR_OFFLINE_AFTER_S', 60),
    auto_approve_requests: process.env.AUTO_APPROVE_REQUESTS === '1',
    retention_auto: process.env.RETENTION_AUTO !== '0',
    notify_webhook_url: process.env.NOTIFY_WEBHOOK_URL || '',
  },
  // Test lab in the console (send alerts as an NVR, put a train in a tunnel). On in development, off in production.
  devTools: process.env.DEV_TOOLS ? process.env.DEV_TOOLS === '1' : process.env.NODE_ENV !== 'production',
  // Where the M-NVR simulator looks for its offline flags (must match the simulator's SIM_DIR / CMS/run).
  simDir: path.resolve(process.env.SIM_DIR || path.join(__dirname, '..', '..', 'run')),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  legacyApi: process.env.LEGACY_API ? process.env.LEGACY_API === '1' : (process.env.NODE_ENV !== 'production'),
};
