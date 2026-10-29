const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { badRequest, unauthorized, forbidden, HttpError, wrap } = require('../errors');

const router = express.Router();

// Small in-memory brake on password guessing: 10 failures / 15 min per ip+username.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

function tooMany(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, list);
  return list.length >= MAX_FAILS;
}
const recordFail = (key) => attempts.set(key, [...(attempts.get(key) || []), Date.now()]);

router.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    throw badRequest('username and password are required');
  }
  const uname = username.trim().toLowerCase().replace(/\s+/g, '.'); // 'Anshika Sharma' signs in as anshika.sharma
  const key = `${req.ip}|${uname}`;
  if (tooMany(key)) throw new HttpError(429, 'too many failed attempts, try again later');

  const { rows } = await pool.query(
    `SELECT id, username, role, zone_id, post_id, status, password_hash FROM users WHERE lower(username) = $1`,
    [uname]
  );
  const u = rows[0];
  // Compare even when the user is missing so timing does not reveal which usernames exist.
  const ok = await bcrypt.compare(password, u ? u.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
  if (!u || !ok || u.status !== 'active') {
    recordFail(key);
    throw unauthorized('invalid username or password');
  }
  if (u.role !== 'post_user') throw forbidden('this account is not an RPF post login (CMS operators and admins use the CMS console)');
  // Any post's officer can sign in on this dashboard; they only ever see their own post's alerts, incidents, requests and footage.
  if (!u.post_id || !(await pool.query('SELECT 1 FROM rpf_post WHERE id = $1 AND active', [u.post_id])).rowCount) throw forbidden('this account has no active post');
  attempts.delete(key);
  await audit(null, { user: u, action: 'auth.login', entity: 'users', entityId: u.id });
  res.json({ token: signToken(u) });
}));

const checkNewPassword = (next, username) => {
  if (typeof next !== 'string' || next.length < 8) throw badRequest('the new password must be at least 8 characters');
  if (next.toLowerCase() === String(username).toLowerCase()) throw badRequest('the password must not be the username');
};

router.post('/password', requireAuth, wrap(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  checkNewPassword(new_password, req.user.username);
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(String(current_password || ''), rows[0].password_hash))) throw unauthorized('the current password is wrong');
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await bcrypt.hash(new_password, 12)]);
  await audit(null, { user: req.user, action: 'auth.password.changed', entity: 'users', entityId: req.user.id });
  res.json({ ok: true });
}));

router.get('/me', requireAuth, (req, res) => {
  const { id, username, zone_id, zone_name, post_id, post_name } = req.user;
  res.json({ id, username, zone_id, zone_name, post_id, post_name });
});

module.exports = router;
