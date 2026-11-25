/**
 * Resolves delivered_footage.storage_path to a real file under MEDIA_ROOT.
 * Footage is one stitched file per request (RDSO Cl. 3.12). Paths that
 * escape MEDIA_ROOT (.., absolute paths elsewhere, symlinks) are refused.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const config = require('../config');

async function resolveUnder(rootDir, cleaned) {
  let root;
  try { root = await fs.promises.realpath(rootDir); } catch (_) { return null; } // this root does not exist
  const candidate = path.resolve(root, cleaned);
  let real;
  try { real = await fs.promises.realpath(candidate); } catch (_) { return null; } // file not under this root
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const stat = await fs.promises.stat(real);
  if (!stat.isFile()) return null;
  return { file: real, size: stat.size, name: path.basename(real) };
}

const learned = new Set(); // footage folders discovered by the search below

const sha256File = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
});

/**
 * The footage folder the RUNNING CMS really writes into (it reports it on /health). This is the authority: whatever
 * MEDIA_ROOT says in a .env file, delivered footage is where the CMS process put it - so RPF always looks there too.
 */
let cmsRootCache = { at: 0, dir: null };
function cmsMediaRoot() {
  return new Promise((resolve) => {
    if (Date.now() - cmsRootCache.at < 30000) return resolve(cmsRootCache.dir);
    const done = (dir) => { cmsRootCache = { at: Date.now(), dir }; resolve(dir); };
    if (!process.env.CMS_HOST || !process.env.CMS_PORT) return done(null);   // set by start.sh from config/control-room.conf
    const req = http.get({ host: process.env.CMS_HOST, port: Number(process.env.CMS_PORT), path: '/health', timeout: 1500 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => { try { done(JSON.parse(b).media_root || null); } catch (_) { done(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(null));
  });
}

/** Last resort: look for the same relative path in folders near this project (a CMS started from another copy / cwd).
 *  The file must match the SHA-256 recorded at delivery, so a same-named file of another installation is never served. */
async function searchNearby(cleaned, expectedSha) {
  const rpfCms = path.resolve(__dirname, '..', '..', '..');
  const bases = [rpfCms, path.dirname(rpfCms), path.dirname(path.dirname(rpfCms)), path.dirname(path.dirname(path.dirname(rpfCms)))];
  const skip = new Set(['node_modules', '.git', 'logs', 'run', 'frontend', 'dist', '.venv', '.cache', 'proc', 'sys']);
  const seen = new Set(); let visited = 0;
  for (const base of bases) {
    const queue = [[base, 0]];
    while (queue.length && visited < 8000) {
      const [dir, depth] = queue.shift();
      if (seen.has(dir)) continue; seen.add(dir); visited++;
      const hit = await resolveUnder(dir, cleaned);
      if (hit && (!expectedSha || (await sha256File(hit.file).catch(() => null)) === expectedSha)) { learned.add(dir); return hit; }
      if (depth >= 6) continue;
      let ents = [];
      try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of ents) if (e.isDirectory() && !e.isSymbolicLink() && !skip.has(e.name)) queue.push([path.join(dir, e.name), depth + 1]);
    }
  }
  return null;
}

async function rootsChecked() {
  const cms = await cmsMediaRoot();
  return [...new Set([config.mediaRoot, ...(cms ? [path.resolve(cms)] : []), ...config.mediaRootsExtra, ...learned])];
}

/**
 * Footage that lives on ANOTHER CMS of the cluster: ask this post's own CMS for it (a signed request - the CMS forwards it to the CMS that
 * holds the file), keep a checksum-verified copy in a cache folder and use that like any local file. Needs CMS_CLUSTER_SECRET in .env.
 */
const inflight = new Map();
async function fetchRemote(cleaned, expectedSha) {
  const secret = String(process.env.CMS_CLUSTER_SECRET || '').trim();
  if (secret.length < 16 || !process.env.CMS_HOST || !process.env.CMS_PORT) return null;
  const dir = path.resolve(__dirname, '..', '..', 'data', 'remote-cache');
  const key = crypto.createHash('sha1').update(cleaned).digest('hex');
  const dest = path.join(dir, `${key}${path.extname(cleaned)}`);
  const finish = async () => { const st = await fs.promises.stat(dest); return { file: dest, size: st.size, name: path.basename(cleaned) }; };
  try { if (fs.existsSync(dest) && (!expectedSha || (await sha256File(dest)) === expectedSha)) { const now = new Date(); fs.utimesSync(dest, now, now); return finish(); } } catch (_) { /* fetch again */ }
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) { try { const fp = path.join(dir, f); if (Date.now() - fs.statSync(fp).mtimeMs > 12 * 3600 * 1000) fs.rmSync(fp, { force: true }); } catch (_) { /* ignore */ } }
    const p = '/cluster/internal/media-by-path'; const node = 'rpf-post'; const ts = Date.now();
    const sig = crypto.createHmac('sha256', secret).update(`${node}.${ts}.GET.${p}`).digest('hex');
    let r;
    try { r = await fetch(`http://${process.env.CMS_HOST}:${process.env.CMS_PORT}${p}?p=${encodeURIComponent(cleaned)}`, { headers: { 'X-Cluster-Node': node, 'X-Cluster-Ts': String(ts), 'X-Cluster-Sig': sig }, signal: AbortSignal.timeout(600000) }); } catch (e) { console.warn(`[storage] remote fetch of '${cleaned}' failed: ${e.message}`); return null; }
    if (!r.ok) { console.warn(`[storage] the CMS cannot supply '${cleaned}' (HTTP ${r.status})`); return null; }
    const tmp = `${dest}.part-${process.pid}`; const h = crypto.createHash('sha256');
    await new Promise((resolve, reject) => { const out = fs.createWriteStream(tmp); require('stream').Readable.fromWeb(r.body).on('data', (d) => h.update(d)).on('error', reject).pipe(out).on('finish', resolve).on('error', reject); });
    if (expectedSha && h.digest('hex') !== expectedSha) { fs.rmSync(tmp, { force: true }); console.warn(`[storage] '${cleaned}' from the other CMS did not match its checksum - discarded`); return null; }
    fs.renameSync(tmp, dest);
    return finish();
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** MEDIA_ROOT, the folder the live CMS reports, the other known footage folders, then a bounded search nearby. */
async function resolveFootageFile(storagePath, expectedSha) {
  const cleaned = String(storagePath || '').replace(/^file:\/\//, '');
  if (!cleaned) return null;
  const roots = await rootsChecked();
  for (const dir of roots) {
    const hit = await resolveUnder(dir, cleaned);
    if (hit) return hit;
  }
  const hit = (await searchNearby(cleaned, expectedSha)) || (await fetchRemote(cleaned, expectedSha));
  if (!hit) console.warn(`[storage] footage '${cleaned}' not found. Looked in: ${roots.join(', ')} and near ${path.resolve(__dirname, '..', '..', '..')}. Run: bash start.sh diagnose-footage`);
  return hit;
}

/** Why each footage folder failed - shown in the error so the cause is visible without digging through logs. */
async function diagnose(storagePath) {
  const cleaned = String(storagePath || '').replace(/^file:\/\//, '');
  const out = [];
  const cms = await cmsMediaRoot();
  out.push(cms ? `the running CMS stores footage in ${cms}` : 'the CMS did not report its footage folder (is it running on CMS_PORT?)');
  for (const dir of await rootsChecked()) {
    try { await fs.promises.access(dir, fs.constants.R_OK | fs.constants.X_OK); }
    catch (e) { out.push(`${dir}: ${e.code === 'ENOENT' ? 'folder does not exist' : e.code === 'EACCES' ? 'no permission to read this folder' : e.code}`); continue; }
    try { const st = await fs.promises.stat(path.resolve(dir, cleaned)); out.push(`${dir}: ${st.isFile() ? 'found but not readable' : 'not a file'}`); }
    catch (e) { out.push(`${dir}: ${e.code === 'ENOENT' ? 'no such file' : e.code === 'EACCES' ? 'permission denied' : e.code}`); }
  }
  return `looking for '${cleaned}' - ${out.join(' | ')}`;
}

const MIME = {
  mp4: 'video/mp4',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
};

const mimeFor = (format) => MIME[String(format || '').toLowerCase()] || 'application/octet-stream';
// Browsers reliably play MP4 only; AVI/MKV are download-only in the UI.
const playableInBrowser = (format) => String(format || '').toLowerCase() === 'mp4';

module.exports = { diagnose, resolveFootageFile, mimeFor, playableInBrowser };
