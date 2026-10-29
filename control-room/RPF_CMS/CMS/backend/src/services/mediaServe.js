const fs = require('fs');
const { HttpError } = require('../errors');

/** Serve a file with HTTP Range support (so a <video> can seek) and an integrity header. */
function serveFile(req, res, { file, size, mime, download, filename, sha256 }) {
  const headers = {
    'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  };
  if (sha256) headers['X-Content-SHA256'] = sha256;
  if (download) headers['Content-Disposition'] = `attachment; filename="${String(filename || 'footage').replace(/[^\w.\-]/g, '_')}"`;
  let start = 0; let end = size - 1; let status = 200;
  const range = req.get('range');
  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (m[1] === '' && m[2] === '')) throw new HttpError(416, 'malformed range');
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
    if (start > end || start >= size) { res.set('Content-Range', `bytes */${size}`); throw new HttpError(416, 'range not satisfiable'); }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  return status;
}
module.exports = { serveFile };
