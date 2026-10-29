/**
 * CMS footage requests, as seen from the train. The mNVR-CMS bridge (bridge/) fetches the footage CMS asked for and
 * keeps live progress; this route just relays it to the console.  GET /api/cms-requests  (any signed-in user)
 */
const express = require("express");
const { authenticate } = require("../middleware/auth");

const router = express.Router();
const BRIDGE = process.env.BRIDGE_STATUS_URL || `http://127.0.0.1:${process.env.BRIDGE_STATUS_PORT || 8095}`;

router.get("/", authenticate, async (req, res) => {
  try {
    const r = await fetch(`${BRIDGE}/transfers`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`bridge answered ${r.status}`);
    res.json({ bridge_running: true, ...(await r.json()) });
  } catch (_) {
    // the bridge is optional: the console must keep working without it
    res.json({ bridge_running: false, online: false, last_ok: null, transfers: [] });
  }
});

module.exports = router;
