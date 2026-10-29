require('dotenv').config();
const path = require('path');

function int(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const config = {
  port: int('PORT', 7090),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: int('DB_PORT', 5432),
    database: process.env.DB_NAME || 'cms',
    user: process.env.DB_USER || 'cms',
    password: process.env.DB_PASSWORD,
  },
  jwtSecret: process.env.JWT_SECRET || '',
  sessionHours: int('SESSION_HOURS', 8),
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
  alertPollSeconds: int('ALERT_POLL_SECONDS', 5),
  // Local evidence store of this post/RPF server: copies the officer chose to keep locally.
  localEvidenceDir: path.resolve(process.env.LOCAL_EVIDENCE_DIR || path.join(__dirname, '..', 'local-evidence')),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  portAuto: process.env.PORT_AUTO ? process.env.PORT_AUTO === '1' : process.env.NODE_ENV !== 'production',
};

module.exports = config;
