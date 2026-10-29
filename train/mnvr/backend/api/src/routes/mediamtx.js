/**
 * MediaMTX proxy routes — the frontend calls these to get WebRTC/HLS URLs
 * without needing to know the MediaMTX host (useful for Docker/production).
 */
const express = require("express");
const axios = require("axios");
const { query } = require("../db");
const { authenticate } = require("../middleware/auth");

const router = express.Router();
const MTX_API = process.env.MEDIAMTX_API || "http://localhost:9997";
const MTX_RTSP = process.env.MEDIAMTX_RTSP || "localhost:8554";
// MEDIAMTX_WEB/MEDIAMTX_HLS default to null (not "localhost") so we can
// tell "explicitly configured" apart from "not set". When not set, we
// derive the host per-request from req.hostname below — whatever host the
// browser used to reach this API is also the host MediaMTX is reachable
// on (same box). Hardcoding "localhost" here meant every WebRTC/HLS URL
// silently pointed at the *viewer's own machine* whenever the dashboard
// on this same box). Hardcoding "localhost" here meant every WebRTC/HLS
// URL silently pointed at the *viewer's own machine* whenever the
// dashboard was opened from anywhere other than the NVR box itself — the
// live path would exist and be healthy in MediaMTX, but nothing would
// ever load in the browser, with no error surfaced anywhere obvious.
const MTX_WEB_ENV = process.env.MEDIAMTX_WEB || null;
const MTX_HLS_ENV = process.env.MEDIAMTX_HLS || null;
function mtxWebFor(req) { return MTX_WEB_ENV || `${req.protocol}://${req.hostname}:8889`; }
function mtxHlsFor(req) { return MTX_HLS_ENV || `${req.protocol}://${req.hostname}:8888`; }

// GET /api/mediamtx/cameras  — cameras with their MediaMTX URLs
router.get("/cameras", authenticate, async (req, res) => {
  try {
    // OWASP A02: rtsp_url frequently embeds the camera's RTSP credentials
    // (rtsp://user:pass@host/...). It must never be sent to the browser —
    // the client only needs the WebRTC/HLS URLs constructed below, which
    // carry no credential.
    const rows = await query(
      `SELECT camera_id, camera_name, camera_type, ip_address, status, location_description,
              (third_rtsp_url IS NOT NULL AND third_rtsp_url != '') AS has_third_stream
       FROM cameras WHERE status='ACTIVE' ORDER BY camera_id`,
    );

    // Check which paths are live in MediaMTX
    let livePaths = new Set();
    try {
      const r = await axios.get(`${MTX_API}/v3/paths/list`, { timeout: 3000 });
      (r.data.items || []).forEach((p) => livePaths.add(p.name));
    } catch {
      /* MediaMTX may still be starting */
    }

    const cameras = rows.rows.map((cam) => {
      const pathName = `cam_${cam.camera_id}`;
      const isLive = livePaths.has(pathName);
      const mediamtx = {
        path_name: pathName,
        is_live: isLive,
        webrtc_url: `${mtxWebFor(req)}/${pathName}/whep`, // WHEP for browser WebRTC
        hls_url: `${mtxHlsFor(req)}/${pathName}/index.m3u8`,
        // rtsp_url intentionally omitted — it is only used internally
        // between the recorder/mnvrd and MediaMTX, never by the browser.
      };
      if (cam.has_third_stream) {
        const thirdPath = `${pathName}_third`;
        mediamtx.third_stream = {
          path_name: thirdPath,
          is_live: livePaths.has(thirdPath),
          webrtc_url: `${mtxWebFor(req)}/${thirdPath}/whep`,
          hls_url: `${mtxHlsFor(req)}/${thirdPath}/index.m3u8`,
        };
      }
      const { has_third_stream, ...camPublic } = cam;
      return { ...camPublic, mediamtx };
    });

    res.json({ cameras, mediamtx_api: MTX_API });
  } catch (err) {
    console.error('[mediamtx:cameras]', err);
    res.status(500).json({ error: 'Failed to load camera streams' });
  }
});

// GET /api/mediamtx/status  — MediaMTX health
router.get("/status", authenticate, async (req, res) => {
  try {
    const [paths, version] = await Promise.all([
      axios
        .get(`${MTX_API}/v3/paths/list`, { timeout: 3000 })
        .then((r) => r.data)
        .catch(() => null),
      axios
        .get(`${MTX_API}/v3/config/global/get`, { timeout: 3000 })
        .then((r) => r.data)
        .catch(() => null),
    ]);
    res.json({
      online: !!paths,
      active_paths: (paths?.items || []).length,
      webrtc_url: mtxWebFor(req),
      hls_url: mtxHlsFor(req),
      rtsp_url: `rtsp://${MTX_RTSP}`,
      api_url: MTX_API,
    });
  } catch (err) {
    console.error('[mediamtx:status]', err.message);
    res.status(503).json({ online: false });
  }
});

module.exports = router;
