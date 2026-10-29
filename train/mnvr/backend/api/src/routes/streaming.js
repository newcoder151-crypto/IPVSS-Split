const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { query, queryOne } = require("../db");
const { authenticateMedia } = require("../middleware/auth");
const router = express.Router();

const RECORDINGS_PATH = path.resolve(process.env.RECORDINGS_PATH || "/storage/recordings");
const HLS_PATH = path.resolve(process.env.HLS_PATH || "/storage/hls");
// Scratch space for range exports (concat + trim output) — a sibling of
// RECORDINGS_PATH so it lives on the same volume/filesystem as the source
// segments (ffmpeg's concat demuxer and any -c copy trim never need a
// cross-filesystem copy this way, and the export is large enough on a busy
// camera that we don't want it landing on the container's own thin /tmp).
const EXPORT_PATH = path.resolve(process.env.EXPORT_PATH || path.join(path.dirname(RECORDINGS_PATH), "exports"));
try { fs.mkdirSync(EXPORT_PATH, { recursive: true }); } catch (err) { console.error("[export] could not create EXPORT_PATH:", err.message); }

// Resource-exhaustion guard (same reasoning as the /api/recordings page-size
// cap) — a single export request now drives an ffmpeg process tree, so an
// unbounded range could be used to make the server concat days of footage
// on demand. 6 hours comfortably covers a shift-length review while keeping
// worst-case segment counts and disk scratch usage bounded.
const MAX_EXPORT_RANGE_SECONDS = parseInt(process.env.MAX_EXPORT_RANGE_SECONDS || "21600", 10);
const MAX_EXPORT_SEGMENTS = 300;

// A bare filename component: no path separators, no "..", no leading dot.
// Anything else is rejected outright rather than "sanitized" (OWASP A01/A03:
// reject-by-default is far safer than trying to strip traversal sequences).
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+\.(ts|m3u8)$/;
const SAFE_ID_RE = /^\d+$/;

/**
 * Resolve `candidate` under `root` and verify the resolved, real path is
 * actually contained within `root`. This is the authoritative check —
 * regexes on the input are a first filter, but symlinks or unusual path
 * segments could still escape a naive path.join(), so we always confirm
 * containment against the resolved real path before touching the file.
 * OWASP A01 (Broken Access Control) / path traversal.
 */
function safeResolve(root, candidate) {
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function existsWithin(root, candidate) {
  const resolved = safeResolve(root, candidate);
  if (!resolved) return null;
  try {
    // Resolve symlinks too, and re-check containment on the real path.
    const real = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return fs.existsSync(real) ? real : null;
  } catch {
    return null;
  }
}

function resolveRecordingFile(rec) {
  const candidates = [];
  // An absolute file_path from the DB is only ever trusted if it was itself
  // written by the recorder process under RECORDINGS_PATH — we still route
  // it through safeResolve/existsWithin so a compromised or malformed DB
  // row can't be used to read arbitrary files.
  if (rec.file_path) {
    if (path.isAbsolute(rec.file_path)) {
      const rel = path.relative(RECORDINGS_PATH, rec.file_path);
      candidates.push(rel);
    } else {
      candidates.push(rec.file_path);
    }
  }
  if (rec.file_name && rec.camera_id && SAFE_ID_RE.test(String(rec.camera_id))) {
    candidates.push(path.join(`cam_${rec.camera_id}`, rec.file_name));
  }
  if (rec.file_name) candidates.push(rec.file_name);

  for (const c of candidates) {
    const found = existsWithin(RECORDINGS_PATH, c);
    if (found) return found;
  }
  return null;
}

// MP4 byte-range stream — uses authenticateMedia because a <video src="...">
// can't attach an Authorization header; it accepts either a normal header
// token (fetch/axios use) or a short-lived, media-scoped ?token= (video tag
// use). See middleware/auth.js for why that's safe.
router.get("/recordings/:id/stream", authenticateMedia, async (req, res) => {
  try {
    if (!SAFE_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid recording id" });
    const rec = await queryOne(
      `SELECT r.recording_id, r.file_path, r.file_name, r.camera_id, c.camera_name
       FROM recordings r LEFT JOIN cameras c ON r.camera_id=c.camera_id WHERE r.recording_id=$1`,
      [req.params.id],
    );
    if (!rec) return res.status(404).json({ error: "Recording not found" });

    const fp = resolveRecordingFile(rec);
    if (!fp) {
      return res.status(404).json({
        error: "Video file not on disk yet",
        note: "Recorder generates files every 60s — wait for the next segment",
      });
    }

    const stat = fs.statSync(fp);
    const size = stat.size;
    const range = req.headers.range;

    if (range) {
      const match = /^bytes=(\d+)-(\d+)?$/.exec(range);
      if (!match) return res.status(416).end();
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : Math.min(start + 10 * 1024 * 1024 - 1, size - 1);
      if (start >= size || end >= size || start > end) {
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.status(416).end();
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": "video/mp4",
        "Cache-Control": "no-cache",
      });
      fs.createReadStream(fp, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": size,
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      });
      fs.createReadStream(fp).pipe(res);
    }
  } catch (err) {
    console.error("[streaming:stream]", err);
    res.status(500).json({ error: "Failed to stream recording" });
  }
});

// Download — same reasoning as /stream above: this URL is often opened
// directly (window.open / <a href>) rather than via fetch().
router.get("/recordings/:id/download", authenticateMedia, async (req, res) => {
  try {
    if (!SAFE_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid recording id" });
    const rec = await queryOne(
      "SELECT recording_id, file_path, file_name, camera_id FROM recordings WHERE recording_id=$1",
      [req.params.id],
    );
    if (!rec) return res.status(404).json({ error: "Not found" });
    const fp = resolveRecordingFile(rec);
    if (!fp) return res.status(404).json({ error: "File not on disk" });
    // Force a safe download filename — never reflect the DB's file_name
    // verbatim into a Content-Disposition header without sanitizing it.
    const safeName = path.basename(fp);
    res.download(fp, safeName);
  } catch (err) {
    console.error("[streaming:download]", err);
    res.status(500).json({ error: "Failed to download recording" });
  }
});

// ── Time-range export ────────────────────────────────────────────────────
// Recordings are stored as fixed-length segment files (see
// stream_manager.py's -f segment stage), so "give me footage from X to Y"
// naturally spans several files on disk. This assembles the segments that
// overlap [start,end] into ONE playable MP4 — trimming the lead-in of the
// first segment and the tail of the last — instead of handing back a pile
// of per-segment files for the caller to stitch together themselves.
//
// Everything here is a stream copy (-c copy): we only ever seek/cut at
// existing keyframes and remux, never re-encode. That keeps a multi-hour
// export a matter of seconds and preserves the original (already
// watermarked) video losslessly — the trade-off is that the very start of
// the export can land up to one GOP early, since a keyframe-seek can't cut
// any closer than the nearest preceding keyframe. That matches how every
// commercial NVR's "export clip" feature behaves.

function runFfmpeg(args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(String(stderr || err.message).slice(-2000))); return; }
        resolve();
      });
  });
}

// Best-effort duration of a resolved segment file, in seconds. Prefers the
// DB's duration_seconds (already computed once by ffprobe when the segment
// was indexed — see stream_manager.py's _upsert_recording), only falling
// back to a fresh ffprobe for the rare row that doesn't have it yet (e.g.
// the segment currently being written).
function ffprobeDurationSeconds(filePath) {
  return new Promise((resolve) => {
    execFile("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", filePath,
    ], { timeout: 15000, killSignal: "SIGKILL" }, (err, stdout) => {
      const n = parseFloat(stdout);
      resolve(err || !Number.isFinite(n) ? null : n);
    });
  });
}

async function segmentDurationSeconds(row, filePath) {
  if (row.duration_seconds != null) return Number(row.duration_seconds);
  if (row.end_timestamp) return (new Date(row.end_timestamp) - new Date(row.start_timestamp)) / 1000;
  return ffprobeDurationSeconds(filePath);
}

// Escapes a path for the concat demuxer's "file '...'" list syntax — a
// literal single quote has to become '\'' (close the quote, an escaped
// quote, reopen the quote), same as escaping for a POSIX shell string.
function concatListLine(filePath) {
  return `file '${filePath.replace(/'/g, "'\\''")}'`;
}

router.get("/recordings/export", authenticateMedia, async (req, res) => {
  const tmpDir = path.join(EXPORT_PATH, `export-${crypto.randomUUID()}`);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  };

  try {
    const cameraId = req.query.camera_id;
    if (!SAFE_ID_RE.test(String(cameraId))) return res.status(400).json({ error: "camera_id is required" });

    const start = new Date(req.query.start);
    const end = new Date(req.query.end);
    if (isNaN(start) || isNaN(end)) return res.status(400).json({ error: "start and end must be valid timestamps" });
    if (start >= end) return res.status(400).json({ error: "start must be before end" });
    if ((end - start) / 1000 > MAX_EXPORT_RANGE_SECONDS) {
      return res.status(400).json({ error: `Range too long — max ${Math.floor(MAX_EXPORT_RANGE_SECONDS / 3600)}h per export` });
    }

    // Overlap test: a segment is relevant if it starts before the window
    // ends, and (it has no known end yet, i.e. still recording, or) it
    // ends after the window starts. Pass the raw query strings straight
    // through — NOT start.toISOString()/end.toISOString() — for the same
    // reason toApiDateTime() on the frontend avoids it: start_timestamp is
    // a timezone-naive local wall-clock column, and re-serializing the
    // parsed Date to UTC would compare against the wrong window (see
    // SearchPage.tsx's toApiDateTime comment for the original bug this
    // caused). The parsed `start`/`end` Date objects below are only used
    // for in-memory arithmetic against other Date objects parsed the same
    // way, which stays correct regardless of process timezone.
    const rows = (await query(
      `SELECT recording_id, file_path, file_name, camera_id, start_timestamp, end_timestamp, duration_seconds, status
       FROM recordings
       WHERE camera_id=$1 AND start_timestamp < $2 AND (end_timestamp IS NULL OR end_timestamp > $3)
       ORDER BY start_timestamp ASC
       LIMIT $4`,
      [parseInt(cameraId, 10), req.query.end, req.query.start, MAX_EXPORT_SEGMENTS + 1],
    )).rows;

    if (rows.length > MAX_EXPORT_SEGMENTS) {
      return res.status(400).json({ error: `Range spans too many recordings (>${MAX_EXPORT_SEGMENTS}) — narrow it down` });
    }

    const segments = rows
      .map((row) => ({ row, filePath: resolveRecordingFile(row) }))
      .filter((s) => s.filePath);

    if (!segments.length) {
      return res.status(404).json({ error: "No recording files found on disk for the requested range" });
    }

    fs.mkdirSync(tmpDir, { recursive: true });

    // Trim a single segment to whatever portion of it falls inside
    // [start,end] and returns the path to use in the concat list — the
    // trimmed copy if a cut was needed, or the original file untouched if
    // the whole segment is wanted (skips a pointless ffmpeg pass).
    async function trimSegment(seg, isFirst, isLast, index) {
      const segStart = new Date(seg.row.start_timestamp);
      const durationSec = await segmentDurationSeconds(seg.row, seg.filePath);

      const leadInSec = isFirst ? Math.max(0, (start - segStart) / 1000) : 0;
      let keepSec = durationSec != null ? durationSec - leadInSec : null;
      if (isLast) {
        const wantedSec = (end - segStart) / 1000 - leadInSec;
        keepSec = keepSec != null ? Math.min(keepSec, wantedSec) : wantedSec;
      }
      const needsTrim = leadInSec > 0.05 || (keepSec != null && durationSec != null && keepSec < durationSec - 0.05);
      if (!needsTrim) return seg.filePath;

      const out = path.join(tmpDir, `seg_${index}.mp4`);
      const args = ["-nostdin", "-loglevel", "warning", "-y"];
      if (leadInSec > 0.05) args.push("-ss", leadInSec.toFixed(3));
      args.push("-i", seg.filePath);
      if (keepSec != null && keepSec > 0) args.push("-t", Math.max(keepSec, 0.5).toFixed(3));
      args.push("-c", "copy", "-avoid_negative_ts", "make_zero", out);
      await runFfmpeg(args);
      return out;
    }

    const outputPaths = [];
    for (let i = 0; i < segments.length; i++) {
      outputPaths.push(await trimSegment(segments[i], i === 0, i === segments.length - 1, i));
    }

    let finalPath;
    if (outputPaths.length === 1) {
      finalPath = outputPaths[0];
    } else {
      const listFile = path.join(tmpDir, "concat.txt");
      fs.writeFileSync(listFile, outputPaths.map(concatListLine).join("\n") + "\n");
      finalPath = path.join(tmpDir, "merged.mp4");
      await runFfmpeg([
        "-nostdin", "-loglevel", "warning", "-y",
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-c", "copy", "-movflags", "+faststart", finalPath,
      ]);
    }

    // Built from the raw request strings (the user's own local wall-clock
    // input), not start/end.toISOString() — that would silently shift the
    // filename to UTC and no longer match what the user actually typed.
    const fmt = (s) => String(s).replace(/[^0-9]/g, "").slice(0, 14);
    const downloadName = `cam_${cameraId}_${fmt(req.query.start)}_to_${fmt(req.query.end)}.mp4`;
    res.download(finalPath, downloadName, (err) => {
      if (err) console.error("[streaming:export] send failed:", err.message);
      cleanup();
    });
  } catch (err) {
    console.error("[streaming:export]", err.message);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: "Failed to build export" });
  }
});

// HLS live playlist — hls.js/native HLS players load this directly by URL.
router.get("/hls/:cameraId/stream.m3u8", authenticateMedia, async (req, res) => {
  try {
    const cid = req.params.cameraId;
    if (!SAFE_ID_RE.test(cid)) return res.status(400).json({ error: "Invalid camera id" });

    const found =
      existsWithin(HLS_PATH, path.join(`cam_${cid}`, "stream.m3u8")) ||
      existsWithin(HLS_PATH, path.join(cid, "stream.m3u8"));

    if (!found) {
      return res.status(404).json({
        error: "HLS playlist not yet available",
        note: "Recorder is starting — first segment generates in up to 60s",
      });
    }
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.sendFile(found);
  } catch (err) {
    console.error("[streaming:hls-playlist]", err);
    res.status(500).json({ error: "Failed to load playlist" });
  }
});

// HLS .ts segments — same direct-URL constraint as the playlist above.
router.get("/hls/:cameraId/:segment", authenticateMedia, (req, res) => {
  try {
    const { cameraId, segment } = req.params;
    if (!SAFE_ID_RE.test(cameraId)) return res.status(400).end();
    // Strict allow-list: bare filename, no separators, no "..", correct
    // extension. This is the primary fix for the path-traversal issue that
    // previously only checked the *suffix* of the segment name.
    if (!SAFE_SEGMENT_RE.test(segment)) return res.status(400).end();

    const found =
      existsWithin(HLS_PATH, path.join(`cam_${cameraId}`, segment)) ||
      existsWithin(HLS_PATH, path.join(cameraId, segment));

    if (!found) return res.status(404).end();

    res.setHeader(
      "Content-Type",
      segment.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/MP2T",
    );
    res.setHeader("Cache-Control", "no-cache");
    return res.sendFile(found);
  } catch {
    res.status(404).end();
  }
});

module.exports = router;
