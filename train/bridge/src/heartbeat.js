/**
 * Heartbeat: position, health and the GPS track since the last heartbeat CMS acknowledged.
 * The track is read from the M-NVR's gps_track_log by a cursor, so nothing needs buffering here: while the
 * train is in a tunnel the rows simply accumulate, and after the link returns they are sent in batches.
 */
const fs = require('fs');
const cms = require('./cmsClient');
const mnvr = require('./mnvrDb');
const state = require('./state');
const commands = require('./commands');
const cameras = require('./cameraMap');
const config = require('./config');
const log = require('./log')('heartbeat');

const startedAt = Date.now();
const status = { online: false, last_ok: null, last_error: null, clock_drift_s: null, track_backlog: false };

const fixName = (q) => ({ '3D': 'gps', '2D': 'gps', DGPS: 'dgps' }[q] || String(q || 'gps').toLowerCase());

async function collectTrack() {
  const cursor = Number(state.get().gps_cursor) || 0;
  const minMs = config.gpsTrackMinIntervalS * 1000;
  const rows = await mnvr.gpsAfter(cursor, 2000);
  const pts = []; let last = 0; let newCursor = cursor;
  for (const r of rows) {
    const t = new Date(r.timestamp).getTime();
    newCursor = r.track_id;
    if (!r.fix_quality || r.fix_quality === 'NO_FIX') continue;
    if (t - last < minMs) continue;
    last = t;
    pts.push({ ts: new Date(t).toISOString(), lat: r.latitude, lon: r.longitude, speed_mps: r.speed_kmh == null ? null : Math.round(r.speed_kmh / 3.6 * 10) / 10 });
    if (pts.length >= config.gpsBatch) break;
  }
  return { pts, newCursor, more: rows.length === 2000 || pts.length >= config.gpsBatch };
}

async function healthBlock(info) {
  const [ch, sh] = await Promise.all([mnvr.cameraHealth(), mnvr.systemHealth()]);
  const h = { uptime_h: Math.round((Date.now() - startedAt) / 360000) / 10, cameras_ok: ch.filter((c) => c.is_online).length, cameras_total: ch.length, cameras_recording: ch.filter((c) => c.is_recording).length };
  if (sh) Object.assign(h, { cpu_pct: sh.cpu_usage_percent, mem_pct: sh.memory_usage_percent, temp_c: sh.cpu_temperature_celsius, score: sh.overall_health_score });
  if (config.recordingsDir && fs.statfsSync) {
    try { const s = fs.statfsSync(config.recordingsDir); h.disk_used_pct = Math.round((1 - s.bavail / s.blocks) * 1000) / 10; } catch (_) { /* ignore */ }
  }
  return h;
}

async function beat() {
  const [latest, info] = await Promise.all([mnvr.latestGps(), mnvr.deviceInfo()]);
  const { pts, newCursor, more } = await collectTrack();
  const body = { firmware: info.firmware_version || 'mnvr', health: await healthBlock(info), gps: pts };
  if (latest && latest.fix_quality && latest.fix_quality !== 'NO_FIX' && Date.now() - new Date(latest.timestamp).getTime() < config.gpsStaleS * 1000) {
    Object.assign(body, { lat: latest.latitude, lon: latest.longitude, speed_mps: latest.speed_kmh == null ? undefined : latest.speed_kmh / 3.6, fix_quality: fixName(latest.fix_quality) });
  }
  const res = await cms.call('POST', '/heartbeat', { json: body });
  if (newCursor !== Number(state.get().gps_cursor)) state.set({ gps_cursor: newCursor }); // only after CMS accepted it
  status.online = true; status.last_ok = new Date().toISOString(); status.last_error = null; status.track_backlog = more;
  status.clock_drift_s = res.server_time ? Math.round((Date.now() - new Date(res.server_time).getTime()) / 100) / 10 : null;
  if (status.clock_drift_s != null && Math.abs(status.clock_drift_s) > 5) log.warn(`this unit's clock differs from CMS by ${status.clock_drift_s}s - event times will be off; fix NTP/PTP`);
  commands.enqueue(res.commands);
  return more;
}

/** Runs forever; returns nothing. onlineChange(bool) lets the command loop pause while there is no coverage. */
async function loop(onlineChange) {
  let wasOnline = null;
  for (;;) {
    let more = false;
    try { more = await beat(); }
    catch (e) {
      status.online = false; status.last_error = e.message;
      if (wasOnline !== false) log.warn(`no contact with CMS: ${e.message} (GPS keeps accumulating locally)`);
    }
    if (wasOnline !== status.online) {
      if (status.online && wasOnline === false) log.info('back in coverage - CMS reachable again');
      wasOnline = status.online; onlineChange && onlineChange(status.online);
    }
    await new Promise((r) => setTimeout(r, more && status.online ? 200 : config.heartbeatS * 1000));
  }
}

module.exports = { loop, status };
