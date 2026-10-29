/**
 * Read-only access to the M-NVR's own PostgreSQL database (recordings, GPS, events, health).
 * The bridge never writes here and never calls the M-NVR API, so it needs no login and cannot disturb recording.
 * NOTE: the M-NVR stores timezone-naive local timestamps; run the bridge on the M-NVR host with the same TZ.
 */
const { Pool } = require('pg');
const config = require('./config');
const log = require('./log')('mnvr-db');

const pool = new Pool({ ...config.db, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
pool.on('error', (e) => log.warn(`pool error: ${e.message}`));
const q = (text, params) => pool.query(text, params).then((r) => r.rows);

const ms = (d) => (d ? new Date(d).getTime() : null);

module.exports = {
  pool,
  close: () => pool.end(),

  cameras: () => q(`SELECT camera_id, camera_name, location_description, status FROM cameras ORDER BY camera_id`),

  async segmentLengthS() {
    try { const r = await q(`SELECT segment_duration_sec FROM recording_settings ORDER BY id LIMIT 1`); return Number(r[0] && r[0].segment_duration_sec) || 120; }
    catch (_) { return 120; }
  },
  async deviceInfo() {
    try {
      const r = await q(`SELECT config_key, config_value FROM system_config WHERE config_key IN ('firmware_version','train_number','device_name')`);
      return Object.fromEntries(r.map((x) => [x.config_key, x.config_value]));
    } catch (_) { return {}; }
  },

  /** Finished segments of a camera that overlap [from, to] (ms). The file being written has no row yet. */
  async segmentsFor(cameraId, from, to) {
    const rows = await q(
      `SELECT recording_id, camera_id, file_path, file_name, start_timestamp, end_timestamp, duration_seconds,
              gps_latitude, gps_longitude
         FROM recordings
        WHERE camera_id = $1 AND status IN ('COMPLETED','EXPORTED','ARCHIVED')
          AND start_timestamp < $3 AND COALESCE(end_timestamp, start_timestamp + make_interval(secs => COALESCE(duration_seconds,0))) > $2
        ORDER BY start_timestamp`, [cameraId, new Date(from), new Date(to)]);
    return rows.map((r) => {
      const start = ms(r.start_timestamp);
      const end = r.end_timestamp ? ms(r.end_timestamp) : start + (Number(r.duration_seconds) || 0) * 1000;
      return { ...r, start, end };
    }).filter((r) => r.end > r.start);
  },
  async latestSegmentEnd(cameraId) {
    const r = await q(`SELECT max(end_timestamp) AS e FROM recordings WHERE camera_id = $1 AND status IN ('COMPLETED','EXPORTED','ARCHIVED')`, [cameraId]);
    return r[0] && r[0].e ? ms(r[0].e) : null;
  },

  // ---- GPS ----
  async latestGps() { const r = await q(`SELECT track_id, timestamp, latitude, longitude, speed_kmh, heading, fix_quality FROM gps_track_log ORDER BY track_id DESC LIMIT 1`); return r[0] || null; },
  /** Rows after a cursor (track_id), oldest first. */
  gpsAfter: (cursor, limit) => q(`SELECT track_id, timestamp, latitude, longitude, speed_kmh, fix_quality FROM gps_track_log WHERE track_id > $1 ORDER BY track_id LIMIT $2`, [cursor, limit]),
  /** Closest valid fix to a moment, within maxAgeS; null when there is none. */
  async gpsNear(at, maxAgeS) {
    const r = await q(
      `SELECT track_id, timestamp, latitude, longitude, speed_kmh, fix_quality,
              abs(extract(epoch FROM (timestamp - $1::timestamp))) AS dist_s
         FROM gps_track_log
        WHERE timestamp BETWEEN $1::timestamp - make_interval(secs => $2) AND $1::timestamp + make_interval(secs => $2)
          AND COALESCE(fix_quality,'NO_FIX') <> 'NO_FIX'
        ORDER BY dist_s LIMIT 1`, [new Date(at), maxAgeS]);
    return r[0] || null;
  },
  async anyFixEver() { const r = await q(`SELECT 1 FROM gps_track_log WHERE COALESCE(fix_quality,'NO_FIX') <> 'NO_FIX' LIMIT 1`); return r.length > 0; },

  // ---- events ----
  async maxEventId() { const r = await q(`SELECT COALESCE(max(event_id),0) AS m FROM events`); return Number(r[0].m); },
  async eventIdAt(ts) { const r = await q(`SELECT COALESCE(min(event_id) - 1, (SELECT COALESCE(max(event_id),0) FROM events)) AS m FROM events WHERE occurred_at >= $1`, [new Date(ts)]); return Number(r[0].m); },
  eventsAfter: (id, limit) => q(
    `SELECT event_id, event_type, event_subtype, severity, title, description, event_data, camera_id,
            gps_latitude, gps_longitude, occurred_at, created_at
       FROM events WHERE event_id > $1 ORDER BY event_id LIMIT $2`, [id, limit]),

  // ---- health ----
  async cameraHealth() {
    try {
      return await q(`SELECT DISTINCT ON (camera_id) camera_id, is_online, is_recording FROM camera_health
                       WHERE timestamp > localtimestamp - interval '90 seconds' ORDER BY camera_id, timestamp DESC`);
    } catch (_) { return []; }
  },
  async systemHealth() {
    try { const r = await q(`SELECT cpu_usage_percent, cpu_temperature_celsius, memory_usage_percent, overall_health_score FROM system_health ORDER BY timestamp DESC LIMIT 1`); return r[0] || null; }
    catch (_) { return null; }
  },
};
