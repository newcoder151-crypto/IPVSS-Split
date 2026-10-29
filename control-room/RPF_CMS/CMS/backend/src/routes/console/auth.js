const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../../db');
const config = require('../../config');
const { signToken, requireAuth, CONSOLE_ROLES } = require('../../middleware/auth');
const { audit } = require('../../services/audit');
const { badRequest, unauthorized, forbidden, HttpError, wrap } = require('../../errors');

const router = express.Router();
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000; const MAX_FAILS = 10;
const tooMany = (k) => { const now = Date.now(); const l = (attempts.get(k) || []).filter((t) => now - t < WINDOW_MS); attempts.set(k, l); return l.length >= MAX_FAILS; };
const recordFail = (k) => attempts.set(k, [...(attempts.get(k) || []), Date.now()]);

router.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) throw badRequest('username and password are required');
  const key = `${req.ip}|${username.toLowerCase()}`;
  if (tooMany(key)) throw new HttpError(429, 'too many failed attempts, try again later');
  const { rows } = await pool.query(`SELECT id, username, role, zone_id, status, password_hash FROM users WHERE username = $1`, [username]);
  const u = rows[0];
  const ok = await bcrypt.compare(password, u ? u.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
  if (!u || !ok || u.status !== 'active') { recordFail(key); throw unauthorized('invalid username or password'); }
  if (!CONSOLE_ROLES.includes(u.role)) throw forbidden('RPF post accounts sign in to the RPF dashboard, not the CMS console');
  attempts.delete(key);
  await audit(null, { user: u, action: 'console.login', entity: 'users', entityId: u.id });
  res.json({ token: signToken(u) });
}));

router.get('/me', requireAuth, (req, res) => {
  const { id, username, role, zone_id, zone_name } = req.user;
  res.json({ id, username, role, zone_id, zone_name, dev_tools: config.devTools, version: config.version });
});

router.post('/password', requireAuth, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (typeof next !== 'string' || next.length < 8) throw badRequest('the new password must be at least 8 characters');
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(String(current || ''), rows[0].password_hash))) throw unauthorized('current password is wrong');
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await bcrypt.hash(next, 10)]);
  await audit(null, { user: req.user, action: 'console.password', entity: 'users', entityId: req.user.id });
  res.json({ ok: true });
}));

module.exports = router;
