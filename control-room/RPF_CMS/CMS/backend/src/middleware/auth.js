const jwt = require("jsonwebtoken");
const config = require("../config");
const { pool } = require("../db");
const { unauthorized, forbidden, wrap } = require("../errors");

// Who may use the CMS console. post_user is an RPF role and has no business here.
const CONSOLE_ROLES = ["operator", "zone_admin", "super_admin"];
const ISSUER = "cms-console";

const signToken = (user) =>
  jwt.sign({ sub: user.id }, config.jwtSecret, {
    expiresIn: `${config.sessionHours}h`,
    issuer: ISSUER,
  });
const verifyToken = (t) => jwt.verify(t, config.jwtSecret, { issuer: ISSUER });

/** Loads the user fresh on every request so a disabled account loses access immediately. */
const requireAuth = wrap(async (req, res, next) => {
  const m = (req.get("authorization") || "").match(/^Bearer (.+)$/i);
  if (!m) throw unauthorized();
  let payload;
  try {
    payload = verifyToken(m[1]);
  } catch (_) {
    throw unauthorized("session expired or invalid");
  }
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.role, u.zone_id, u.status, z.name AS zone_name
       FROM users u LEFT JOIN zone z ON z.id = u.zone_id WHERE u.id = $1`,
    [payload.sub],
  );
  const u = rows[0];
  if (!u || u.status !== "active" || !CONSOLE_ROLES.includes(u.role))
    throw unauthorized("account not active");
  req.user = u;
  next();
});

const requireRole =
  (...roles) =>
  (req, res, next) =>
    roles.includes(req.user.role)
      ? next()
      : next(forbidden(`requires role: ${roles.join(" or ")}`));
const requireAdmin = requireRole("zone_admin", "super_admin");
const requireSuper = requireRole("super_admin");

/**
 * Zone scope. operator + zone_admin see their own zone only; super_admin sees all.
 * Returns an SQL fragment on `col` and pushes params. Optional `zoneFilter` narrows a super_admin's view.
 */
function zoneScope(user, col, params, zoneFilter) {
  const parts = [];
  if (user.role !== "super_admin") {
    params.push(user.zone_id);
    parts.push(`${col} = $${params.length}`);
  } else if (zoneFilter) {
    params.push(Number(zoneFilter));
    parts.push(`${col} = $${params.length}`);
  }
  return parts.length ? parts.join(" AND ") : "TRUE";
}
const canSeeZone = (user, zoneId) =>
  user.role === "super_admin" || Number(user.zone_id) === Number(zoneId);

/**
 * M-NVR authentication. In production mTLS terminates at the NVR gateway, which forwards the
 * verified client-certificate fingerprint; in development the unit sends X-NVR-Fingerprint itself.
 */
/** A unit that was removed from the fleet comes back: active again, its original name (made unique if taken), its footage history untouched. */
async function restoreRemoved(id) {
  const { rows } = await pool.query(
    `SELECT name FROM nvr_unit WHERE id = $1 AND status = 'removed'`,
    [id],
  );
  if (!rows[0]) return null;
  const base =
    rows[0].name.replace(/ \[removed #\d+\]$/, "").slice(0, 70) || "MNVR";
  let name = base;
  for (
    let n = 2;
    (
      await pool.query(
        "SELECT 1 FROM nvr_unit WHERE lower(name) = lower($1) AND id <> $2",
        [name, id],
      )
    ).rowCount;
    n++
  )
    name = `${base} (${n})`;
  const up = await pool.query(
    `UPDATE nvr_unit SET status = 'active', name = $2 WHERE id = $1 AND status = 'removed' RETURNING id, name, current_zone_id AS zone_id, status`,
    [id, name],
  );
  await pool.query(
    "UPDATE camera SET active = true WHERE nvr_id = $1 AND NOT EXISTS (SELECT 1 FROM camera x WHERE x.nvr_id = $1 AND x.active)",
    [id],
  ); // removed by an older version: all were switched off
  await pool.query(
    `UPDATE nvr_unit SET health = COALESCE(health, '{}'::jsonb) || '{"resync": true}'::jsonb WHERE id = $1`,
    [id],
  ); // the unit's next heartbeat tells it to report its cameras: the real list wins
  // its M-NVR number back, if nobody took it meanwhile (otherwise the next sync numbers it)
  try {
    await pool.query(
      `UPDATE nvr_unit SET unit_no = NULLIF(health->>'was_unit_no', '')::int WHERE id = $1 AND unit_no IS NULL AND health ? 'was_unit_no'`,
      [id],
    );
  } catch (_) {
    /* taken: renumbered by the sync */
  }
  if (up.rows[0])
    await require("../services/audit").audit(pool, {
      user: null,
      action: "nvr.restore",
      entity: "nvr_unit",
      entityId: id,
      zoneId: up.rows[0].zone_id,
      details: { name },
    });
  return up.rows[0] || null;
}
const requireNvr = wrap(async (req, res, next) => {
  const fp =
    req.get("x-client-cert-fingerprint") || req.get("x-nvr-fingerprint");
  if (!fp) throw unauthorized("NVR certificate fingerprint required");
  const { rows } = await pool.query(
    `SELECT id, name, current_zone_id AS zone_id, status, COALESCE((health->>'resync')::boolean, false) AS resync FROM nvr_unit WHERE cert_fingerprint = $1`,
    [fp],
  );
  let n = rows[0];
  if (!n) throw unauthorized("unknown NVR certificate");
  if (
    n.status === "removed" &&
    (await require("../services/settings").get("reenrol_removed_nvr"))
  )
    n = { ...((await restoreRemoved(n.id)) || n), resync: true };
  if (n.status !== "active") throw forbidden(`NVR is ${n.status}`);
  req.nvr = n;
  next();
});

module.exports = {
  signToken,
  requireAuth,
  requireRole,
  requireAdmin,
  requireSuper,
  zoneScope,
  canSeeZone,
  requireNvr,
  restoreRemoved,
  CONSOLE_ROLES,
};
