require("dotenv").config();
const path = require("path");
const express = require("express");
const config = require("./config");
const { pool } = require("./db");
const { HttpError } = require("./errors");
const { describeFsError, storeStatus } = require("./services/fsutil");
const jobs = require("./services/jobs");
const live = require("./services/live");

function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  // CORS: open to the whole network (any origin / IP / host name). Access is still protected by login.
  app.use((req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": req.get("origin") || "*",
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    });
    if (req.method === "OPTIONS") {
      res.set({
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers":
          req.get("access-control-request-headers") || "*",
        "Access-Control-Max-Age": "600",
      });
      return res.sendStatus(204);
    }
    next();
  });

  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; media-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
    });
    next();
  });

  app.get("/health", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      const local =
        ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress,
        ) && !req.get("x-forwarded-for");
      const media = storeStatus();
      res.json({
        status: media.ok ? "ok" : "degraded",
        db: "reachable",
        version: "0.2.0",
        footage_store: media.ok ? "writable" : "PROBLEM",
        ...(local
          ? {
              media_root: config.mediaRoot,
              pid: process.pid,
              footage_store_detail: media,
            }
          : {}),
      });
    } catch (err) {
      res
        .status(503)
        .json({ status: "error", db: "unreachable", detail: err.message });
    }
  });

  app.use("/nvr/v1", require("./routes/nvr")); // M-NVR -> CMS
  app.use("/media", require("./routes/console/evidence").media); // token-authenticated footage / evidence
  app.use("/console/api", require("./routes/console")); // operator / admin console API

  if (config.legacyApi) {
    // original v0.1 endpoints (RPF demo scripts, curl)
    const legacy = require("./routes/legacy");
    app.use("/api/alerts", legacy.alerts);
    app.use("/api/incidents", legacy.incidents);
  }

  app.use(["/console/api", "/nvr", "/media"], (req, res) =>
    res.status(404).json({ error: "no such endpoint" }),
  );
  app.use(
    "/console",
    express.static(path.join(__dirname, "..", "public"), {
      etag: true,
      setHeaders: (res) => res.set("Cache-Control", "no-cache"),
    }),
  ); // always revalidate: a stale script must never hide new features
  app.get("/", (req, res) => res.redirect("/console/"));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError)
      return res.status(err.status).json({ error: err.message });
    if (err && err.type === "entity.parse.failed")
      return res.status(400).json({ error: "invalid JSON body" });
    if (err && err.type === "entity.too.large")
      return res.status(413).json({ error: "payload too large" });
    if (
      err &&
      ["22P02", "22007", "22008", "23503", "23505", "23514"].includes(err.code)
    ) {
      // say WHICH value / rule (the constraint, e.g. a footage file that is already filed), so the unit and the operator are not left guessing
      const what =
        {
          23505: "already exists",
          23503: "refers to something that does not exist",
          23514: "breaks a rule of the database",
        }[err.code] || "is not valid";
      console.warn(
        `${req.method} ${req.originalUrl}: database refused it (${err.code} ${err.constraint || err.column || ""}: ${err.detail || err.message})`,
      );
      return res
        .status(400)
        .json({
          error: `invalid value: ${what}${err.constraint ? ` [${err.constraint}]` : ""}${err.detail ? ` - ${String(err.detail).slice(0, 160)}` : ""}`,
        });
    }
    console.error(`${req.method} ${req.originalUrl}:`, err);
    const fsMsg = describeFsError(err);
    if (fsMsg)
      return res
        .status(["ENOSPC", "EDQUOT"].includes(err.code) ? 507 : 500)
        .json({ error: fsMsg });
    res.status(500).json({ error: "internal server error" });
  });
  return app;
}

/** Listen on PORT; if it is taken and PORT_AUTO is on (default in development), try the next ports. */
function listen(app) {
  return new Promise((resolve, reject) => {
    let port = config.port;
    const attempt = (left) => {
      const srv = app.listen(port);
      srv.once("error", (e) => {
        if (e.code === "EADDRINUSE" && left > 0) {
          console.warn(`port ${port} is busy - trying ${port + 1}`);
          port += 1;
          attempt(left - 1);
          return;
        }
        if (e.code === "EADDRINUSE") {
          return reject(
            new Error(
              `port ${config.port} is already in use (an old CMS backend, or another program).\n` +
                `  see what holds it:  ss -ltnp | grep ${config.port}\n  use another port:   PORT=7081 npm start      (or set PORT in .env)\n  or let it pick one: PORT_AUTO=1 npm start`,
            ),
          );
        }
        reject(e);
      });
      srv.once("listening", () => resolve({ server: srv, port }));
    };
    attempt(config.portAuto ? 20 : 0);
  });
}

async function main() {
  const unset = ["PORT", "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER"].filter(
    (k) => !process.env[k],
  );
  if (unset.length) {
    console.error(
      `${unset.join(", ")} not set. Hosts, ports and database names are kept in config/control-room.conf; start the service with  bash start.sh  (it passes them on), or set them in the environment.`,
    );
    process.exit(1);
  }
  if (config.ephemeralSecret)
    console.warn(
      "CMS_JWT_SECRET is not set: using a random secret, console sessions end when the server restarts.",
    );
  const { rows } = await pool
    .query(
      `SELECT to_regclass('public.nvr_command') AS t, to_regclass('public.zone') AS z`,
    )
    .catch((e) => {
      throw new Error(`database unreachable: ${e.message}`);
    });
  if (!rows[0].z)
    throw new Error("CMS schema not found - apply sql/schema.sql");
  if (!rows[0].t)
    throw new Error(
      "CMS migration missing - apply sql/migrations/002_workflow.sql",
    );
  const { server, port } = await listen(buildApp());
  console.log(`CMS backend listening on port ${port}  (console: /console/)`);
  // footage can only arrive if MEDIA_ROOT is writable and has room: say so loudly at start and whenever it changes, not only as "internal server error"
  let lastStore = null;
  const checkStore = () => {
    const s = storeStatus();
    const key = s.ok ? "ok" : s.error;
    if (key !== lastStore) {
      lastStore = key;
      if (s.ok)
        console.log(
          `footage store OK (${s.free_mb == null ? "?" : s.free_mb} MB free)`,
        );
      else
        console.error(
          `!!! ${s.error} - footage uploads from the trains WILL FAIL until this is fixed`,
        );
    }
  };
  checkStore();
  setInterval(checkStore, 60000).unref();
  console.log(`CMS footage store (MEDIA_ROOT): ${config.mediaRoot}`);
  jobs.start();
  live.start();
  // React to work the moment it appears (the interval ticks stay as a safety net).
  live.subscribe((e) => {
    if (e.t === "evidence_flag" && e.op === "INSERT") jobs.kick("archive");
    else if (e.t === "video_request" && e.op === "INSERT")
      jobs.kick("requests");
  });
  const bye = () => {
    jobs.stop();
    live.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}

if (require.main === module)
  main().catch((e) => {
    console.error("startup failed:", e.message);
    process.exit(1);
  });
module.exports = { buildApp };
