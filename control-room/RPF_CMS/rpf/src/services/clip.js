/**
 * Cuts a section out of a delivered footage file for "download this section". Stream-copied (never
 * re-encoded), so the watermark and recorded metadata stay intact; the cut starts at the keyframe at or
 * before the requested start. Results are cached briefly in the OS temp folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const config = require('../config');

const DIR = path.join(os.tmpdir(), 'rpf-clips');
const MAX_AGE_MS = 60 * 60 * 1000;

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(Object.assign(err, { stderr: errOut })) : resolve(out))));

let available = null;
async function hasFfmpeg() {
  if (available != null) return available;
  try { await run(config.ffmpeg, ['-version']); available = true; } catch (_) { available = false; }
  return available;
}

function sweep() {
  try {
    for (const f of fs.readdirSync(DIR)) {
      const p = path.join(DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > MAX_AGE_MS) fs.rmSync(p, { force: true });
    }
  } catch (_) { /* nothing to sweep */ }
}

const inflight = new Map();
async function clipFile(src, footageId, startS, endS) {
  if (!(await hasFfmpeg())) { const e = new Error('cutting a section needs ffmpeg on the RPF server (install ffmpeg or set FFMPEG_PATH); download the whole file instead'); e.status = 501; throw e; }
  fs.mkdirSync(DIR, { recursive: true });
  const key = crypto.createHash('sha1').update(`${src}|${fs.statSync(src).mtimeMs}|${startS}|${endS}`).digest('hex').slice(0, 16);
  const dst = path.join(DIR, `f${footageId}-${key}.mp4`);
  if (!fs.existsSync(dst)) {
    if (!inflight.has(dst)) {
      const tmp = `${dst}.tmp${process.pid}`;
      inflight.set(dst, run(config.ffmpeg, ['-y', '-v', 'error', '-ss', String(startS), '-i', src, '-t', String(Math.max(0.1, endS - startS)),
        '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-f', 'mp4', tmp])
        .then(() => { if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error('empty clip'); fs.renameSync(tmp, dst); })
        .catch((e) => { fs.rmSync(tmp, { force: true }); throw e; })
        .finally(() => inflight.delete(dst)));
      sweep();
    }
    await inflight.get(dst);
  }
  const sha256 = await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(dst).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
  return { file: dst, size: fs.statSync(dst).size, sha256 };
}

module.exports = { clipFile, hasFfmpeg };
