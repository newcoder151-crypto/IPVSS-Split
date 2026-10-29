/**
 * Automatic RTSP stream discovery.
 *
 * Problem this solves: a camera could be saved with an empty rtsp_url (ONVIF
 * probe came back empty, wrong password at add time, camera offline, ...) and
 * nothing ever tried again -- "Fix Credentials" only re-tested the empty URL.
 *
 * What happens now, with no manual step:
 *   1. Create camera / edit camera / fix credentials -> if there is no stream
 *      address but there ARE credentials, the camera is asked for its stream
 *      URIs over ONVIF right then (discoverForCamera).
 *   2. A background sweep (every STREAM_AUTODISCOVERY_SECS, default 60) retries
 *      every ACTIVE camera that still has no rtsp_url but has credentials, with
 *      exponential back-off per camera (5 min -> 1 h) so a dead camera is not
 *      hammered. This also heals cameras that were already saved empty.
 *
 * Safety rules:
 *   - only ever FILLS an empty rtsp_url; never overwrites one an admin set;
 *   - third_rtsp_url is filled only in the same step (as the Add Camera dialog
 *     does) and never resurrected once the primary exists;
 *   - env: STREAM_AUTODISCOVERY_SECS=0 disables the sweep;
 *          AUTODISCOVER_THIRD_STREAM=false skips the third stream.
 * The stream pipeline (mediamtx-sync) picks up a new rtsp_url on its next cycle.
 */
function createAutoDiscovery(deps = {}) {
  const db = deps.db || require('../db');
  const onvif = deps.onvif || require('./onvifClient');
  const broadcast = deps.broadcast || ((m) => { try { require('../websocket').broadcast(m); } catch { /* ws not up yet */ } });
  const log = deps.log || console;
  const now = deps.now || Date.now;

  const SWEEP_SECS = Number(process.env.STREAM_AUTODISCOVERY_SECS ?? 60);
  const FILL_THIRD = process.env.AUTODISCOVER_THIRD_STREAM !== 'false';
  const BACKOFF_MIN_MS = 5 * 60 * 1000;
  const BACKOFF_MAX_MS = 60 * 60 * 1000;

  const state = new Map();   // camera_id -> { fails, nextTry }
  let running = false;

  const redact = (u) => String(u || '').replace(/\/\/[^@/]*@/, '//***@');

  async function discoverForCamera(cameraId) {
    const before = await db.queryOne('SELECT rtsp_url, third_rtsp_url FROM cameras WHERE camera_id=$1', [cameraId]);
    if (!before) return { ok: false, reason: 'not_found' };
    if (before.rtsp_url) return { ok: true, changed: false, rtsp_url: before.rtsp_url, third_rtsp_url: before.third_rtsp_url };

    // A cached ONVIF session may have been opened with the OLD (wrong) credentials.
    onvif.invalidate(cameraId);
    let profiles;
    try {
      profiles = await onvif.getProfiles(cameraId);
    } catch (e) {
      onvif.invalidate(cameraId);
      return { ok: false, reason: 'onvif_error', error: e.message };
    }
    if (!profiles.length) return { ok: false, reason: 'no_profiles' };

    const uris = [];
    for (const prof of profiles) {
      try { uris.push(await onvif.getStreamUri(cameraId, prof.token)); } catch { uris.push(null); }
    }
    const primary = uris.find(Boolean);
    if (!primary) return { ok: false, reason: 'no_stream_uri' };
    let third = null;
    if (FILL_THIRD) {
      for (let i = uris.length - 1; i >= 0; i--) {
        if (uris[i] && uris[i] !== primary) { third = uris[i]; break; }
      }
    }

    // The WHERE guard makes this race-safe: if an admin (or the sweep) filled
    // rtsp_url a moment ago, nothing is written.
    const { rows } = await db.query(
      `UPDATE cameras
          SET rtsp_url = $2,
              third_rtsp_url = CASE WHEN COALESCE(third_rtsp_url,'') = '' THEN $3::text ELSE third_rtsp_url END,
              updated_at = NOW()
        WHERE camera_id = $1 AND COALESCE(rtsp_url,'') = ''
        RETURNING camera_id, rtsp_url, third_rtsp_url`,
      [cameraId, primary, third]);
    if (!rows.length) return { ok: true, changed: false };
    log.log(`[autodiscovery] camera ${cameraId}: stream found -> ${redact(rows[0].rtsp_url)}`);
    return { ok: true, changed: true, rtsp_url: rows[0].rtsp_url, third_rtsp_url: rows[0].third_rtsp_url };
  }

  async function sweep() {
    if (running) return;
    running = true;
    try {
      const { rows } = await db.query(
        `SELECT c.camera_id, c.camera_name
           FROM cameras c
           LEFT JOIN cameras_config_details cd ON host(cd.ip_address) = c.ip_address
          WHERE c.status = 'ACTIVE'
            AND COALESCE(c.rtsp_url,'') = ''
            AND COALESCE(c.ip_address,'') <> ''
            AND (COALESCE(cd.onvif_password,'') <> '' OR COALESCE(c.password_hash,'') <> '')
          ORDER BY c.camera_id`);
      for (const cam of rows) {
        const st = state.get(cam.camera_id);
        if (st && now() < st.nextTry) continue;
        let res;
        try { res = await discoverForCamera(cam.camera_id); }
        catch (e) { res = { ok: false, reason: 'exception', error: e.message }; }
        if (res.ok && res.changed) {
          state.delete(cam.camera_id);
          broadcast({ type: 'camera.updated', data: { camera_id: cam.camera_id, rtsp_url_discovered: true } });
        } else if (res.ok) {
          state.delete(cam.camera_id);
        } else {
          const fails = (st ? st.fails : 0) + 1;
          const delay = Math.min(BACKOFF_MIN_MS * 2 ** (fails - 1), BACKOFF_MAX_MS);
          state.set(cam.camera_id, { fails, nextTry: now() + delay });
          log.warn(`[autodiscovery] camera ${cam.camera_id} (${cam.camera_name}): ${res.reason}${res.error ? ' - ' + res.error : ''}; retry in ${Math.round(delay / 60000)} min`);
        }
      }
    } catch (e) {
      log.warn('[autodiscovery] sweep failed:', e.message);
    } finally {
      running = false;
    }
  }

  function start() {
    if (!SWEEP_SECS) { log.log('[autodiscovery] sweep disabled (STREAM_AUTODISCOVERY_SECS=0)'); return; }
    setTimeout(sweep, 15000).unref?.();
    setInterval(sweep, SWEEP_SECS * 1000).unref?.();
    log.log(`[autodiscovery] looking for cameras without a stream address every ${SWEEP_SECS}s`);
  }

  return { discoverForCamera, sweep, start, _state: state };
}

module.exports = createAutoDiscovery();
module.exports.createAutoDiscovery = createAutoDiscovery;
