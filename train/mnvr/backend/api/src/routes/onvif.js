/**
 * ONVIF Profile S control routes
 * -------------------------------------------------------------------------
 * /api/onvif/cameras/:id/capabilities    GET
 * /api/onvif/cameras/:id/profiles        GET    (list + cache in DB)
 * /api/onvif/cameras/:id/profiles/:token/stream-uri    GET
 * /api/onvif/cameras/:id/profiles/:token/activate       POST  (select active stream)
 *
 * /api/onvif/cameras/:id/ptz/status      GET
 * /api/onvif/cameras/:id/ptz/move        POST   { mode: continuous|relative|absolute, x, y, zoom, speed, timeout }
 * /api/onvif/cameras/:id/ptz/stop        POST
 * /api/onvif/cameras/:id/ptz/presets     GET / POST (create)
 * /api/onvif/cameras/:id/ptz/presets/:token/goto    POST
 * /api/onvif/cameras/:id/ptz/presets/:token         DELETE
 * /api/onvif/cameras/:id/ptz/home        POST   { action: goto|set }
 *
 * /api/onvif/cameras/:id/image           GET / PUT  (brightness/contrast/saturation/sharpness/...)
 * /api/onvif/cameras/:id/audio           GET / PUT
 */

const express = require('express');
const { query, queryOne } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { broadcast } = require('../websocket');
const onvif = require('../services/onvifClient');

const router = express.Router();

function handleOnvifError(res, err, cameraId) {
  const msg = err?.message || String(err);
  const isTimeout = /timeout|ECONNREFUSED|EHOSTUNREACH/i.test(msg);
  // Only tear down the cached connection for actual connection-health
  // problems (dead socket, camera unreachable, handshake failure). A SOAP
  // Fault such as "The requested settings are incorrect" means the
  // connection itself is fine - the camera just rejected a value. Previously
  // ANY error invalidated the cache here, so one rejected image-settings
  // update forced a full ONVIF re-handshake on literally every next action
  // (reported as "everything is very slow" right after that failure).
  const isConnectionIssue = /timeout|ECONNREFUSED|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|ONVIF connect failed|socket hang up/i.test(msg);
  if (cameraId && isConnectionIssue) onvif.invalidate(Number(cameraId));
  res.status(isTimeout ? 504 : 502).json({ error: msg, camera_id: cameraId ?? null });
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

router.get('/cameras/:id/capabilities', authenticate, async (req, res) => {
  try {
    const caps = await onvif.getCapabilities(req.params.id);
    await query(
      `INSERT INTO camera_onvif_capabilities
         (camera_id, supports_media, supports_ptz, supports_imaging, supports_audio,
          supports_events, profile_s_conformant, device_service_url, media_service_url,
          ptz_service_url, imaging_service_url, last_checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (camera_id) DO UPDATE SET
         supports_media=$2, supports_ptz=$3, supports_imaging=$4, supports_audio=$5,
         supports_events=$6, profile_s_conformant=$7, device_service_url=$8,
         media_service_url=$9, ptz_service_url=$10, imaging_service_url=$11,
         last_checked_at=NOW()`,
      [
        req.params.id, caps.supports_media, caps.supports_ptz, caps.supports_imaging,
        caps.supports_audio ?? false, caps.supports_events ?? false,
        !!(caps.supports_media && caps.supports_ptz), caps.device_service_url,
        caps.media_service_url, caps.ptz_service_url, caps.imaging_service_url,
      ]
    );
    res.json(caps);
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

/* ------------------------------------------------------------------ */
/* Media profiles / multi-stream selection                             */
/* ------------------------------------------------------------------ */

// GET /cameras/:id/profiles — fetch live from camera, cache in DB, return list
router.get('/cameras/:id/profiles', authenticate, async (req, res) => {
  try {
    const cameraId = req.params.id;
    const profiles = await onvif.getProfiles(cameraId);

    const active = await queryOne(
      `SELECT profile_token FROM camera_media_profiles WHERE camera_id=$1 AND is_active_stream=TRUE`,
      [cameraId]
    );

    for (const prof of profiles) {
      let streamUri = null, snapshotUri = null;
      try { streamUri = await onvif.getStreamUri(cameraId, prof.token); } catch {}
      try { snapshotUri = await onvif.getSnapshotUri(cameraId, prof.token); } catch {}

      await query(
        `INSERT INTO camera_media_profiles
           (camera_id, profile_token, profile_name, encoding, resolution_width,
            resolution_height, fps, bitrate_kbps, gov_length, quality, stream_uri,
            snapshot_uri, video_source_token, audio_encoder_token, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
         ON CONFLICT (camera_id, profile_token) DO UPDATE SET
           profile_name=$3, encoding=$4, resolution_width=$5, resolution_height=$6,
           fps=$7, bitrate_kbps=$8, gov_length=$9, quality=$10, stream_uri=$11,
           snapshot_uri=$12, video_source_token=$13, audio_encoder_token=$14,
           last_synced_at=NOW()`,
        [
          cameraId, prof.token, prof.name, prof.video_encoder?.encoding,
          prof.video_encoder?.resolution?.width, prof.video_encoder?.resolution?.height,
          prof.video_encoder?.frame_rate_limit, prof.video_encoder?.bitrate_limit,
          prof.video_encoder?.gov_length, prof.video_encoder?.quality,
          streamUri, snapshotUri, prof.video_source_token, prof.audio_encoder?.token,
        ]
      );
    }

    // If nothing is marked active yet, default to the first (usually highest-res) profile
    if (!active && profiles.length) {
      await query(
        `UPDATE camera_media_profiles SET is_active_stream=TRUE
         WHERE camera_id=$1 AND profile_token=$2`,
        [cameraId, profiles[0].token]
      );
    }

    const rows = await query(
      `SELECT * FROM camera_media_profiles WHERE camera_id=$1 ORDER BY resolution_width DESC NULLS LAST`,
      [cameraId]
    );
    res.json({ profiles: rows.rows });
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

// POST /cameras/:id/profiles/:token/activate — mark this profile as the one
// the live view / recorder should pull (NVR core re-reads rtsp_url on reload)
router.post('/cameras/:id/profiles/:token/activate', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const { id: cameraId, token } = req.params;
    const prof = await queryOne(
      `SELECT * FROM camera_media_profiles WHERE camera_id=$1 AND profile_token=$2`,
      [cameraId, token]
    );
    if (!prof) return res.status(404).json({ error: 'Profile not found — call GET .../profiles first to sync' });

    await query(`UPDATE camera_media_profiles SET is_active_stream=FALSE WHERE camera_id=$1`, [cameraId]);
    await query(
      `UPDATE camera_media_profiles SET is_active_stream=TRUE WHERE camera_id=$1 AND profile_token=$2`,
      [cameraId, token]
    );

    // Refresh the stream URI and push it into cameras.rtsp_url so the NVR
    // core picks up the newly selected stream on its next config reload.
    let uri = prof.stream_uri;
    try { uri = await onvif.getStreamUri(cameraId, token); } catch {}
    if (uri) {
      await query(`UPDATE cameras SET rtsp_url=$1, updated_at=NOW() WHERE camera_id=$2`, [uri, cameraId]);
    }

    broadcast?.({ type: 'camera.stream_profile_changed', data: { camera_id: Number(cameraId), profile_token: token, stream_uri: uri } });
    res.json({ activated: token, stream_uri: uri, note: 'NVR core will use this stream on next config reload (POST /api/nvr/reload)' });
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

/* ------------------------------------------------------------------ */
/* PTZ                                                                  */
/* ------------------------------------------------------------------ */

router.get('/cameras/:id/ptz/status', authenticate, async (req, res) => {
  try {
    const status = await onvif.ptzGetStatus(req.params.id);
    await query(
      `INSERT INTO camera_ptz_status (camera_id, pan, tilt, zoom, move_status, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (camera_id) DO UPDATE SET
         pan=$2, tilt=$3, zoom=$4, move_status=$5, updated_at=NOW()`,
      [req.params.id, status.pan, status.tilt, status.zoom, status.move_status || 'IDLE']
    );
    res.json(status);
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

// POST /cameras/:id/ptz/move  { mode, x, y, zoom, speed, timeout }
router.post('/cameras/:id/ptz/move', authenticate, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  try {
    const { mode = 'continuous', x = 0, y = 0, zoom = 0, speed, timeout } = req.body;
    const cameraId = req.params.id;

    let result;
    if (mode === 'continuous') result = await onvif.ptzContinuousMove(cameraId, { x, y, zoom, timeout });
    else if (mode === 'relative') result = await onvif.ptzRelativeMove(cameraId, { x, y, zoom, speed });
    else if (mode === 'absolute') result = await onvif.ptzAbsoluteMove(cameraId, { x, y, zoom, speed });
    else return res.status(400).json({ error: 'mode must be continuous, relative, or absolute' });

    res.json({ moved: true, mode, x, y, zoom });
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

router.post('/cameras/:id/ptz/stop', authenticate, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  try {
    const { panTilt = true, zoom = true } = req.body || {};
    await onvif.ptzStop(req.params.id, { panTilt, zoom });
    res.json({ stopped: true });
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

router.post('/cameras/:id/ptz/home', authenticate, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  try {
    const { action = 'goto', speed } = req.body || {};
    if (action === 'set') await onvif.ptzSetHome(req.params.id);
    else await onvif.ptzGotoHome(req.params.id, speed);
    res.json({ action });
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

// Presets — synced with DB so the UI has names even when the camera is briefly offline
router.get('/cameras/:id/ptz/presets', authenticate, async (req, res) => {
  try {
    const cameraId = req.params.id;
    let presets = [];
    try {
      presets = await onvif.ptzGetPresets(cameraId);
      for (const pr of presets) {
        await query(
          `INSERT INTO camera_ptz_presets (camera_id, preset_token, preset_name, pan, tilt, zoom, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           ON CONFLICT (camera_id, preset_token) DO UPDATE SET
             preset_name=$3, pan=$4, tilt=$5, zoom=$6, updated_at=NOW()`,
          [cameraId, pr.token, pr.name, pr.position?.panTilt?.x, pr.position?.panTilt?.y, pr.position?.zoom?.x]
        );
      }
    } catch (liveErr) {
      // Camera unreachable — fall back to last-known presets from DB
    }
    const rows = await query(`SELECT * FROM camera_ptz_presets WHERE camera_id=$1 ORDER BY preset_name`, [cameraId]);
    res.json({ presets: rows.rows, live: presets.length > 0 });
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

router.post('/cameras/:id/ptz/presets', authenticate, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const result = await onvif.ptzSetPreset(req.params.id, name);
    const token = result?.presetToken || result;
    res.status(201).json({ token, name });
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

router.post('/cameras/:id/ptz/presets/:token/goto', authenticate, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  try {
    const { speed } = req.body || {};
    await onvif.ptzGotoPreset(req.params.id, req.params.token, speed);
    res.json({ moved_to: req.params.token });
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

router.delete('/cameras/:id/ptz/presets/:token', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    await onvif.ptzRemovePreset(req.params.id, req.params.token);
    await query(`DELETE FROM camera_ptz_presets WHERE camera_id=$1 AND preset_token=$2`, [req.params.id, req.params.token]);
    res.json({ deleted: req.params.token });
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

/* ------------------------------------------------------------------ */
/* Imaging settings (brightness / contrast / saturation / sharpness)  */
/* ------------------------------------------------------------------ */

router.get('/cameras/:id/image', authenticate, async (req, res) => {
  try {
    const cameraId = req.params.id;
    const live = await onvif.getImagingSettings(cameraId);

    // Fetch this camera's actual supported brightness/contrast/saturation/
    // sharpness range. This was never called before, so the *_min/*_max
    // columns below (which exist precisely to bound the UI sliders per
    // camera) stayed at their generic 0-100 default for every camera. Real
    // cameras frequently use a different range (0-255 is common) - the
    // slider let you pick a value inside 0-100 that the camera itself then
    // rejected as out of range. Not every camera implements GetOptions, so
    // this is best-effort: on failure we just keep whatever range is
    // already stored (or the 0-100 default on first sync).
    let opts = null;
    try {
      opts = await onvif.getImagingOptions(cameraId);
    } catch (optErr) {
      console.warn(`[onvif] GetOptions unsupported/failed for camera ${cameraId}: ${optErr.message}`);
    }
    const range = (o, fallbackMin, fallbackMax) => ({
      min: typeof o?.min === 'number' ? o.min : fallbackMin,
      max: typeof o?.max === 'number' ? o.max : fallbackMax,
    });
    const bRange = range(opts?.brightness, 0, 100);
    const cRange = range(opts?.contrast, 0, 100);
    const sRange = range(opts?.colorSaturation, 0, 100);
    const shRange = range(opts?.sharpness, 0, 100);

    const row = await queryOne(
      `INSERT INTO camera_image_settings
         (camera_id, video_source_token, brightness, contrast, color_saturation,
          sharpness, ir_cut_filter, wide_dynamic_range, exposure_mode,
          brightness_min, brightness_max, contrast_min, contrast_max,
          saturation_min, saturation_max, sharpness_min, sharpness_max,
          last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
       ON CONFLICT (camera_id) DO UPDATE SET
         video_source_token=$2, brightness=$3, contrast=$4, color_saturation=$5,
         sharpness=$6, ir_cut_filter=$7, wide_dynamic_range=$8, exposure_mode=$9,
         brightness_min=$10, brightness_max=$11, contrast_min=$12, contrast_max=$13,
         saturation_min=$14, saturation_max=$15, sharpness_min=$16, sharpness_max=$17,
         last_synced_at=NOW()
       RETURNING *`,
      [
        cameraId, live.token,
        live.brightness, live.contrast, live.colorSaturation, live.sharpness,
        live.irCutFilter || 'AUTO',
        live.wideDynamicRange?.mode === 'ON',
        live.exposure?.mode || 'AUTO',
        bRange.min, bRange.max, cRange.min, cRange.max,
        sRange.min, sRange.max, shRange.min, shRange.max,
      ]
    );
    res.json(row);
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

router.put('/cameras/:id/image', authenticate, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  try {
    const cameraId = req.params.id;
    const { brightness, contrast, saturation, sharpness, ir_cut_filter, wide_dynamic_range, exposure_mode } = req.body;

    // Validate numeric fields against this camera's actual known range
    // (synced by GET .../image above into camera_image_settings.*_min/max)
    // before making any ONVIF call. Sending a value the camera considers
    // out of range is what produced the "requested settings are incorrect"
    // SOAP fault - catching it here is instant, and never touches the
    // camera or its cached connection at all.
    const bounds = await queryOne(
      `SELECT brightness_min, brightness_max, contrast_min, contrast_max,
              saturation_min, saturation_max, sharpness_min, sharpness_max
       FROM camera_image_settings WHERE camera_id = $1`,
      [cameraId]
    );
    const outOfRange = (label, value, min, max) => {
      if (value === undefined || min == null || max == null) return null;
      if (value < min || value > max) {
        return `${label} must be between ${min} and ${max} for this camera (got ${value})`;
      }
      return null;
    };
    const rangeError = bounds && (
      outOfRange('brightness', brightness, bounds.brightness_min, bounds.brightness_max) ||
      outOfRange('contrast', contrast, bounds.contrast_min, bounds.contrast_max) ||
      outOfRange('saturation', saturation, bounds.saturation_min, bounds.saturation_max) ||
      outOfRange('sharpness', sharpness, bounds.sharpness_min, bounds.sharpness_max)
    );
    if (rangeError) {
      return res.status(400).json({ error: rangeError, camera_id: cameraId });
    }

    const settings = {};
    if (brightness !== undefined) settings.brightness = brightness;
    if (contrast !== undefined) settings.contrast = contrast;
    if (saturation !== undefined) settings.colorSaturation = saturation;
    if (sharpness !== undefined) settings.sharpness = sharpness;
    if (ir_cut_filter !== undefined) settings.irCutFilter = ir_cut_filter;
    if (wide_dynamic_range !== undefined) settings.wideDynamicRange = { mode: wide_dynamic_range ? 'ON' : 'OFF' };
    if (exposure_mode !== undefined) settings.exposure = { mode: exposure_mode };

    await onvif.setImagingSettings(cameraId, settings);

    const row = await queryOne(
      `UPDATE camera_image_settings SET
         brightness        = COALESCE($2, brightness),
         contrast          = COALESCE($3, contrast),
         color_saturation  = COALESCE($4, color_saturation),
         sharpness         = COALESCE($5, sharpness),
         ir_cut_filter     = COALESCE($6, ir_cut_filter),
         wide_dynamic_range= COALESCE($7, wide_dynamic_range),
         exposure_mode     = COALESCE($8, exposure_mode),
         updated_at = NOW()
       WHERE camera_id=$1
       RETURNING *`,
      [cameraId, brightness, contrast, saturation, sharpness, ir_cut_filter, wide_dynamic_range, exposure_mode]
    );
    res.json(row);
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

/* ------------------------------------------------------------------ */
/* Audio settings                                                       */
/* ------------------------------------------------------------------ */

router.get('/cameras/:id/audio', authenticate, async (req, res) => {
  try {
    const cameraId = req.params.id;
    const configs = await onvif.getAudioEncoderConfigurations(cameraId).catch(() => []);
    const cfg = Array.isArray(configs) ? configs[0] : configs;

    const row = await queryOne(
      `INSERT INTO camera_audio_settings
         (camera_id, audio_encoder_token, encoding, bitrate_kbps, sample_rate_khz, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (camera_id) DO UPDATE SET
         audio_encoder_token=$2, encoding=$3, bitrate_kbps=$4, sample_rate_khz=$5,
         last_synced_at=NOW()
       RETURNING *`,
      [
        cameraId,
        cfg?.$ ? cfg.$.token : cfg?.token,
        cfg?.encoding,
        cfg?.bitrate,
        cfg?.sampleRate,
      ]
    );
    res.json(row);
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

router.put('/cameras/:id/audio', authenticate, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  try {
    const cameraId = req.params.id;
    const { encoding, bitrate_kbps, sample_rate_khz, is_enabled } = req.body;

    const existing = await queryOne(`SELECT * FROM camera_audio_settings WHERE camera_id=$1`, [cameraId]);
    if (existing?.audio_encoder_token) {
      await onvif.setAudioEncoderConfiguration(cameraId, {
        token: existing.audio_encoder_token,
        encoding: encoding || existing.encoding,
        bitrate: bitrate_kbps || existing.bitrate_kbps,
        sampleRate: sample_rate_khz || existing.sample_rate_khz,
      }).catch((e) => { throw e; });
    }

    const row = await queryOne(
      `UPDATE camera_audio_settings SET
         encoding        = COALESCE($2, encoding),
         bitrate_kbps    = COALESCE($3, bitrate_kbps),
         sample_rate_khz = COALESCE($4, sample_rate_khz),
         is_enabled      = COALESCE($5, is_enabled),
         updated_at = NOW()
       WHERE camera_id=$1
       RETURNING *`,
      [cameraId, encoding, bitrate_kbps, sample_rate_khz, is_enabled]
    );
    res.json(row);
  } catch (err) { handleOnvifError(res, err, req.params.id); }
});

/* ------------------------------------------------------------------ */
/* Discovery — used by the "Add Camera" tree-view flow. Two steps:     */
/*   1) GET  /discover               find devices on the LAN           */
/*   2) POST /discover/probe         connect with creds, read streams  */
/* Neither step writes to the DB — the caller still POSTs to           */
/* /api/cameras (existing flow) once the operator confirms.            */
/* ------------------------------------------------------------------ */

router.get('/discover', authenticate, requireRole('ADMIN', 'OPERATOR'), async (req, res) => {
  try {
    const timeoutMs = Math.min(Math.max(Number(req.query.timeout_ms) || 4000, 1000), 15000);
    const found = await onvif.discoverDevices(timeoutMs);

    // Mark devices that are already saved as cameras so the UI can grey
    // them out instead of letting the operator add the same camera twice.
    const existing = await query(`SELECT ip_address FROM cameras`);
    const knownIps = new Set(existing.rows.map((r) => r.ip_address));

    res.json({
      devices: found.map((d) => ({ ...d, already_added: knownIps.has(d.hostname) })),
      count: found.length,
    });
  } catch (err) {
    console.error('[onvif:discover]', err);
    res.status(500).json({ error: 'Discovery failed', detail: err.message });
  }
});

router.post('/discover/probe', authenticate, requireRole('ADMIN', 'OPERATOR'), async (req, res) => {
  try {
    const { hostname, port, path, username, password } = req.body;
    if (!hostname) return res.status(400).json({ error: 'hostname is required' });
    if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

    const info = await onvif.probeDevice({ hostname, port, path, username, password });
    res.json(info);
  } catch (err) {
    const msg = err?.message || String(err);
    // Many cameras refuse ONVIF until their factory password has been changed / the camera activated. That has to be done
    // on the camera itself (its web page or vendor app); the NVR cannot do it for them. Say so plainly, and point to the
    // RTSP-address option, which does not need ONVIF.
    if (/(must|need|should|require)[^.]{0,40}(change|modif|reset)[^.]{0,30}password|password[^.]{0,30}(expired|must be changed|change required)|not activated|inactive device|activate (the )?(device|camera)/i.test(msg)) {
      return res.status(409).json({
        code: 'CAMERA_PASSWORD_CHANGE_REQUIRED',
        error: 'This camera still has its factory password or is not activated, so it refuses ONVIF requests. Change the password (or activate it) in the camera\'s own web page or app, then connect again with the new password - or add it by its RTSP address instead.',
      });
    }
    const isAuth = /not authorized|unauthorized|sender not authorized/i.test(msg);
    res.status(isAuth ? 401 : 502).json({ error: isAuth ? `${msg} - check the camera's username and password (some cameras need a new password set first)` : msg });
  }
});

module.exports = router;
