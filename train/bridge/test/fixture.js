/**
 * TEST FIXTURE - a stand-in for the parts of the real M-NVR that the bridge reads: it writes the same files and
 * the same database rows the real stream-manager writes (cam_<id>_YYYYMMDD_HHMMSS.mp4 + a `recordings` row per
 * finished segment, `gps_track_log` fixes, `events`). The bridge cannot tell the difference.
 * The M-NVR schema is the real one (mnvr/database/schema.sql).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const ROOT = process.env.FIXTURE_DIR || '/tmp/ipvss/mnvr';
const SEG_S = Number(process.env.FIXTURE_SEG_S || 20);
const db = new Pool({ host: 'localhost', database: process.env.MNVR_DB_NAME || 'mnvr', user: process.env.MNVR_DB_ADMIN_USER || 'mnvr', password: process.env.MNVR_DB_ADMIN_PASSWORD || 'mnvrpass', max: 4 });
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
const slotStart = (ms) => Math.floor(ms / (SEG_S * 1000)) * SEG_S * 1000;

const templates = new Map();
function template(camId) {
  if (templates.has(camId)) return templates.get(camId);
  const f = path.join(ROOT, `template-cam${camId}.mp4`);
  fs.mkdirSync(ROOT, { recursive: true });
  if (!fs.existsSync(f)) execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=160x120:rate=10:duration=${SEG_S}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '10', '-an', '-movflags', '+faststart', f]);
  templates.set(camId, f);
  return f;
}

function position(at) { // same oscillating route as the CMS simulator (lon 80.1 -> 81.5, lat 26.0 -> 26.2)
  const f = ((at / 1000 / 1800) % 2); const k = f <= 1 ? f : 2 - f;
  return { lat: 26.0 + 0.2 * k, lon: 80.10 + 1.4 * k, speed_kmh: 100 };
}

async function setup({ cameras = ['cam-1', 'cam-2', 'cam-3'] } = {}) {
  await db.query(`DELETE FROM recordings; DELETE FROM events; DELETE FROM gps_track_log; DELETE FROM camera_health;`);
  await db.query(`DELETE FROM cameras`);
  const ids = [];
  for (const [i, name] of cameras.entries()) {
    const r = await db.query(`INSERT INTO cameras (camera_name, camera_type, ip_address, rtsp_url, location_description, rec_output_dir) VALUES ($1,'INTERIOR',$2,$3,$4,$5) RETURNING camera_id`,
      [name, `10.0.0.${10 + i}`, `rtsp://10.0.0.${10 + i}/main`, `Coach C${i + 1}`, path.join(ROOT, 'recordings', `cam_${i + 1}`)]);
    ids.push(r.rows[0].camera_id);
  }
  await db.query(`UPDATE recording_settings SET segment_duration_sec = $1`, [SEG_S]);
  await db.query(`UPDATE system_config SET config_value = '12301 Rajdhani' WHERE config_key = 'train_number'`);
  return ids;
}

async function addSegment(camId, startMs) {
  const dir = path.join(ROOT, 'recordings', `cam_${camId}`); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cam_${camId}_${stamp(startMs)}.mp4`);
  if (!fs.existsSync(file)) fs.copyFileSync(template(camId), file);
  const st = fs.statSync(file); const p = position(startMs);
  await db.query(
    `INSERT INTO recordings (camera_id, file_path, file_name, file_size_bytes, duration_seconds, start_timestamp, end_timestamp, video_codec, resolution_width, resolution_height,
                             recording_mode, status, gps_latitude, gps_longitude, gps_speed_kmh, gps_fix_quality)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'H.264',160,120,'CONTINUOUS','COMPLETED',$8,$9,$10,'3D')
     ON CONFLICT (file_path) DO NOTHING`,
    [camId, file, path.basename(file), st.size, SEG_S, new Date(startMs), new Date(startMs + SEG_S * 1000), p.lat, p.lon, p.speed_kmh]);
  return file;
}

async function history(camIds, minutes, endMs = Date.now()) {
  const last = slotStart(endMs) - SEG_S * 1000;
  for (let s = last - minutes * 60000; s <= last; s += SEG_S * 1000) for (const c of camIds) await addSegment(c, s);
}

async function addGps(atMs, fix = '3D') {
  const p = position(atMs);
  await db.query(`INSERT INTO gps_track_log (timestamp, latitude, longitude, speed_kmh, satellites, fix_quality) VALUES ($1,$2,$3,$4,9,$5)`, [new Date(atMs), p.lat, p.lon, p.speed_kmh, fix]);
}
async function gpsHistory(minutes, stepS = 2) { for (let t = Date.now() - minutes * 60000; t <= Date.now(); t += stepS * 1000) await addGps(t); }

async function addEvent({ type, severity = 'WARNING', title, cameraId = null, subtype = null, data = null, lat = null, lon = null, at = Date.now() }) {
  const r = await db.query(
    `INSERT INTO events (event_type, event_subtype, severity, title, camera_id, event_data, gps_latitude, gps_longitude, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING event_id`,
    [type, subtype, severity, title || type, cameraId, data ? JSON.stringify(data) : null, lat, lon, new Date(at)]);
  return r.rows[0].event_id;
}

/** Keeps "recording": every SEG_S seconds the segment that just ended becomes a row (like the stream-manager indexer), plus a GPS fix every 2 s. */
function startLive(camIds) {
  let stop = false; let lastSlot = slotStart(Date.now());
  const gps = setInterval(() => addGps(Date.now()).catch(() => {}), 2000);
  const rec = setInterval(async () => {
    if (stop) return;
    const cur = slotStart(Date.now());
    while (lastSlot < cur) { for (const c of camIds) await addSegment(c, lastSlot).catch(() => {}); lastSlot += SEG_S * 1000; }
  }, 1000);
  return () => { stop = true; clearInterval(gps); clearInterval(rec); };
}

module.exports = { db, ROOT, SEG_S, setup, addSegment, history, addGps, gpsHistory, addEvent, startLive, slotStart, position };
