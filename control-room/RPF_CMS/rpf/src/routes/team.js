const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { audit } = require('../services/audit');
const { badRequest, conflict, notFound, wrap } = require('../errors');

const router = express.Router();

const checkPassword = (pw, username) => {
  if (typeof pw !== 'string' || pw.length < 8) throw badRequest('the password must be at least 8 characters');
  if (pw.toLowerCase() === String(username).toLowerCase()) throw badRequest('the password must not be the username');
};

/** The post's officers. */
router.get('/', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, username, status, created_at FROM users WHERE post_id = $1 AND role = 'post_user' ORDER BY username`, [req.user.post_id]);
  res.json({ officers: rows.map((o) => ({ ...o, you: o.id === req.user.id })) });
}));

/** Add an officer to this post: username + a starting password (they can change it under Account). */
router.post('/', wrap(async (req, res) => {
  const username = String((req.body || {}).username || '').trim().toLowerCase().replace(/\s+/g, '.');
  const password = (req.body || {}).password;
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw badRequest('username: 3-40 characters using letters, digits, dot, dash or underscore (spaces become dots)');
  checkPassword(password, username);
  const { rows: post } = await pool.query('SELECT zone_id FROM rpf_post WHERE id = $1', [req.user.post_id]);
  let user;
  try {
    user = (await pool.query(`INSERT INTO users (zone_id, post_id, role, username, password_hash) VALUES ($1, $2, 'post_user', $3, $4) RETURNING id, username`,
      [post[0].zone_id, req.user.post_id, username, await bcrypt.hash(password, 12)])).rows[0];
  } catch (e) { if (e.code === '23505') throw conflict('that username is already taken'); throw e; }
  await audit(null, { user: req.user, action: 'team.officer.added', entity: 'users', entityId: user.id, details: { username } });
  res.status(201).json({ ok: true, username });
}));

async function colleague(req) {
  const { rows } = await pool.query(`SELECT id, username FROM users WHERE id = $1 AND post_id = $2 AND role = 'post_user'`, [Number(req.params.id), req.user.post_id]);
  if (!rows[0]) throw notFound('officer not found');
  if (rows[0].id === req.user.id) throw badRequest('use Account (top right) for your own password');
  return rows[0];
}

/** Set a new password for a colleague who is locked out. */
router.post('/:id/reset-password', wrap(async (req, res) => {
  const o = await colleague(req);
  checkPassword((req.body || {}).password, o.username);
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [o.id, await bcrypt.hash(req.body.password, 12)]);
  await audit(null, { user: req.user, action: 'team.password.reset', entity: 'users', entityId: o.id });
  res.json({ ok: true });
}));

router.post('/:id/status', wrap(async (req, res) => {
  const o = await colleague(req);
  const status = req.body && req.body.status;
  if (!['active', 'disabled'].includes(status)) throw badRequest("status must be 'active' or 'disabled'");
  await pool.query('UPDATE users SET status = $2 WHERE id = $1', [o.id, status]);
  await audit(null, { user: req.user, action: `team.officer.${status}`, entity: 'users', entityId: o.id });
  res.json({ ok: true });
}));

module.exports = router;
