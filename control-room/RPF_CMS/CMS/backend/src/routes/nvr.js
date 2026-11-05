/**
 * M-NVR -> CMS interface. Everything here is called BY the train unit:
 *   POST /heartbeat            position, health, GPS track  ->  returns waiting commands
 *   POST /alerts               alert with GPS + original event time (idempotent)
 *   POST /segments             announce a recorded segment (catalogue entry)
 *   PUT  /segments/:id/chunks/:n   upload a chunk (resumable)
 *   POST /segments/:id/complete    verify + store
 *   GET  /commands, POST /commands/:id/(ack|done|fail)
 * The unit authenticates with its certificate fingerprint (mTLS at the gateway in production).
 */
const express = require("express");
const { pool } = require("../db");
const { requireNvr } = require("../middleware/auth");
const { ingestAlert } = require("../services/alertService");
const seg = require("../services/segmentService");
const reqs = require("../services/requestService");
const { parseId } = require("../services/util");
const live = require("../services/live");
const { badRequest, notFound, conflict, wrap } = require("../errors");

const router = express.Router();
router.use(requireNvr);
router.use(
  wrap(async (req, res, next) => {
    // any contact counts as "seen"
    await pool.query(
      `UPDATE nvr_unit SET last_seen = now() WHERE id = $1 AND (last_seen IS NULL OR last_seen < now() - interval '3 seconds')`,
      [req.nvr.id],
    );
    next();
  }),
);

// Every command carries who it is for in the naming convention (train no., M-NVR no., camera no.), so the unit logs and
// labels its transfer the way the CMS will name the footage. A unit gets ALL its waiting commands at once - one per camera
// of a train request - the moment it connects.
async function waitingCommands(nvrId, markSent) {
  if (markSent)
    await pool.query(
      `UPDATE nvr_command SET status='sent', sent_at=now() WHERE nvr_id=$1 AND status='queued'`,
      [nvrId],
    );
  const { rows } = await pool.query(
    `SELECT m.id, m.kind, m.camera_id, m.window_start, m.window_end, m.request_id, m.train_request_id, m.status,
            n.train_no, COALESCE(n.unit_no, n.id) AS unit_no, COALESCE(c.mnvr_camera_id, c.id) AS camera_no, c.name AS camera_name, c.mnvr_camera_id
       FROM nvr_command m
       JOIN nvr_unit n ON n.id = m.nvr_id
       LEFT JOIN camera c ON c.id = m.camera_id
      WHERE m.nvr_id = $1 AND m.status IN ('queued','sent','acked') ORDER BY m.id LIMIT 200`,
    [nvrId],
  );
  return rows;
}

/** The unit asks who it is: its registered cameras and the server clock (to check clock drift). */
router.get(
  "/self",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.mount_position, COALESCE(c.mnvr_camera_id, c.id) AS camera_no, c.mnvr_camera_id FROM camera c WHERE c.nvr_id = $1 AND c.active ORDER BY 4`,
      [req.nvr.id],
    );
    const { rows: u } = await pool.query(
      `SELECT n.id, n.name, n.train_no, COALESCE(n.unit_no, n.id) AS unit_no FROM nvr_unit n WHERE n.id = $1`,
      [req.nvr.id],
    );
    const { rows: sib } =
      u[0] && u[0].train_no
        ? await pool.query(
            `SELECT COALESCE(unit_no, id) AS unit_no, name FROM nvr_unit WHERE lower(btrim(train_no)) = lower(btrim($1)) ORDER BY 1`,
            [u[0].train_no],
          )
        : { rows: [] };
    res.json({
      nvr: {
        id: req.nvr.id,
        name: req.nvr.name,
        zone_id: req.nvr.zone_id,
        train_no: u[0] && u[0].train_no,
        unit_no: u[0] && u[0].unit_no,
      },
      cameras: rows,
      units_of_train: sib,
      server_time: new Date().toISOString(),
    });
  }),
);

/**
 * POST /cameras/sync { cameras: [{ camera_id, name, location? }] } - the unit's cameras, read by its bridge straight from the
 * M-NVR database every time it connects. New cameras are added (numbered by the M-NVR's own camera id) and, for a train request
 * that is still open, get their own footage request. Cameras the M-NVR no longer reports are deactivated (never deleted).
 */
router.post(
  "/cameras/sync",
  wrap(async (req, res) => {
    // The unit also declares WHICH TRAIN it rides on (and its M-NVR number in it) over this same authenticated channel, so it never needs a
    // database link to the CMS just to take part in train requests. Applied first: a bad camera list must not lose the identity.
    const ib = req.body || {};
    const trainNo =
      typeof ib.train_no === "string" ? ib.train_no.trim().slice(0, 60) : "";
    const wantUnit =
      ib.unit_no == null || ib.unit_no === "" ? null : Number(ib.unit_no);
    if (
      wantUnit != null &&
      (!Number.isInteger(wantUnit) || wantUnit < 1 || wantUnit > 99)
    )
      throw badRequest("unit_no must be 1..99");
    if (trainNo || wantUnit != null) {
      try {
        if (wantUnit != null)
          await pool.query(
            `UPDATE nvr_unit SET train_no = COALESCE(NULLIF($3::text, ''), train_no), unit_no = $2::int WHERE id = $1 AND (unit_no IS DISTINCT FROM $2::int OR ($3::text <> '' AND train_no IS DISTINCT FROM $3::text))`,
            [req.nvr.id, wantUnit, trainNo],
          );
        else
          await pool.query(
            `UPDATE nvr_unit SET train_no = $2::text, unit_no = NULL WHERE id = $1 AND train_no IS DISTINCT FROM $2::text`,
            [req.nvr.id, trainNo],
          ); // a different train: re-numbered below
      } catch (e) {
        if (e.code === "23505")
          throw conflict(
            `M-NVR number ${wantUnit} is already used in train ${trainNo || "this train"} by another unit - give each M-NVR of a train its own number`,
          );
        throw e;
      }
    }
    const list = Array.isArray(req.body && req.body.cameras)
      ? req.body.cameras
      : null;
    if (!list || !list.length || list.length > 200)
      throw badRequest(
        "cameras: a list of 1..200 { camera_id, name } is required",
      );
    let added = 0;
    let updated = 0;
    for (const c of list) {
      const mid = Number(c.camera_id);
      const name =
        typeof c.name === "string" ? c.name.trim().slice(0, 120) : "";
      if (!Number.isInteger(mid) || mid < 1 || mid > 999 || !name)
        throw badRequest("every camera needs a camera_id (1..999) and a name");
      const { rows } = await pool.query(
        `SELECT id, mnvr_camera_id FROM camera WHERE nvr_id = $1 AND (mnvr_camera_id = $2::int OR (mnvr_camera_id IS NULL AND lower(name) = lower($3::text))) ORDER BY (mnvr_camera_id = $2::int) DESC NULLS LAST LIMIT 1`,
        [req.nvr.id, mid, name],
      );
      if (rows.length) {
        const r = await pool.query(
          `UPDATE camera SET mnvr_camera_id = $2::int, mount_position = COALESCE($3::text, mount_position) WHERE id = $1 AND (mnvr_camera_id IS DISTINCT FROM $2::int OR ($3::text IS NOT NULL AND mount_position IS DISTINCT FROM $3::text))`,
          [rows[0].id, mid, c.location || null],
        );
        updated += r.rowCount;
      } else {
        await pool.query(
          `INSERT INTO camera (nvr_id, name, mount_position, mnvr_camera_id) VALUES ($1,$2,$3,$4)`,
          [req.nvr.id, name, c.location || null, mid],
        );
        added++;
      }
    }
    // The M-NVR is the source of truth: a CMS camera it no longer reports (left over from an old registration or a demo seed) is switched
    // off, so it is never asked for footage again. Its past footage stays (it is only deactivated, never deleted); reported cameras come back on.
    const ids = list.map((c) => Number(c.camera_id));
    const off = await pool.query(
      `UPDATE camera SET active = false WHERE nvr_id = $1 AND active AND NOT (COALESCE(mnvr_camera_id, -1) = ANY($2::int[]))`,
      [req.nvr.id, ids],
    );
    await pool.query(
      `UPDATE camera SET active = true WHERE nvr_id = $1 AND NOT active AND mnvr_camera_id = ANY($2::int[])`,
      [req.nvr.id, ids],
    );
    // a unit of a train with no M-NVR number yet gets the next free one of that train
    await pool.query(
      `UPDATE nvr_unit SET unit_no = (SELECT COALESCE(MAX(x.unit_no), 0) + 1 FROM nvr_unit x WHERE lower(btrim(x.train_no)) = lower(btrim(nvr_unit.train_no)))
                     WHERE id = $1 AND unit_no IS NULL AND train_no IS NOT NULL AND btrim(train_no) <> ''`,
      [req.nvr.id],
    );
    const requested = added
      ? await require("../services/trainRequestService").addCamerasToOpen(
          req.nvr.id,
        )
      : 0;
    const { rows: me } = await pool.query(
      `SELECT train_no, unit_no FROM nvr_unit WHERE id = $1`,
      [req.nvr.id],
    );
    res.json({
      added,
      updated,
      deactivated: off.rowCount,
      requests_added: requested,
      train_no: me[0].train_no,
      unit_no: me[0].unit_no,
    });
  }),
);

router.post(
  "/heartbeat",
  wrap(async (req, res) => {
    const b = req.body || {};
    const sets = [];
    const params = [req.nvr.id];
    const add = (col, v, cast = "") => {
      params.push(v);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (
      Number.isFinite(Number(b.lat)) &&
      Number.isFinite(Number(b.lon)) &&
      b.lat != null
    ) {
      add("last_lat", Number(b.lat));
      add("last_lon", Number(b.lon));
    }
    if (b.speed_mps != null && Number.isFinite(Number(b.speed_mps)))
      add("last_speed_mps", Number(b.speed_mps));
    if (b.health && typeof b.health === "object")
      add("health", JSON.stringify(b.health), "::jsonb");
    if (typeof b.firmware === "string")
      add("firmware", b.firmware.slice(0, 60));
    await pool.query(
      `UPDATE nvr_unit SET last_seen = now()${sets.length ? ", " + sets.join(", ") : ""} WHERE id = $1`,
      params,
    );

    const pts = Array.isArray(b.gps)
      ? b.gps
          .slice(0, 500)
          .filter(
            (p) =>
              p &&
              Number.isFinite(Number(p.lat)) &&
              Number.isFinite(Number(p.lon)) &&
              !Number.isNaN(new Date(p.ts).getTime()),
          )
      : [];
    if (pts.length) {
      try {
        await pool.query(
          `INSERT INTO gps_point (nvr_id, ts, location, speed_mps, fix_quality)
         SELECT $1, t.ts, ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography, t.speed, $6
           FROM unnest($2::timestamptz[], $3::float8[], $4::float8[], $5::real[]) AS t(ts, lon, lat, speed)
         ON CONFLICT DO NOTHING`,
          [
            req.nvr.id,
            pts.map((p) => new Date(p.ts)),
            pts.map((p) => Number(p.lon)),
            pts.map((p) => Number(p.lat)),
            pts.map((p) => (p.speed_mps == null ? null : Number(p.speed_mps))),
            b.fix_quality || null,
          ],
        );
      } catch (e) {
        console.warn(`gps insert for ${req.nvr.name}: ${e.message}`);
      }
    }
    res.json({
      server_time: new Date().toISOString(),
      commands: await waitingCommands(req.nvr.id, true),
    });
  }),
);

router.post(
  "/alerts",
  wrap(async (req, res) => {
    const r = await ingestAlert(req.nvr, req.body || {});
    res.status(r.duplicate ? 200 : 201).json(r);
  }),
);

router.post(
  "/segments",
  wrap(async (req, res) =>
    res.status(201).json(await seg.registerSegment(req.nvr, req.body || {})),
  ),
);
router.get(
  "/segments/:id",
  wrap(async (req, res) => {
    const s = await seg.loadOwned(req.nvr, parseId(req.params.id));
    res.json({
      id: s.id,
      upload_status: s.upload_status,
      bytes_received: s.bytes_received,
      last_chunk_index: s.last_chunk_index,
      size_bytes: s.size_bytes,
    });
  }),
);
router.put(
  "/segments/:id/chunks/:index",
  express.raw({ type: "*/*", limit: "8mb" }),
  wrap(async (req, res) => {
    res.json(
      await seg.uploadChunk(
        req.nvr,
        parseId(req.params.id),
        Number(req.params.index),
        Buffer.isBuffer(req.body) ? req.body : null,
        req.get("x-chunk-sha256"),
      ),
    );
  }),
);
router.post(
  "/segments/:id/complete",
  wrap(async (req, res) =>
    res.json(await seg.completeSegment(req.nvr, parseId(req.params.id))),
  ),
);

/**
 * Long poll: returns as soon as a command is waiting for this unit (instantly if one already is), or [] after
 * `timeout` seconds. A unit with coverage keeps one of these open, so "upload now" reaches it in milliseconds
 * rather than at the next heartbeat.
 */
router.get(
  "/commands/wait",
  wrap(async (req, res) => {
    const timeout =
      Math.min(30, Math.max(1, Number(req.query.timeout) || 25)) * 1000;
    const first = await waitingCommands(req.nvr.id, true);
    if (first.length) return res.json(first);
    let done = false;
    let off;
    let timer;
    const finish = async () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off && off();
      try {
        res.json(await waitingCommands(req.nvr.id, true));
      } catch (e) {
        if (!res.headersSent)
          res.status(500).json({ error: "internal server error" });
      }
    };
    off = live.subscribe((e) => {
      if (
        e.t === "nvr_command" &&
        Number(e.n) === Number(req.nvr.id) &&
        e.op === "INSERT"
      )
        finish();
    });
    timer = setTimeout(finish, timeout);
    req.on("close", () => {
      done = true;
      clearTimeout(timer);
      off && off();
    });
  }),
);
router.get(
  "/commands",
  wrap(async (req, res) => res.json(await waitingCommands(req.nvr.id, true))),
);

async function loadCommand(req) {
  const { rows } = await pool.query(
    `SELECT id, request_id, status FROM nvr_command WHERE id = $1 AND nvr_id = $2`,
    [parseId(req.params.id), req.nvr.id],
  );
  if (!rows.length) throw notFound("command not found");
  return rows[0];
}
router.post(
  "/commands/:id/ack",
  wrap(async (req, res) => {
    const c = await loadCommand(req);
    await pool.query(
      `UPDATE nvr_command SET status='acked', acked_at=now() WHERE id=$1 AND status IN ('queued','sent')`,
      [c.id],
    );
    res.json({ ok: true });
  }),
);
router.post(
  "/commands/:id/done",
  wrap(async (req, res) => {
    const c = await loadCommand(req);
    const missing = Array.isArray(req.body && req.body.missing)
      ? req.body.missing.slice(0, 50)
      : [];
    await pool.query(
      `UPDATE nvr_command SET status='done', completed_at=now(), result=$2 WHERE id=$1 AND status IN ('queued','sent','acked')`,
      [c.id, JSON.stringify({ missing })],
    );
    if (c.request_id)
      await reqs
        .processRequest(c.request_id)
        .catch((e) => console.error(e.message));
    res.json({ ok: true });
  }),
);
router.post(
  "/commands/:id/fail",
  wrap(async (req, res) => {
    const c = await loadCommand(req);
    const error = String((req.body && req.body.error) || "unspecified").slice(
      0,
      300,
    );
    await pool.query(
      `UPDATE nvr_command SET status='failed', completed_at=now(), result=$2 WHERE id=$1 AND status IN ('queued','sent','acked')`,
      [c.id, JSON.stringify({ error })],
    );
    if (c.request_id)
      await reqs
        .processRequest(c.request_id)
        .catch((e) => console.error(e.message));
    res.json({ ok: true });
  }),
);

module.exports = router;
