const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

/** Resolve a path relative to MEDIA_ROOT; anything that escapes the root is refused. */
function absPath(rel) {
  const root = config.mediaRoot;
  const p = path.resolve(root, String(rel || '').replace(/^file:\/\//, ''));
  const r = path.relative(root, p);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error('path escapes MEDIA_ROOT');
  return p;
}
const ensureDir = (file) => fs.mkdirSync(path.dirname(file), { recursive: true });
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}
const mimeFor = (format) => ({ mp4: 'video/mp4', avi: 'video/x-msvideo', mkv: 'video/x-matroska' }[String(format || '').toLowerCase()] || 'application/octet-stream');

module.exports = { absPath, ensureDir, exists, sha256File, mimeFor };
