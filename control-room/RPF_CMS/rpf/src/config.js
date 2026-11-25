require('dotenv').config();
const path = require('path');

function int(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const config = {
  // Hosts, ports and database names are NOT defaulted here: config/control-room.conf is the one place, start.sh hands them over (see main() in server.js).
  port: process.env.PORT ? Number(process.env.PORT) : undefined,
  db: {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  },
  jwtSecret: process.env.JWT_SECRET || '',
  // 0 (default) = a session never expires (the old SESSION_HOURS setting is ignored on purpose); a positive number of hours is renewed while the dashboard is open.
  sessionHours: (() => { const raw = process.env.SESSION_LIMIT_HOURS; if (raw === undefined || String(raw).trim() === '') return 0; const v = Number(raw); return Number.isFinite(v) && v >= 0 ? v : 0; })(),
  mediaRoot: path.resolve(process.env.MEDIA_ROOT || './media'),
  // Other places the CMS may have stored footage. The CMS and RPF must share one MEDIA_ROOT; when they were started
  // separately (CMS default is <CMS>/media, RPF default is ./media) the footage is not where RPF looks. RPF therefore
  // also tries MEDIA_ROOT_EXTRA (comma separated) and the CMS default folder next to this project.
  mediaRootsExtra: [
    ...String(process.env.MEDIA_ROOT_EXTRA || '').split(',').map((s) => s.trim()).filter(Boolean),
    path.join(__dirname, '..', '..', 'CMS', 'media'),
  ].map((p) => path.resolve(p)),
  // This dashboard serves ONE post. The post it is bound to is remembered here (or fixed with RPF_POST_ID).
  postFile: path.resolve(process.env.POST_FILE || path.join(__dirname, '..', 'data', 'post.json')),
  postIdFromEnv: Number(process.env.RPF_POST_ID) || null,
  footageLinkMinutes: int('FOOTAGE_LINK_MINUTES', 15),
  maxRequestWindowMin: int('MAX_REQUEST_WINDOW_MIN', 240),
  defaultRetentionDays: int('DEFAULT_RETENTION_DAYS', 365),
  maxRetentionDays: int('MAX_RETENTION_DAYS', 36500), // the longest "number of days" an officer can ask for (100 years); "for life" is a choice of its own
  alertPollSeconds: int('ALERT_POLL_SECONDS', 5),
  // Local evidence store of this post/RPF server: copies the officer chose to keep locally.
  localEvidenceDir: path.resolve(process.env.LOCAL_EVIDENCE_DIR || path.join(__dirname, '..', 'local-evidence')),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  portAuto: process.env.PORT_AUTO === '1',   // off unless asked for: the port is fixed (config/control-room.conf), the server never wanders to port+1
};

module.exports = config;
