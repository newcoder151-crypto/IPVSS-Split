const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool } = require('../db');
const { unauthorized, forbidden, wrap } = require('../errors');

// Who may use the CMS console. post_user is an RPF role and has no business here.
const CONSOLE_ROLES = ['operator', 'zone_admin', 'super_admin'];
const ISSUER = 'cms-console';

const signToken = (user) => jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: `${config.sessionHours}h`, issuer: ISSUER });
const verifyToken = (t) => jwt.verify(t, config.jwtSecret, { issuer: ISSUER });

/** Loads the user fresh on every request so a disabled account loses access immediately. */
const requireAuth = wrap(async (req, res, next) => {
  const m = (req.get('authorization') || '').match(/^Bearer (.+)$/i);
  if (!m) throw unauthorized();
  let payload;
  try { payload = verifyToken(m[1]); } catch (_) { throw unauthorized('session expired or invalid'); }
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.role, u.zone_id, u.status, z.name AS zone_name
       FROM users u LEFT JOIN zone z ON z.id = u.zone_id WHERE u.id = $1`, [payload.sub]);
  const u = rows[0];
  if (!u || u.status !== 'active' || !CONSOLE_ROLES.includes(u.role)) throw unauthorized('account not active');
  req.user = u;
  next();
});

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : next(forbidden(`requires role: ${roles.join(' or ')}`));
const requireAdmin = requireRole('zone_admin', 'super_admin');
const requireSuper = requireRole('super_admin');

/**
 * Zone scope. operator + zone_admin see their own zone only; super_admin sees all.
 * Returns an SQL fragment on `col` and pushes params. Optional `zoneFilter` narrows a super_admin's view.
 */
function zoneScope(user, col, params, zoneFilter) {
  const parts = [];
  if (user.role !== 'super_admin') { params.push(user.zone_id); parts.push(`${col} = $${params.length}`); }
  else if (zoneFilter) { params.push(Number(zoneFilter)); parts.push(`${col} = $${params.length}`); }
  return parts.length ? parts.join(' AND ') : 'TRUE';
}
const canSeeZone = (user, zoneId) => user.role === 'super_admin' || Number(user.zone_id) === Number(zoneId);

/**
 * M-NVR authentication. In production mTLS terminates at the NVR gateway, which forwards the
 * verified client-certificate fingerprint; in development the unit sends X-NVR-Fingerprint itself.
 */
const requireNvr = wrap(async (req, res, next) => {
  const fp = req.get('x-client-cert-fingerprint') || req.get('x-nvr-fingerprint');
  if (!fp) throw unauthorized('NVR certificate fingerprint required');
  const { rows } = await pool.query(
    `SELECT id, name, current_zone_id AS zone_id, status FROM nvr_unit WHERE cert_fingerprint = $1`, [fp]);
  const n = rows[0];
  if (!n) throw unauthorized('unknown NVR certificate');
  if (n.status !== 'active') throw forbidden(`NVR is ${n.status}`);
  req.nvr = n;
  next();
});

module.exports = { signToken, requireAuth, requireRole, requireAdmin, requireSuper, zoneScope, canSeeZone, requireNvr, CONSOLE_ROLES };
