/**
 * Read-only access to the M-NVR's own PostgreSQL database (recordings, GPS, events, health).
 * The bridge never writes here and never calls the M-NVR API, so it needs no login and cannot disturb recording.
 * NOTE: the M-NVR stores timezone-naive wall-clock timestamps (in the time zone of its recorder). The bridge works that zone out by itself
 * (calibrate(): row end time vs the file's modification time) so it no longer matters which TZ the bridge process runs in.
 */
const { Pool } = require("pg");
const config = require("./config");
const log = require("./log")("mnvr-db");

const pool = new Pool({
  ...config.db,
  max: 4,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pool.on("error", (e) => log.warn(`pool error: ${e.message}`));
const q = (text, params) => pool.query(text, params).then((r) => r.rows);

const ms = (d) => (d ? new Date(d).getTime() : null);
const fs = require("fs");
const { spawnSync } = require("child_process");
/** Measured length of a recording file: { ok, dur }. ok=false = ffprobe could not read it (cut off / corrupt); dur=null = ffprobe is not installed. */
function probe(file) {
  try {
    const r = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        file,
      ],
      { timeout: 8000 },
    );
    if (r.error) return { ok: true, dur: null };
    const d = parseFloat(String(r.stdout));
    return r.status === 0 && Number.isFinite(d) && d > 0
      ? { ok: true, dur: d }
      : { ok: false, dur: null };
  } catch (_) {
    return { ok: true, dur: null };
  }
}

// ---- the recorder's clock -------------------------------------------------------------------------------------------------------------
// pg turns a timezone-naive timestamp into an instant using THIS process's time zone; the M-NVR's recorder wrote it in ITS zone. delta = the
// difference (ms). true instant = parsed - delta; to look up instant T, ask for T + delta. 0 when both agree (the usual case).
// Measured, not guessed: for each recent row, (end time as parsed) - (modification time of its file, a true instant) = delta, rounded to 15 min.
let delta = 0;
let calibratedAt = 0;
async function calibrate(force) {
  if (!force && Date.now() - calibratedAt < 10 * 60000) return delta;
  calibratedAt = Date.now();
  let rows = [];
  try {
    rows = await q(
      `SELECT file_path, end_timestamp FROM recordings WHERE status IN ('COMPLETED','EXPORTED','ARCHIVED') AND end_timestamp IS NOT NULL ORDER BY recording_id DESC LIMIT 30`,
    );
  } catch (_) {
    return delta;
  }
  const d = [];
  for (const r of rows) {
    try {
      d.push(
        new Date(r.end_timestamp).getTime() - fs.statSync(r.file_path).mtimeMs,
      );
    } catch (_) {
      /* file gone */
    }
  }
  if (d.length < 3) return delta; // not enough evidence: keep what we had
  d.sort((a, b) => a - b);
  const med = d[Math.floor(d.length / 2)];
  const q15 = Math.round(med / 900000) * 900000;
  if (Math.abs(med - q15) > 5 * 60000) return delta; // the samples do not agree on a whole zone offset: do not trust them
  if (q15 !== delta)
    log.warn(
      q15 === 0
        ? "the M-NVR clock and this PC agree again"
        : `the M-NVR writes its times ${q15 > 0 ? "ahead of" : "behind"} this PC's time zone by ${Math.abs(q15 / 3600000)} h - correcting for it`,
    );
  delta = q15;
  return delta;
}

module.exports = {
  pool,
  close: () => pool.end(),

  cameras: () =>
    q(
      `SELECT camera_id, camera_name, location_description, status FROM cameras ORDER BY camera_id`,
    ),

  async segmentLengthS() {
    try {
      const r = await q(
        `SELECT segment_duration_sec FROM recording_settings ORDER BY id LIMIT 1`,
      );
      return Number(r[0] && r[0].segment_duration_sec) || 120;
    } catch (_) {
      return 120;
    }
  },
  async deviceInfo() {
    try {
      const r = await q(
        `SELECT config_key, config_value FROM system_config WHERE config_key IN ('firmware_version','train_number','device_name','mnvr_number')`,
      );
      return Object.fromEntries(r.map((x) => [x.config_key, x.config_value]));
    } catch (_) {
      return {};
    }
  },

  /** Finished segments of a camera that overlap [from, to] (ms). The file being written has no row yet. */
  async segmentsFor(cameraId, from, to) {
    const rows = await q(
      `SELECT recording_id, camera_id, file_path, file_name, start_timestamp, end_timestamp, duration_seconds,
              gps_latitude, gps_longitude
         FROM recordings
        WHERE camera_id = $1 AND status IN ('COMPLETED','EXPORTED','ARCHIVED')
          AND start_timestamp < $3 AND COALESCE(end_timestamp, start_timestamp + make_interval(secs => COALESCE(duration_seconds,0))) > $2
        ORDER BY start_timestamp`,
      [cameraId, new Date(from + delta), new Date(to + delta)],
    );
    return rows
      .map((r) => {
        const start = ms(r.start_timestamp) - delta;
        const end = r.end_timestamp
          ? ms(r.end_timestamp) - delta
          : start + (Number(r.duration_seconds) || 0) * 1000;
        return { ...r, start, end };
      })
      .filter((r) => r.end > r.start);
  },
  async latestSegmentEnd(cameraId) {
    const r = await q(
      `SELECT max(end_timestamp) AS e FROM recordings WHERE camera_id = $1 AND status IN ('COMPLETED','EXPORTED','ARCHIVED')`,
      [cameraId],
    );
    return r[0] && r[0].e ? ms(r[0].e) - delta : null;
  },
  calibrate,
  clockDelta: () => delta,
  /** The recorder's UTC offset (ms): wall-clock = instant + this. Times shown to people are in the M-NVR's own clock, as on its screens. */
  recorderOffsetMs: () => -new Date().getTimezoneOffset() * 60000 + delta,
  /**
   * Recording files that are in the camera's folder but NOT in the M-NVR's database (its indexer is behind, stopped, or was restarted):
   * found by their names (cam_<id>_YYYYMMDD_HHMMSS.mp4 - the recorder's wall-clock start) and the file's modification time (when it was closed).
   * The file still being written is left out while the recorder is alive; after a crash the last file is only used if it can be read.
   */
  async diskSegments(cameraId, from, to) {
    const path = require("path");
    let dir = null;
    const own = (
      await q(
        `SELECT file_path FROM recordings WHERE camera_id = $1 ORDER BY recording_id DESC LIMIT 1`,
        [cameraId],
      )
    )[0];
    if (own) dir = path.dirname(own.file_path);
    else {
      const any = (
        await q(
          `SELECT file_path FROM recordings ORDER BY recording_id DESC LIMIT 1`,
        )
      )[0];
      if (any && /^cam_\d+$/.test(path.basename(path.dirname(any.file_path))))
        dir = path.join(
          path.dirname(path.dirname(any.file_path)),
          `cam_${cameraId}`,
        );
    }
    const out = { dir, files: [], newest: null };
    if (!dir) return out;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      return out;
    }
    const wOff = -new Date().getTimezoneOffset() * 60000 + delta; // the recorder's UTC offset
    const re = new RegExp(
      `^cam_${cameraId}_(\\d{4})(\\d{2})(\\d{2})_(\\d{2})(\\d{2})(\\d{2})\\.mp4$`,
    );
    const all = [];
    for (const n of names) {
      const m = re.exec(n);
      if (!m) continue;
      const start =
        Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - wOff;
      let st;
      try {
        st = fs.statSync(path.join(dir, n));
      } catch (_) {
        continue;
      }
      if (!st.size) continue;
      all.push({
        file_path: path.join(dir, n),
        file_name: n,
        start,
        mtime: st.mtimeMs,
        recording_id: null,
        camera_id: cameraId,
      });
    }
    all.sort((a, b) => a.start - b.start);
    if (all.length) out.newest = all[all.length - 1];
    const last = all[all.length - 1];
    const segLenS = await this.segmentLengthS();
    const out2 = [];
    for (const f of all) {
      if (f.start >= to || f.start < from - (segLenS * 2 + 60) * 1000) continue; // cannot overlap the window
      if (f === last && Date.now() - f.mtime < 20000) continue; // the recorder is still writing it
      const pr = probe(f.file_path); // MEASURE the length: file times are not a reliable end
      if (!pr.ok) {
        log.warn(`${f.file_name}: not a readable video (cut off?) - skipped`);
        continue;
      }
      f.end =
        f.start +
        (pr.dur
          ? pr.dur * 1000
          : Math.max(1000, Math.min(f.mtime - f.start, (segLenS + 15) * 1000)));
      if (f.end > from) out2.push(f);
    }
    out.files = out2;
    return out;
  },
  /** What the M-NVR holds for a camera around a window - to say WHY a request found nothing. */
  async explain(cameraId, from, to) {
    const all = (
      await q(
        `SELECT count(*)::int AS n, min(start_timestamp) AS first, max(end_timestamp) AS last FROM recordings WHERE camera_id = $1`,
        [cameraId],
      )
    )[0];
    const win = await q(
      `SELECT status, count(*)::int AS n FROM recordings WHERE camera_id = $1 AND start_timestamp < $3 AND COALESCE(end_timestamp, start_timestamp) > $2 GROUP BY status`,
      [cameraId, new Date(from + delta), new Date(to + delta)],
    );
    // the recordings on either side of the window: that is the GAP the request fell into
    const prev = (
      await q(
        `SELECT max(end_timestamp) AS t FROM recordings WHERE camera_id = $1 AND status IN ('COMPLETED','EXPORTED','ARCHIVED') AND end_timestamp <= $2`,
        [cameraId, new Date(from + delta)],
      )
    )[0].t;
    const next = (
      await q(
        `SELECT min(start_timestamp) AS t FROM recordings WHERE camera_id = $1 AND status IN ('COMPLETED','EXPORTED','ARCHIVED') AND start_timestamp >= $2`,
        [cameraId, new Date(to + delta)],
      )
    )[0].t;
    return {
      total: all.n,
      first: all.first ? ms(all.first) - delta : null,
      last: all.last ? ms(all.last) - delta : null,
      inWindow: win,
      prev: prev ? ms(prev) - delta : null,
      next: next ? ms(next) - delta : null,
    };
  },

  // ---- GPS ----
  async latestGps() {
    const r = await q(
      `SELECT track_id, timestamp, latitude, longitude, speed_kmh, heading, fix_quality FROM gps_track_log ORDER BY track_id DESC LIMIT 1`,
    );
    return r[0] || null;
  },
  /** Rows after a cursor (track_id), oldest first. */
  gpsAfter: (cursor, limit) =>
    q(
      `SELECT track_id, timestamp, latitude, longitude, speed_kmh, fix_quality FROM gps_track_log WHERE track_id > $1 ORDER BY track_id LIMIT $2`,
      [cursor, limit],
    ),
  /** Closest valid fix to a moment, within maxAgeS; null when there is none. */
  async gpsNear(at, maxAgeS) {
    const r = await q(
      `SELECT track_id, timestamp, latitude, longitude, speed_kmh, fix_quality,
              abs(extract(epoch FROM (timestamp - $1::timestamp))) AS dist_s
         FROM gps_track_log
        WHERE timestamp BETWEEN $1::timestamp - make_interval(secs => $2) AND $1::timestamp + make_interval(secs => $2)
          AND COALESCE(fix_quality,'NO_FIX') <> 'NO_FIX'
        ORDER BY dist_s LIMIT 1`,
      [new Date(at + delta), maxAgeS],
    );
    return r[0] || null;
  },
  async anyFixEver() {
    const r = await q(
      `SELECT 1 FROM gps_track_log WHERE COALESCE(fix_quality,'NO_FIX') <> 'NO_FIX' LIMIT 1`,
    );
    return r.length > 0;
  },

  // ---- events ----
  async maxEventId() {
    const r = await q(`SELECT COALESCE(max(event_id),0) AS m FROM events`);
    return Number(r[0].m);
  },
  async eventIdAt(ts) {
    const r = await q(
      `SELECT COALESCE(min(event_id) - 1, (SELECT COALESCE(max(event_id),0) FROM events)) AS m FROM events WHERE occurred_at >= $1`,
      [new Date(ts)],
    );
    return Number(r[0].m);
  },
  eventsAfter: (id, limit) =>
    q(
      `SELECT event_id, event_type, event_subtype, severity, title, description, event_data, camera_id,
            gps_latitude, gps_longitude, occurred_at, created_at
       FROM events WHERE event_id > $1 ORDER BY event_id LIMIT $2`,
      [id, limit],
    ),

  // ---- health ----
  async cameraHealth() {
    try {
      return await q(`SELECT DISTINCT ON (camera_id) camera_id, is_online, is_recording FROM camera_health
                       WHERE timestamp > localtimestamp - interval '90 seconds' ORDER BY camera_id, timestamp DESC`);
    } catch (_) {
      return [];
    }
  },
  async systemHealth() {
    try {
      const r = await q(
        `SELECT cpu_usage_percent, cpu_temperature_celsius, memory_usage_percent, overall_health_score FROM system_health ORDER BY timestamp DESC LIMIT 1`,
      );
      return r[0] || null;
    } catch (_) {
      return null;
    }
  },
};
