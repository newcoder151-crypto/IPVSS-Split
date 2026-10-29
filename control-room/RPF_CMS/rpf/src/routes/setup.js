/**
 * Registration of a Thana / Post, offered on the login screen EVERY time (not only on the first run). Public (there is no
 * login yet). One dashboard serves every post. Once any officer exists, registering another post needs the username +
 * password of a current officer (authorizer_username / authorizer_password); only the very first registration is open.
 * Uses existing tables only: rpf_post (name, zone, location) and users.
 *   GET  /api/setup            -> { registered, post?, zones, officers }
 *   POST /api/setup/register   -> creates (or adopts) the post and its first officer login, binds this dashboard, signs in
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, withTransaction } = require('../db');
const { audit } = require('../services/audit');
const { signToken } = require('../middleware/auth');
const { badRequest, conflict, forbidden, HttpError, wrap } = require('../errors');

const router = express.Router();
const tries = new Map(); // ip -> timestamps; small brake on abuse
function brake(ip) {
  const now = Date.now(); const list = (tries.get(ip) || []).filter((t) => now - t < 3600e3);
  if (list.length >= 20) throw new HttpError(429, 'too many attempts, try again later');
  list.push(now); tries.set(ip, list);
}
let busy = false;

router.get('/', wrap(async (req, res) => {
  const { rows: zones } = await pool.query('SELECT id, name FROM zone ORDER BY name');
  const officers = Number((await pool.query(`SELECT count(*) FROM users WHERE role = 'post_user' AND status = 'active'`)).rows[0].count);
  // Nothing about any post is shown before sign-in: only whether anyone is registered (then registering another post needs an officer's confirmation).
  res.json({ registered: officers > 0, zones, officers });
}));

const str = (v) => (typeof v === 'string' ? v.trim() : '');

router.post('/register', wrap(async (req, res) => {
  brake(req.ip);
  const b = req.body || {};

  const name = str(b.post_name); const username = str(b.username).toLowerCase().replace(/\s+/g, '.'); const password = typeof b.password === 'string' ? b.password : '';
  const zoneId = Number(b.zone_id); const lat = Number(b.latitude); const lon = Number(b.longitude);
  if (name.length < 3 || name.length > 80) throw badRequest('Thana / Post name must be 3 to 80 characters');
  if (!Number.isInteger(zoneId)) throw badRequest('choose the zone this post belongs to');
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) throw badRequest('enter a valid latitude (-90 to 90) and longitude (-180 to 180)');
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw badRequest('username: 3-40 characters using letters, digits, dot, dash or underscore (spaces become dots) - e.g. anshika.sharma');
  if (password.length < 8) throw badRequest('password must be at least 8 characters');
  if (password.toLowerCase() === username) throw badRequest('password must not be the username');
  // A new post receives alerts (CMS routes by distance), so once any officer exists nobody may add a post on their own:
  // a current officer of ANY post must confirm with their own username and password. Only the very first registration is open.
  let authorizedBy = null;
  if (Number((await pool.query(`SELECT count(*) FROM users WHERE role = 'post_user' AND status = 'active'`)).rows[0].count) > 0) {
    const au = str(b.authorizer_username).toLowerCase().replace(/\s+/g, '.');
    const ap = typeof b.authorizer_password === 'string' ? b.authorizer_password : '';
    const { rows: ar } = await pool.query(`SELECT id, password_hash FROM users WHERE lower(username) = $1 AND role = 'post_user' AND status = 'active'`, [au]);
    const good = await bcrypt.compare(ap, ar[0] ? ar[0].password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    if (!ar[0] || !good) throw forbidden('to register another Thana / Post, confirm with the username and password of a current RPF officer');
    authorizedBy = ar[0].id;
  }
  if (busy) throw conflict('a registration is already in progress');
  busy = true;
  try {
    const hash = await bcrypt.hash(password, 12);
    const out = await withTransaction(async (client) => {
      const z = (await client.query('SELECT id, name FROM zone WHERE id = $1', [zoneId])).rows[0];
      if (!z) throw badRequest('that zone does not exist in CMS');
      // a post the CMS administrator already created (same zone + name) is adopted, but only if nobody has a login for it yet
      let post = (await client.query('SELECT id, name FROM rpf_post WHERE zone_id = $1 AND lower(name) = lower($2) AND active', [zoneId, name])).rows[0];
      if (post) {
        const has = (await client.query(`SELECT 1 FROM users WHERE post_id = $1 AND role = 'post_user'`, [post.id])).rowCount;
        if (has) throw conflict(`'${post.name}' is already registered and has an officer login - sign in from its own dashboard, or pick a different name`);
      } else {
        post = (await client.query(
          `INSERT INTO rpf_post (zone_id, name, location) VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography) RETURNING id, name`,
          [zoneId, name, lat, lon])).rows[0];
      }
      let user;
      try {
        user = (await client.query(
          `INSERT INTO users (zone_id, post_id, role, username, password_hash) VALUES ($1, $2, 'post_user', $3, $4) RETURNING id, username, role, zone_id, post_id`,
          [zoneId, post.id, username, hash])).rows[0];
      } catch (e) { if (e.code === '23505') throw conflict('that username is already taken'); throw e; }
      await audit(client, { user, action: 'post.register', entity: 'rpf_post', entityId: post.id, details: { name: post.name, zone: z.name, authorized_by_user: authorizedBy } });
      return { post, user };
    });
    res.status(201).json({ token: signToken(out.user), post: { name: out.post.name }, username: out.user.username });
  } finally { busy = false; }
}));

module.exports = router;
