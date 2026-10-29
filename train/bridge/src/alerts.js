/**
 * M-NVR events -> CMS alerts (POST /nvr/v1/alerts).
 * The M-NVR's `events` table is the outbox: a cursor (last event_id sent) is kept in the state file, so events
 * raised while the train is in a tunnel are sent, in order, as soon as CMS is reachable. CMS makes retries
 * idempotent (same nvr_event_id + event_time = same alert), so a crash between "sent" and "cursor saved" is harmless.
 */
const cms = require('./cmsClient');
const mnvr = require('./mnvrDb');
const state = require('./state');
const cameras = require('./cameraMap');
const mapping = require('./mapping');
const uploader = require('./uploader');
const transfers = require('./transfers');
const config = require('./config');
const log = require('./log')('alerts');
const { sleep, wakeableSleep, iso } = require('./util');

const stats = { sent: 0, duplicates: 0, skipped: 0, filtered: 0, last_sent_at: null, last_error: null };
let paused = true; // until the first successful heartbeat
let waker = null;

async function initCursor() {
  const s = state.get();
  if (s.alert_cursor != null) return;
  // very first start: do not flood CMS with the history of the unit, begin at "now" (optionally N minutes back)
  const c = config.alertBackfillMin > 0 ? await mnvr.eventIdAt(Date.now() - config.alertBackfillMin * 60000) : await mnvr.maxEventId();
  state.set({ alert_cursor: c });
  log.info(`first start: alerts will be sent for events after #${c}${config.alertBackfillMin ? ` (backfill ${config.alertBackfillMin} min)` : ''}`);
}

/** Where was the train when it happened? Event's own GPS, else the closest fix; waits briefly for a late fix. */
async function locate(ev) {
  if (ev.gps_latitude != null && ev.gps_longitude != null && !(Number(ev.gps_latitude) === 0 && Number(ev.gps_longitude) === 0)) {
    return { lat: Number(ev.gps_latitude), lon: Number(ev.gps_longitude), fix_age_s: 0, fix_quality: 'event' };
  }
  const at = new Date(ev.occurred_at).getTime();
  for (;;) {
    const fix = await mnvr.gpsNear(at, config.alertGpsMaxAgeS);
    if (fix) return { lat: fix.latitude, lon: fix.longitude, fix_age_s: Math.round(Number(fix.dist_s)), fix_quality: ({ '3D': 'gps', '2D': 'gps', DGPS: 'dgps' }[fix.fix_quality] || 'gps') };
    if (Date.now() - at > config.alertGpsWaitS * 1000) break;
    await sleep(2000);
  }
  if (config.fallbackLat != null && config.fallbackLon != null) return { lat: config.fallbackLat, lon: config.fallbackLon, fix_age_s: null, fix_quality: 'fallback' };
  return null;
}

async function sendOne(ev) {
  const cls = mapping.classify(ev);
  if (!cls.forward) { stats.filtered++; return 'filtered'; }
  const pos = await locate(ev);
  if (!pos) throw Object.assign(new Error(`no GPS position for event #${ev.event_id} (set FALLBACK_LAT/LON to send alerts without a fix)`), { permanent: true });
  const when = Math.min(new Date(ev.occurred_at).getTime(), Date.now());
  const camCms = cameras.toCms(ev.camera_id);
  const body = {
    nvr_event_id: `mnvr-${ev.event_id}`, alert_type: cls.alert_type, priority: cls.priority, event_time: iso(when),
    lat: pos.lat, lon: pos.lon, fix_age_s: pos.fix_age_s, fix_quality: pos.fix_quality, ...(camCms != null ? { camera_id: camCms } : {}),
  };
  const r = await cms.call('POST', '/alerts', { json: body });
  if (r.duplicate) stats.duplicates++; else stats.sent++;
  stats.last_sent_at = new Date().toISOString();
  log.info(`event #${ev.event_id} ${ev.event_type} -> ${cls.alert_type} P${cls.priority}${camCms == null && ev.camera_id != null ? ' (camera not mapped)' : ''} => ${r.duplicate ? 'already at CMS' : r.dispatched ? `dispatched${r.incidentId ? `, incident #${r.incidentId}` : ''}` : 'queued for CMS operator'}`);
  if (config.autoUploadOnAlert && cls.priority >= config.autoMinPriority && camCms != null && !r.duplicate) scheduleAutoUpload(camCms, when, ev.event_id);
  return 'sent';
}

/** Optional: push footage around a serious alert before anyone asks, so it is already at CMS when the officer requests it. */
function scheduleAutoUpload(camCms, when, eventId) {
  const from = when - config.autoPreS * 1000; const to = when + config.autoPostS * 1000;
  const wait = Math.max(0, to - Date.now()) + 2000;
  log.info(`event #${eventId}: pre-uploading footage ${config.autoPreS}s before / ${config.autoPostS}s after to CMS`);
  setTimeout(async () => {
    for (let i = 0; i < 6; i++) {
      const tr = transfers.begin(`auto-${eventId}`, { kind: 'auto', event_id: eventId, cms_camera_id: camCms, camera_name: cameras.nameOfCms(camCms), window_start: new Date(from).toISOString(), window_end: new Date(to).toISOString() });
      try { const r = await uploader.uploadWindow(camCms, from, to, `auto-upload (event #${eventId})`, tr); tr.set({ status: r.missing.length ? 'partial' : 'completed', missing: r.missing }); return; }
      catch (e) { if (e.permanent) { log.warn(`auto-upload for event #${eventId}: ${e.message}`); tr.set({ status: 'failed', error: e.message }); return; } tr.set({ status: 'interrupted', message: e.message }); await sleep(Math.min(60000, 5000 * 2 ** i)); }
    }
  }, wait).unref();
}

async function drain() {
  for (;;) {
    const cursor = Number(state.get().alert_cursor) || 0;
    const evs = await mnvr.eventsAfter(cursor, 50);
    if (!evs.length) return;
    for (const ev of evs) {
      try { await sendOne(ev); }
      catch (e) {
        if (e.permanent || (e instanceof cms.CmsError && !cms.isTransient(e) && e.status !== 401 && e.status !== 403)) {
          stats.skipped++; stats.last_error = e.message;
          log.error(`event #${ev.event_id} will NOT be sent: ${e.message}`);
          const sk = (state.get().skipped_alerts || []).slice(-49); sk.push({ event_id: ev.event_id, at: new Date().toISOString(), reason: String(e.message).slice(0, 200) });
          state.set({ skipped_alerts: sk });
        } else { stats.last_error = e.message; throw e; } // transient / auth: stop here, retry the same event later
      }
      state.set({ alert_cursor: ev.event_id });
    }
  }
}

async function loop() {
  await initCursor();
  let backoff = 1000;
  for (;;) {
    if (paused) { await sleep(500); continue; }
    try { await drain(); backoff = 1000; }
    catch (e) { log.warn(`will retry: ${e.message}`); await sleep(backoff); backoff = Math.min(30000, backoff * 2); continue; }
    waker = wakeableSleep(config.alertPollMs); await waker;
  }
}

module.exports = { loop, setOnline: (on) => { paused = !on; if (on && waker) waker.wake(); }, stats };
