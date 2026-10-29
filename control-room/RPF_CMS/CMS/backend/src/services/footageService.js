const fs = require('fs');
const { execFile } = require('child_process');
const config = require('../config');
const { absPath, ensureDir } = require('./fsutil');

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 120000, ...opts }, (err, stdout, stderr) =>
    err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr })));

let ffmpegOk = null;
async function hasFfmpeg() {
  if (ffmpegOk != null) return ffmpegOk;
  try { await run(config.ffmpeg, ['-version']); ffmpegOk = true; } catch (_) { ffmpegOk = false; }
  return ffmpegOk;
}

/** Media duration in seconds, or null when ffprobe is unavailable / cannot read the file. */
async function probeDuration(file) {
  try {
    const { stdout } = await run(config.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    const d = parseFloat(stdout);
    return Number.isFinite(d) ? d : null;
  } catch (_) { return null; }
}

/**
 * One stitched file for a requested time range (RDSO Cl. 3.12). Segments are joined with the concat
 * demuxer and stream-copied: never re-encoded, so the recorded watermark/metadata stays intact.
 */
async function stitch(files, outFile) {
  ensureDir(outFile);
  const tmp = `${outFile}.tmp-${process.pid}`;
  try {
    if (files.length === 1) {
      fs.copyFileSync(files[0], tmp);
    } else {
      if (!(await hasFfmpeg())) throw new Error('ffmpeg is required to stitch more than one segment into a single file (install ffmpeg or set FFMPEG_PATH)');
      const list = `${tmp}.txt`;
      fs.writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
      try {
        await run(config.ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp]);
      } finally { fs.rmSync(list, { force: true }); }
    }
    fs.renameSync(tmp, outFile);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Cut [startS, endS] out of a file without re-encoding (starts at the nearest earlier keyframe). */
async function cutClip(src, dst, startS, endS) {
  if (!(await hasFfmpeg())) throw new Error('ffmpeg is required to cut a section out of the footage');
  ensureDir(dst);
  const tmp = `${dst}.tmp-${process.pid}`;
  try {
    await run(config.ffmpeg, ['-y', '-v', 'error', '-ss', String(startS), '-i', src, '-t', String(Math.max(0.1, endS - startS)),
      '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-f', 'mp4', tmp]);
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error('ffmpeg produced an empty clip');
    fs.renameSync(tmp, dst);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

module.exports = { hasFfmpeg, probeDuration, stitch, cutClip, absPath };
