const express = require('express');
const { query, queryOne, withTransaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { broadcast } = require('../websocket');
const { checkRtspConnectivity, buildRtspUrlWithCreds, splitRtspUrl, maskCredentials } = require('../services/rtspCheck');
const autoDiscovery = require('../services/streamAutoDiscovery');
const router = express.Router();

const SAFE_ID_RE = /^\d+$/;

// OWASP A02 (Cryptographic Failures / Sensitive Data Exposure): a camera's
// RTSP credentials must never be returned to the browser, regardless of the
// caller's role. `SELECT c.*` previously did exactly that. Every camera
// response is now built from an explicit column list.
const CAMERA_PUBLIC_COLUMNS = `
  c.camera_id, c.camera_name, c.camera_type, c.ip_address, c.rtsp_port,
  c.username, c.manufacturer, c.model, c.resolution_width, c.resolution_height,
  c.target_fps, c.video_codec, c.location_description, c.physical_position,
  c.ptz_supported, c.audio_supported, c.status, c.hls_playlist_url,
  c.ai_model, c.ai_confidence_threshold, c.ai_detection_enabled,
  c.added_at, c.updated_at, c.last_seen_at
`;
// rtsp_url, rec_rtsp_url, third_rtsp_url and password_hash intentionally
// excluded — every one of those RTSP URLs can embed the camera credential
// (see credential-doubling bug fixed elsewhere), so they're just as
// sensitive as the password field itself. They're write-only from the
// browser's perspective: the Add/Edit Camera form sends them, but GET
// responses never echo them back.

function isValidId(id) {
  return SAFE_ID_RE.test(String(id));
}

router.get('/', authenticate, async (req, res) => {
  try {
    const { status, camera_type, location } = req.query;
    let limit = parseInt(req.query.limit, 10);
    let offset = parseInt(req.query.offset, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 100;
    if (limit > 500) limit = 500; // OWASP A04: cap page size against resource exhaustion
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const conds = [], params = [];
    if (status)      { params.push(status.toUpperCase()); conds.push(`c.status=$${params.length}`); }
    if (camera_type) { params.push(camera_type.toUpperCase()); conds.push(`c.camera_type=$${params.length}`); }
    if (location)    { params.push(`%${location}%`); conds.push(`c.location_description ILIKE $${params.length}`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = parseInt((await query(`SELECT COUNT(*) FROM cameras c ${where}`, params)).rows[0].count);
    params.push(limit, offset);
    const rows = await query(
      `SELECT ${CAMERA_PUBLIC_COLUMNS},
              ch.is_online, ch.is_recording, ch.frame_rate_actual,
              ch.bitrate_kbps, ch.error_count, ch.last_error,
              ch.timestamp AS health_ts
       FROM cameras c
       LEFT JOIN LATERAL (
         SELECT * FROM camera_health
         WHERE camera_id=c.camera_id
         ORDER BY timestamp DESC LIMIT 1
       ) ch ON true
       ${where}
       ORDER BY c.camera_name
       LIMIT $${params.length-1} OFFSET $${params.length}`, params);
    res.json({ cameras: rows.rows, total, limit, offset });
  } catch (err) {
    console.error('[cameras:list]', err);
    res.status(500).json({ error: 'Failed to load cameras' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid camera id' });
    const cam = await queryOne(
      `SELECT ${CAMERA_PUBLIC_COLUMNS},
              ch.is_online, ch.is_recording, ch.frame_rate_actual, ch.bitrate_kbps, ch.last_error
       FROM cameras c
       LEFT JOIN LATERAL (
         SELECT * FROM camera_health WHERE camera_id=c.camera_id ORDER BY timestamp DESC LIMIT 1
       ) ch ON true
       WHERE c.camera_id=$1`, [req.params.id]);
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    res.json(cam);
  } catch (err) {
    console.error('[cameras:get]', err);
    res.status(500).json({ error: 'Failed to load camera' });
  }
});

// Keeps cameras_config_details (per-IP ONVIF/RTSP credential store — see
// server/schema.sql "CAMERA CONFIGURATION" section) in sync with what was
// just entered on the Add/Edit Camera form. This used to be a completely
// separate manual step on the Settings page; skipping it — or leaving a
// stale row there from an earlier camera at the same IP — is exactly what
// caused streams to silently keep using old/wrong credentials, because
// mediamtx-sync.py and onvifClient.js both prefer cameras_config_details
// over cameras.username/password_hash when both exist (COALESCE(cd.*, c.*)).
// Upserting here means there is only ever one place data has to be typed,
// and the two tables can never drift apart for a camera added/edited
// through the API.
// Note: camera_slot is picked via MAX(camera_slot)+1 inside the same
// statement, which has a small race window under concurrent camera adds
// (two admins adding cameras in the same instant could collide on the
// UNIQUE camera_slot constraint). Given this is an admin-only, low-
// frequency operation, that's an acceptable trade-off — a collision fails
// the whole transaction (nothing partially written) and the admin just
// retries, rather than risking a more complex locking scheme here.
async function syncConfigDetails(client, cam) {
  if (!cam.ip_address) return; // nothing to key the config-details row on
  await client.query(
    `INSERT INTO cameras_config_details
       (camera_slot, name, location, camera_type, ip_address, onvif_port,
        onvif_username, onvif_password, rtsp_username, rtsp_password,
        manufacturer, model, is_active)
     SELECT COALESCE((SELECT MAX(camera_slot) FROM cameras_config_details), 0) + 1,
            $1,$2,$3,$4::inet,COALESCE($5,80),$6,$7,$6,$7,$8,$9,$10
     ON CONFLICT (ip_address) DO UPDATE SET
       name=EXCLUDED.name, location=EXCLUDED.location, camera_type=EXCLUDED.camera_type,
       -- $5/$6/$7/$8/$9 (port/creds/manufacturer/model) come through as NULL
       -- from a PUT that didn't touch those fields (e.g. renaming a camera
       -- shouldn't blank out its ONVIF port or credentials) — COALESCE onto
       -- the existing row so a partial update never wipes them.
       onvif_port=COALESCE($5, cameras_config_details.onvif_port),
       onvif_username=COALESCE($6, cameras_config_details.onvif_username),
       onvif_password=COALESCE($7, cameras_config_details.onvif_password),
       rtsp_username=COALESCE($6, cameras_config_details.rtsp_username),
       rtsp_password=COALESCE($7, cameras_config_details.rtsp_password),
       manufacturer=COALESCE($8, cameras_config_details.manufacturer),
       model=COALESCE($9, cameras_config_details.model),
       is_active=$10, updated_at=NOW()`,
    [cam.camera_name, cam.location_description || null, cam.camera_type,
     cam.ip_address, cam.onvif_port || null, cam.username || null,
     cam.password_hash || null, cam.manufacturer || null, cam.model || null,
     cam.status !== 'INACTIVE']);
}

// Runs the same connectivity probe mediamtx-sync.py will end up doing on
// its own next cycle, but synchronously and immediately, so the person
// saving the camera finds out right now whether it actually connects
// instead of only discovering it later from a blank tile. Uses the same
// URL-selection logic as mediamtx-sync.py (rec_rtsp_url falls back to
// rtsp_url) so a green result here means the live pipeline will succeed too.
async function probeCameraConnectivity(cam) {
  const targetUrl = cam.rec_rtsp_url || cam.rtsp_url;
  if (!targetUrl) return { reachable: false, error: 'No RTSP URL configured' };
  const authedUrl = buildRtspUrlWithCreds(targetUrl, cam.username, cam.password_hash);
  return checkRtspConnectivity(authedUrl);
}

// POST /api/cameras/probe-rtsp - "does this RTSP address work?" Used by the Add Camera dialog before anything is saved.
// Body: { rtsp_url, username?, password? }  (credentials may also be inside the URL). Writes nothing.
router.post('/probe-rtsp', authenticate, requireRole('ADMIN', 'OPERATOR'), async (req, res) => {
  try {
    const parts = splitRtspUrl(req.body && req.body.rtsp_url);
    const user = (req.body && req.body.username) || parts.username;
    const pass = (req.body && req.body.password) || parts.password;
    const result = await checkRtspConnectivity(buildRtspUrlWithCreds(parts.url, user, pass), { timeoutMs: 8000 });
    res.json({ ...result, host: parts.host, port: parts.port, rtsp_url: maskCredentials(parts.url), has_credentials: !!(user && pass) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    let { camera_name, camera_type='INTERIOR', ip_address='', rtsp_url='',
            rec_rtsp_url, third_rtsp_url,
            rtsp_port=554, username, password_hash, onvif_port,
            manufacturer, model,
            resolution_width=1920, resolution_height=1080, target_fps=25,
            video_codec='H.265', location_description, physical_position,
            ptz_supported=0, audio_supported=0,
            ai_model='yolov8n.pt', ai_confidence_threshold=0.35, ai_detection_enabled=true } = req.body;
    if (!camera_name) return res.status(400).json({ error: 'camera_name required' });
    // The address may be typed as a full RTSP URL (with user:password@): keep credentials out of the stored URL and fill in
    // host / port / credentials from it when they were not given separately.
    for (const k of ['rtsp_url', 'rec_rtsp_url', 'third_rtsp_url']) {
      const v = req.body[k];
      if (!v) continue;
      let parts;
      try { parts = splitRtspUrl(v); } catch (e) { return res.status(400).json({ error: `${k}: ${e.message}` }); }
      req.body[k] = parts.url;
      if (k === 'rtsp_url') {
        if (!req.body.ip_address) req.body.ip_address = parts.host;
        if (!req.body.rtsp_port || req.body.rtsp_port === 554) req.body.rtsp_port = parts.port;
      }
      if (!req.body.username && parts.username) { req.body.username = parts.username; req.body.password_hash = parts.password; }
    }
    ({ ip_address, rtsp_url, username, password_hash } = { ip_address: req.body.ip_address || '', rtsp_url: req.body.rtsp_url || '', username: req.body.username, password_hash: req.body.password_hash });
    if (req.body.rec_rtsp_url !== undefined) rec_rtsp_url = req.body.rec_rtsp_url;
    if (req.body.third_rtsp_url !== undefined) third_rtsp_url = req.body.third_rtsp_url;
    if (req.body.rtsp_port) rtsp_port = req.body.rtsp_port;
    if (ai_confidence_threshold < 0 || ai_confidence_threshold > 1) {
      return res.status(400).json({ error: 'ai_confidence_threshold must be between 0 and 1' });
    }
    const camType = camera_type.toUpperCase();
    const publicCam = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO cameras(camera_name,camera_type,ip_address,rtsp_url,rec_rtsp_url,
           third_rtsp_url,rtsp_port,username,password_hash,manufacturer,model,
           resolution_width,resolution_height,target_fps,video_codec,
           location_description,physical_position,ptz_supported,audio_supported,
           ai_model,ai_confidence_threshold,ai_detection_enabled)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING camera_id`,
        [camera_name,camType,ip_address,rtsp_url,rec_rtsp_url||null,third_rtsp_url||null,
         rtsp_port,username||null,password_hash||null,manufacturer||null,model||null,
         resolution_width,resolution_height,target_fps,video_codec,
         location_description||null,physical_position||null,ptz_supported,audio_supported,
         ai_model,ai_confidence_threshold,ai_detection_enabled]);
      const camera_id = rows[0].camera_id;

      // One form submit now populates both tables — see syncConfigDetails
      // doc comment above for why this matters for the stream to come up.
      await syncConfigDetails(client, {
        camera_name, camera_type: camType, ip_address, onvif_port,
        username, password_hash, manufacturer, model,
        location_description, status: 'ACTIVE',
      });

      // Re-fetch through the public column list so the response never
      // includes the credential fields we just wrote.
      const { rows: pubRows } = await client.query(
        `SELECT ${CAMERA_PUBLIC_COLUMNS} FROM cameras c WHERE c.camera_id=$1`, [camera_id]);
      return pubRows[0];
    });
    broadcast({ type: 'camera.created', data: publicCam });
    // Probe AFTER the transaction commits — connectivity is informational,
    // never a reason to roll back a save the admin explicitly asked for
    // (the camera might be temporarily powered off, still fine to save).
    // No stream address but credentials given -> ask the camera for it now.
    let effectiveRtsp = rtsp_url;
    let outCam = publicCam;
    if (!rtsp_url && ip_address && password_hash) {
      const d = await autoDiscovery.discoverForCamera(publicCam.camera_id).catch(() => ({ ok: false }));
      if (d.ok && d.changed) {
        effectiveRtsp = d.rtsp_url;
        const { rows: r2 } = await query(`SELECT ${CAMERA_PUBLIC_COLUMNS} FROM cameras c WHERE c.camera_id=$1`, [publicCam.camera_id]);
        outCam = r2[0] || publicCam;
        broadcast({ type: 'camera.updated', data: outCam });
      }
    }
    const connectivity = await probeCameraConnectivity({
      rtsp_url: effectiveRtsp, rec_rtsp_url, username, password_hash,
    });
    res.status(201).json({ ...outCam, connectivity });
  } catch (err) {
    console.error('[cameras:create]', err);
    res.status(500).json({ error: 'Failed to create camera' });
  }
});

router.put('/:id', authenticate, requireRole('ADMIN','OPERATOR'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid camera id' });
    const allowed = ['camera_name','camera_type','ip_address','rtsp_url',
                     'rec_rtsp_url','third_rtsp_url','rtsp_port',
                     'location_description','physical_position','status','target_fps',
                     'video_codec','resolution_width','resolution_height',
                     'ptz_supported','audio_supported','manufacturer','model',
                     'hls_playlist_url','hls_output_dir','rec_output_dir',
                     'ai_model','ai_confidence_threshold','ai_detection_enabled'];
    // Credential fields (username/password_hash) are deliberately absent
    // from `allowed` here — rotating a camera credential goes through a
    // dedicated, more tightly audited endpoint rather than the general
    // mass-update handler.
    const fields = [], params = [];
    for (const [k,v] of Object.entries(req.body))
      if (allowed.includes(k)) { params.push(v); fields.push(`${k}=$${params.length}`); }
    if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
    fields.push('updated_at=NOW()');
    params.push(parseInt(req.params.id, 10));

    const cam = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE cameras SET ${fields.join(',')} WHERE camera_id=$${params.length} RETURNING *`,
        params);
      if (!rows.length) return null;
      const full = rows[0];
      // Keep cameras_config_details in step with whatever just changed
      // (e.g. IP address, location, name) — same reasoning as the create
      // path above. Credentials/onvif_port weren't part of this request,
      // so they're passed through unset and COALESCE-preserved inside
      // syncConfigDetails rather than being wiped.
      await syncConfigDetails(client, {
        camera_name: full.camera_name, camera_type: full.camera_type,
        ip_address: full.ip_address, location_description: full.location_description,
        manufacturer: full.manufacturer, model: full.model,
        username: full.username, password_hash: full.password_hash,
        status: full.status,
      });
      const { rows: pubRows } = await client.query(
        `SELECT ${CAMERA_PUBLIC_COLUMNS} FROM cameras c WHERE c.camera_id=$1`, [full.camera_id]);
      return pubRows[0];
    });
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    broadcast({ type: 'camera.updated', data: cam });
    // Re-probe whenever an edit could plausibly affect reachability —
    // covers "I fixed the password/IP/URL" without a separate button.
    const FULL_SQL = 'SELECT rtsp_url, rec_rtsp_url, username, password_hash FROM cameras WHERE camera_id=$1';
    let full = await queryOne(FULL_SQL, [req.params.id]);
    if (full && !(full.rec_rtsp_url || full.rtsp_url) && full.password_hash) {
      const d = await autoDiscovery.discoverForCamera(parseInt(req.params.id, 10)).catch(() => ({ ok: false }));
      if (d.ok && d.changed) full = await queryOne(FULL_SQL, [req.params.id]);
    }
    const connectivity = full ? await probeCameraConnectivity(full) : null;
    res.json({ ...cam, connectivity });
  } catch (err) {
    console.error('[cameras:update]', err);
    res.status(500).json({ error: 'Failed to update camera' });
  }
});

// The one deliberately narrow way to change a camera's username/password
// after creation. Kept separate from the general PUT /:id (which
// intentionally excludes credentials) so credential changes are easy to
// find in an audit log by route name alone, and so a bug in the general
// field-update logic can never accidentally blank out a password. Re-probes
// connectivity immediately afterward — this is precisely the workflow that
// used to require dropping into psql by hand.
router.put('/:id/credentials', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid camera id' });
    const { username, password_hash } = req.body;
    if (!username && !password_hash) {
      return res.status(400).json({ error: 'username and/or password_hash required' });
    }
    const cam = await withTransaction(async (client) => {
      const fields = [], params = [];
      if (username !== undefined)      { params.push(username); fields.push(`username=$${params.length}`); }
      if (password_hash !== undefined) { params.push(password_hash); fields.push(`password_hash=$${params.length}`); }
      fields.push('updated_at=NOW()');
      params.push(parseInt(req.params.id, 10));
      const { rows } = await client.query(
        `UPDATE cameras SET ${fields.join(',')} WHERE camera_id=$${params.length} RETURNING *`, params);
      if (!rows.length) return null;
      const full = rows[0];
      await syncConfigDetails(client, {
        camera_name: full.camera_name, camera_type: full.camera_type,
        ip_address: full.ip_address, location_description: full.location_description,
        manufacturer: full.manufacturer, model: full.model,
        username: full.username, password_hash: full.password_hash,
        status: full.status,
      });
      return full;
    });
    if (!cam) return res.status(404).json({ error: 'Camera not found' });
    if (!(cam.rec_rtsp_url || cam.rtsp_url) && cam.password_hash) {
      // Credentials just changed on a camera with no stream address: ask the camera itself.
      const d = await autoDiscovery.discoverForCamera(cam.camera_id).catch(() => ({ ok: false }));
      if (d.ok && d.changed) cam.rtsp_url = d.rtsp_url;
    }
    const connectivity = await probeCameraConnectivity(cam);
    const { rows: pubRows } = await query(`SELECT ${CAMERA_PUBLIC_COLUMNS} FROM cameras c WHERE c.camera_id=$1`, [cam.camera_id]);
    broadcast({ type: 'camera.updated', data: pubRows[0] });
    res.json({ ...pubRows[0], connectivity });
  } catch (err) {
    console.error('[cameras:credentials]', err);
    res.status(500).json({ error: 'Failed to update credentials' });
  }
});

router.delete('/:id', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid camera id' });
    const r = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'DELETE FROM cameras WHERE camera_id=$1 RETURNING camera_id, ip_address', [req.params.id]);
      if (rows.length && rows[0].ip_address) {
        // Best-effort: drop the matching config-details row too, so a
        // deleted camera doesn't leave stale credentials sitting around
        // at that IP for the next camera added there to silently inherit.
        await client.query(
          'DELETE FROM cameras_config_details WHERE ip_address=$1::inet', [rows[0].ip_address]
        ).catch((e) => console.warn('[cameras:delete] config-details cleanup skipped:', e.message));
      }
      return rows;
    });
    if (!r.length) return res.status(404).json({ error: 'Camera not found' });
    broadcast({ type: 'camera.deleted', data: { camera_id: parseInt(req.params.id, 10) } });
    res.json({ message: 'Deleted', camera_id: parseInt(req.params.id, 10) });
  } catch (err) {
    console.error('[cameras:delete]', err);
    res.status(500).json({ error: 'Failed to delete camera' });
  }
});

module.exports = router;
