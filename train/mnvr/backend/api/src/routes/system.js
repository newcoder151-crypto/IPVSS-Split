/**
 * System routes — host-level info for the "System Info" nav item, and
 * admin-only power actions (Reboot / Shutdown) for the Settings menu.
 *
 * Power actions require the Node process to be able to run `shutdown`
 * without a password prompt (e.g. a sudoers rule scoped to exactly
 * `/sbin/shutdown` for the service account). If that's not configured,
 * the command will fail and the error is logged — the API still returns
 * 200 immediately because the OS may tear down the connection before a
 * failure would otherwise be reported back.
 */
const express = require("express");
const os = require("os");
const { exec } = require("child_process");
const { authenticate, requireRole } = require("../middleware/auth");

const router = express.Router();

// GET /api/system/info — live host info for the System Info page
router.get("/info", authenticate, (req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    node_version: process.version,
    uptime_seconds: os.uptime(),
    process_uptime_seconds: Math.floor(process.uptime()),
    cpu_model: os.cpus()[0]?.model || "Unknown",
    cpu_count: os.cpus().length,
    load_avg: os.loadavg(),
    total_mem_bytes: totalMem,
    free_mem_bytes: freeMem,
    used_mem_bytes: totalMem - freeMem,
  });
});

function runPowerCommand(res, label, command) {
  res.json({ message: `${label} initiated` });
  exec(command, (err) => {
    if (err) {
      console.error(`[system:${label.toLowerCase()}]`, err.message);
    }
  });
}

// POST /api/system/reboot — ADMIN only
router.post("/reboot", authenticate, requireRole("ADMIN"), (req, res) => {
  runPowerCommand(res, "Reboot", "sudo shutdown -r now");
});

// POST /api/system/shutdown — ADMIN only
router.post("/shutdown", authenticate, requireRole("ADMIN"), (req, res) => {
  runPowerCommand(res, "Shutdown", "sudo shutdown -h now");
});

module.exports = router;
