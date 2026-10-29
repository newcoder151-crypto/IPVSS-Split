require("dotenv").config();

// ── Crash safety net — MUST be first, before any other require ────────────
// We traced a real incident to a 3rd-party library (the `onvif` package's
// WS-Discovery `Discovery.probe()`) throwing via an EventEmitter 'error'
// event with no listener attached, which is a synchronous, process-fatal
// throw in Node by default — one stray UDP reply from an unrelated device
// on the LAN was enough to kill the entire backend, not just that request.
// We patched that specific emitter (see backend/api/src/services/onvifClient.js),
// but a 3rd-party networking library is not something we can fully audit
// for every other way it might throw outside of a normal request/response
// cycle. For a system that has to stay up (cameras, recording, alarms),
// "one misbehaving dependency takes the whole NVR offline" is worse than
// "log the bug and keep serving everything else" — so this is a deliberate,
// last-resort backstop, not a substitute for fixing root causes when found.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] backend kept running — this should only ever fire from a 3rd-party dependency bug (see onvifClient.js comment). If you see this repeatedly for something else, treat it as a real bug to fix, not just log:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] backend kept running:", reason);
});

// Fail fast on missing/weak secrets before anything else touches them.
const { isProduction } = require("./config/security");

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { setupWebSocket } = require("./websocket");
const { testConnection } = require("./db");

const app = express();
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT || "3001");
const STORAGE_PATH = process.env.STORAGE_PATH || "/storage";

// Trust exactly one reverse-proxy hop (nginx) so req.ip / express-rate-limit
// key on the real client IP instead of the proxy's, without blindly
// trusting an arbitrary chain of X-Forwarded-For values.
app.set("trust proxy", process.env.TRUST_PROXY_HOPS ? parseInt(process.env.TRUST_PROXY_HOPS) : 1);

// ── Security headers (OWASP A05: Security Misconfiguration) ───────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
    referrerPolicy: { policy: "no-referrer" },
  }),
);

// ── CORS: open to the whole network ──────────────────────────────────────────
// Any origin (any PC / IP / host name) may call this API from a browser. Access is still protected by login (JWT).
app.use(cors({ origin: true, credentials: true, maxAge: 600 }));

app.use(morgan(isProduction ? "combined" : "dev"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ── Global rate limiting (OWASP A04 — resource-consumption abuse) ─────────────
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.API_RATE_LIMIT || "300"),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, slow down" },
  }),
);

// ── Storage dirs ──────────────────────────────────────────────────────────────
const recPath = path.join(STORAGE_PATH, "recordings");
const hlsPath = path.join(STORAGE_PATH, "hls");
const searchThumbsPath = path.join(STORAGE_PATH, "search_thumbs");
[recPath, hlsPath, searchThumbsPath].forEach((p) => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", require("./routes/auth"));
app.use("/api/cameras", require("./routes/cameras"));
app.use("/api/recordings", require("./routes/recordings"));
app.use("/api/events", require("./routes/events"));
app.use("/api/users", require("./routes/users"));
app.use("/api/config", require("./routes/config"));
app.use("/api/streaming", require("./routes/streaming"));
app.use("/api/search/smart", require("./routes/smart-search"));
app.use("/api/ai", require("./routes/ai"));
app.use("/api/analytics", require("./routes/analytics"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/onvif", require("./routes/onvif"));
app.use("/api/mediamtx", require("./routes/mediamtx"));
app.use("/api/system", require("./routes/system"));
app.use("/api/cms-requests", require("./routes/cms-requests"));

// ── Health ────────────────────────────────────────────────────────────────────
// Deliberately minimal — no version/uptime/internal detail for unauthenticated
// callers (OWASP A05: avoid unnecessary information disclosure).
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// ── Error handler (OWASP A09: no internal detail leaked to clients) ───────────
app.use((err, req, res, _next) => {
  console.error("[ERROR]", err.stack || err.message);
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({
    error: isProduction && status === 500 ? "Internal server error" : err.message,
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
setupWebSocket(server);

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  const ok = await testConnection();
  if (!ok) {
    console.error("\n❌  Database connection failed.");
    console.error("    1. Ensure PostgreSQL is running");
    console.error("    2. Run:  bash start.sh --setup-db");
    console.error(
      "    3. Check backend/api/.env for DB_HOST, DB_NAME, DB_USER, DB_PASSWORD\n",
    );
    process.exit(1);
  }
  server.listen(PORT, () => {
    require("./services/streamAutoDiscovery").start();
    console.log(`\n🚂  Railway NVR API  →  http://localhost:${PORT}`);
    console.log(`🔌  WebSocket        →  ws://localhost:${PORT}/ws`);
    console.log(`💾  Storage          →  ${STORAGE_PATH}\n`);
  });
}

start();
module.exports = { app, server };
