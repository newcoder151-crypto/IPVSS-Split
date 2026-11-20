const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool } = require('../db');
const { unauthorized, wrap } = require('../errors');

function signToken(user) {
  const opts = { issuer: 'rpf-dashboard' };
  if (config.sessionHours > 0) opts.expiresIn = `${config.sessionHours}h`;   // 0 = never expires
  return jwt.sign({ sub: user.id }, config.jwtSecret, opts);
}

/**
 * Loads the officer fresh from the DB on every request (a disabled account loses access immediately) and checks the
 * account belongs to the post this dashboard is bound to.
 */
const requireAuth = wrap(async (req, res, next) => {
  const m = (req.get('authorization') || '').match(/^Bearer (.+)$/i);
  if (!m) throw unauthorized();
  let payload;
  try { payload = jwt.verify(m[1], config.jwtSecret, { issuer: 'rpf-dashboard' }); }
  catch (_) { throw unauthorized('session expired or invalid'); }

  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.role, u.zone_id, u.post_id, u.status, z.name AS zone_name, p.name AS post_name
       FROM users u LEFT JOIN zone z ON z.id = u.zone_id LEFT JOIN rpf_post p ON p.id = u.post_id
      WHERE u.id = $1`, [payload.sub]);
  const user = rows[0];
  if (!user || user.status !== 'active' || user.role !== 'post_user' || !user.post_id) throw unauthorized('account not active');
  // Sliding session: once half of the token's life is gone, hand the browser a fresh one (X-Renewed-Token), so an open dashboard never expires.
  if (payload.exp && payload.iat && payload.exp - Math.floor(Date.now() / 1000) < (payload.exp - payload.iat) / 2) res.set('X-Renewed-Token', signToken(user));
  req.user = user;   // one dashboard serves every post: what an officer sees is decided by THEIR post_id, in every query

  next();
});

module.exports = { requireAuth, signToken };
