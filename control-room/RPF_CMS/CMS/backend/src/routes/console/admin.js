const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool, withTransaction } = require('../../db');
const { zoneScope, canSeeZone, requireAdmin, requireSuper } = require('../../middleware/auth');
const settings = require('../../services/settings');
const jobs = require('../../services/jobs');
const { audit } = require('../../services/audit');
const { parseId, parseLimit, parseOffset, requireText, optText, num, where } = require('../../services/util');
const { badRequest, notFound, conflict, forbidden, wrap } = require('../../errors');


const router = express.Router();

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------
router.get('/zones', wrap(async (req, res) => {
  const p = [];
  const { rows } = await pool.query(
    `SELECT z.id, z.name, (SELECT COUNT(*) FROM rpf_post WHERE zone_id = z.id AND active) AS posts, (SELECT COUNT(*) FROM nvr_unit WHERE current_zone_id = z.id) AS nvrs,
            (SELECT COUNT(*) FROM users WHERE zone_id = z.id AND status = 'active') AS users
       FROM zone z WHERE ${req.user.role === 'super_admin' ? 'TRUE' : zoneScope(req.user, 'z.id', p)} ORDER BY z.name`, p);
  res.json(rows);
}));
router.post('/zones', requireSuper, wrap(async (req, res) => {
  const name = requireText(req.body && req.body.name, 'name', 80);
  const { rows } = await pool.query(`INSERT INTO zone (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id`, [name]);
  if (!rows.length) throw conflict(`zone '${name}' already exists`);
  await audit(null, { user: req.user, action: 'zone.create', entity: 'zone', entityId: rows[0].id, zoneId: rows[0].id, details: { name } });
  res.status(201).json({ id: rows[0].id });
}));

router.get('/posts', wrap(async (req, res) => {
  const w = where(); w.raw(zoneScope(req.user, 'p.zone_id', w.params, req.query.zone_id));
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.zone_id, z.name AS zone_name, p.active, ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lon,
            (SELECT COUNT(*) FROM users u WHERE u.post_id = p.id AND u.status = 'active') AS officers,
            (SELECT COUNT(*) FROM alert_delivery d JOIN alert a ON a.id = d.alert_id AND a.event_time = d.alert_event_time WHERE d.post_id = p.id AND d.ack_at IS NULL AND a.status IN ('routed','escalated')) AS unacked
       FROM rpf_post p JOIN zone z ON z.id = p.zone_id ${w.sql()} ORDER BY z.name, p.name`, w.params);
  res.json(rows);
}));
function parseLatLon(b) {
  return { lat: num(b.lat, 'lat', { min: -90, max: 90 }), lon: num(b.lon, 'lon', { min: -180, max: 180 }) };
}
router.post('/posts', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const zoneId = req.user.role === 'super_admin' ? parseId(b.zone_id, 'zone_id') : req.user.zone_id;
  const { lat, lon } = parseLatLon(b);
  const { rows } = await pool.query(`INSERT INTO rpf_post (zone_id, name, location) VALUES ($1,$2,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography) RETURNING id`, [zoneId, requireText(b.name, 'name', 80), lon, lat]);
  await audit(null, { user: req.user, action: 'post.create', entity: 'rpf_post', entityId: rows[0].id, zoneId, details: { name: b.name, lat, lon } });
  res.status(201).json({ id: rows[0].id });
}));
router.patch('/posts/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseId(req.params.id); const b = req.body || {};
  const { rows } = await pool.query('SELECT zone_id FROM rpf_post WHERE id = $1', [id]);
  if (!rows.length || !canSeeZone(req.user, rows[0].zone_id)) throw notFound('post not found');
  const sets = []; const params = [id];
  const add = (sql, v) => { params.push(v); sets.push(sql.replace('?', `$${params.length}`)); };
  if (b.name != null) add('name = ?', requireText(b.name, 'name', 80));
  if (b.active != null) add('active = ?', !!b.active);
  if (b.lat != null || b.lon != null) { const { lat, lon } = parseLatLon(b); params.push(lon, lat); sets.push(`location = ST_SetSRID(ST_MakePoint($${params.length - 1},$${params.length}),4326)::geography`); }
  if (!sets.length) throw badRequest('nothing to change');
  await pool.query(`UPDATE rpf_post SET ${sets.join(', ')} WHERE id = $1`, params);
  await audit(null, { user: req.user, action: 'post.update', entity: 'rpf_post', entityId: id, zoneId: rows[0].zone_id, details: b });
  res.json({ ok: true });
}));

router.post('/nvrs', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const zoneId = req.user.role === 'super_admin' ? parseId(b.zone_id, 'zone_id') : req.user.zone_id;
  const fp = requireText(b.cert_fingerprint, 'cert_fingerprint', 200);
  const cams = Math.min(16, Math.max(0, Number(b.cameras) || 0));
  const id = await withTransaction(async (client) => {
    const { rows } = await client.query(`INSERT INTO nvr_unit (name, cert_fingerprint, current_zone_id, train_no) VALUES ($1,$2,$3,$4) RETURNING id`,
      [requireText(b.name, 'name', 80), fp, zoneId, optText(b.train_no, 40)]).catch((e) => { if (e.code === '23505') throw conflict('that certificate fingerprint is already registered'); throw e; });
    await client.query(`INSERT INTO nvr_zone_assignment (nvr_id, zone_id, assigned_from) VALUES ($1,$2,now())`, [rows[0].id, zoneId]);
    for (let i = 1; i <= cams; i++) await client.query(`INSERT INTO camera (nvr_id, name) VALUES ($1,$2)`, [rows[0].id, `cam-${i}`]);
    await audit(client, { user: req.user, action: 'nvr.create', entity: 'nvr_unit', entityId: rows[0].id, zoneId, details: { name: b.name, cameras: cams } });
    return rows[0].id;
  });
  res.status(201).json({ id });
}));
router.patch('/nvrs/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseId(req.params.id); const b = req.body || {};
  const { rows } = await pool.query('SELECT current_zone_id FROM nvr_unit WHERE id = $1', [id]);
  if (!rows.length || !canSeeZone(req.user, rows[0].current_zone_id)) throw notFound('NVR not found');
  const sets = []; const params = [id];
  const add = (sql, v) => { params.push(v); sets.push(sql.replace('?', `$${params.length}`)); };
  if (b.name != null) add('name = ?', requireText(b.name, 'name', 80));
  if (b.train_no !== undefined) add('train_no = ?', optText(b.train_no, 40));
  if (b.status != null) { if (!['active', 'inactive', 'suspended'].includes(b.status)) throw badRequest('invalid status'); add('status = ?::nvr_status', b.status); }
  if (!sets.length) throw badRequest('nothing to change');
  await pool.query(`UPDATE nvr_unit SET ${sets.join(', ')} WHERE id = $1`, params);
  await audit(null, { user: req.user, action: 'nvr.update', entity: 'nvr_unit', entityId: id, zoneId: rows[0].current_zone_id, details: b });
  res.json({ ok: true });
}));
/** Zone handover (Cl. 0 / section 5.5): closes the open assignment, opens a new one, so footage stays attributable. */
router.post('/nvrs/:id/assign-zone', requireSuper, wrap(async (req, res) => {
  const id = parseId(req.params.id); const zoneId = parseId(req.body && req.body.zone_id, 'zone_id');
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT current_zone_id FROM nvr_unit WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) throw notFound('NVR not found');
    if (Number(rows[0].current_zone_id) === zoneId) throw conflict('the unit is already in that zone');
    await client.query(`UPDATE nvr_zone_assignment SET assigned_until = now() WHERE nvr_id = $1 AND assigned_until IS NULL`, [id]);
    await client.query(`INSERT INTO nvr_zone_assignment (nvr_id, zone_id, assigned_from) VALUES ($1,$2,now())`, [id, zoneId]);
    await client.query(`UPDATE nvr_unit SET current_zone_id = $2 WHERE id = $1`, [id, zoneId]);
    await audit(client, { user: req.user, action: 'nvr.handover', entity: 'nvr_unit', entityId: id, zoneId, details: { from: rows[0].current_zone_id, to: zoneId } });
  });
  res.json({ ok: true });
}));
router.post('/nvrs/:id/cameras', requireAdmin, wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query('SELECT current_zone_id FROM nvr_unit WHERE id = $1', [id]);
  if (!rows.length || !canSeeZone(req.user, rows[0].current_zone_id)) throw notFound('NVR not found');
  const { rows: c } = await pool.query(`INSERT INTO camera (nvr_id, name, mount_position) VALUES ($1,$2,$3) RETURNING id`, [id, requireText(req.body && req.body.name, 'name', 60), optText(req.body && req.body.mount_position, 80)]);
  await audit(null, { user: req.user, action: 'camera.create', entity: 'camera', entityId: c[0].id, zoneId: rows[0].current_zone_id });
  res.status(201).json({ id: c[0].id });
}));
router.patch('/cameras/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseId(req.params.id); const b = req.body || {};
  const { rows } = await pool.query('SELECT n.current_zone_id FROM camera c JOIN nvr_unit n ON n.id = c.nvr_id WHERE c.id = $1', [id]);
  if (!rows.length || !canSeeZone(req.user, rows[0].current_zone_id)) throw notFound('camera not found');
  const sets = []; const params = [id];
  const add = (sql, v) => { params.push(v); sets.push(sql.replace('?', `$${params.length}`)); };
  if (b.name != null) add('name = ?', requireText(b.name, 'name', 60));
  if (b.mount_position !== undefined) add('mount_position = ?', optText(b.mount_position, 80));
  if (b.active != null) add('active = ?', !!b.active);
  if (!sets.length) throw badRequest('nothing to change');
  await pool.query(`UPDATE camera SET ${sets.join(', ')} WHERE id = $1`, params);
  await audit(null, { user: req.user, action: 'camera.update', entity: 'camera', entityId: id, zoneId: rows[0].current_zone_id, details: b });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------------------------
// Users (zone_admin manages operators and post officers of their own zone; super_admin everything)
// ---------------------------------------------------------------------------------------------
router.get('/users', requireAdmin, wrap(async (req, res) => {
  const w = where(); w.raw(`u.username <> 'system'`);
  if (req.user.role !== 'super_admin') w.add('(u.zone_id = ?)', req.user.zone_id);
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.role, u.status, u.zone_id, z.name AS zone_name, u.post_id, p.name AS post_name, u.created_at
       FROM users u LEFT JOIN zone z ON z.id = u.zone_id LEFT JOIN rpf_post p ON p.id = u.post_id ${w.sql()} ORDER BY u.role, u.username`, w.params);
  res.json(rows);
}));
const generatePassword = () => Array.from(crypto.randomBytes(14), (b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');
router.post('/users', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const role = b.role;
  const allowed = req.user.role === 'super_admin' ? ['super_admin', 'zone_admin', 'operator', 'post_user'] : ['operator', 'post_user'];
  if (!allowed.includes(role)) throw forbidden(`you may create: ${allowed.join(', ')}`);
  const username = requireText(b.username, 'username', 60);
  if (!/^[A-Za-z0-9._-]{3,60}$/.test(username)) throw badRequest('username: 3-60 letters, digits, dot, dash, underscore');
  const zoneId = role === 'super_admin' ? null : (req.user.role === 'super_admin' ? parseId(b.zone_id, 'zone_id') : req.user.zone_id);
  let postId = null;
  if (role === 'post_user') {
    postId = parseId(b.post_id, 'post_id');
    const { rows } = await pool.query('SELECT 1 FROM rpf_post WHERE id = $1 AND zone_id = $2', [postId, zoneId]);
    if (!rows.length) throw badRequest('that post is not in the chosen zone');
  }
  const password = b.password ? String(b.password) : generatePassword();
  if (password.length < 8) throw badRequest('password must be at least 8 characters');
  const { rows } = await pool.query(`INSERT INTO users (zone_id, post_id, role, username, password_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username) DO NOTHING RETURNING id`,
    [zoneId, postId, role, username, await bcrypt.hash(password, 10)]);
  if (!rows.length) throw conflict(`username '${username}' is taken`);
  await audit(null, { user: req.user, action: 'user.create', entity: 'users', entityId: rows[0].id, zoneId, details: { username, role, post_id: postId } });
  res.status(201).json({ id: rows[0].id, username, password: b.password ? undefined : password });
}));
async function managedUser(req) {
  const id = parseId(req.params.id);
  const { rows } = await pool.query('SELECT id, role, zone_id, username FROM users WHERE id = $1 AND username <> \'system\'', [id]);
  const u = rows[0];
  if (!u || (req.user.role !== 'super_admin' && (Number(u.zone_id) !== Number(req.user.zone_id) || ['zone_admin', 'super_admin'].includes(u.role)))) throw notFound('user not found');
  if (u.id === req.user.id) throw badRequest('use your own account page for that');
  return u;
}
router.post('/users/:id/reset-password', requireAdmin, wrap(async (req, res) => {
  const u = await managedUser(req); const pw = generatePassword();
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await bcrypt.hash(pw, 10)]);
  await audit(null, { user: req.user, action: 'user.password_reset', entity: 'users', entityId: u.id, zoneId: u.zone_id });
  res.json({ username: u.username, password: pw });
}));
router.post('/users/:id/status', requireAdmin, wrap(async (req, res) => {
  const u = await managedUser(req); const status = req.body && req.body.status;
  if (!['active', 'disabled'].includes(status)) throw badRequest("status must be 'active' or 'disabled'");
  await pool.query('UPDATE users SET status = $2 WHERE id = $1', [u.id, status]);
  await audit(null, { user: req.user, action: `user.${status === 'active' ? 'enable' : 'disable'}`, entity: 'users', entityId: u.id, zoneId: u.zone_id });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------------------------
// Settings, jobs, audit, notifications
// ---------------------------------------------------------------------------------------------
router.get('/settings', requireAdmin, wrap(async (req, res) => {
  const cur = await settings.all();
  res.json(Object.entries(settings.SCHEMA).map(([key, s]) => ({ key, ...s, value: cur[key] })));
}));
router.put('/settings', requireSuper, wrap(async (req, res) => {
  const changes = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    try { changes[k] = await settings.set(k, v, req.user.id); } catch (e) { throw badRequest(e.message); }
  }
  await audit(null, { user: req.user, action: 'settings.update', entity: 'setting', details: changes });
  res.json({ ok: true, changes });
}));

router.get('/jobs', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM job_status');
  const by = new Map(rows.map((r) => [r.name, r]));
  res.json(jobs.JOBS.map((j) => ({ name: j.name, label: j.label, every_s: j.every, ...(by.get(j.name) || { runs: 0 }) })));
}));
router.post('/jobs/:name/run', requireSuper, wrap(async (req, res) => {
  const j = jobs.JOBS.find((x) => x.name === req.params.name);
  if (!j) throw notFound('no such job');
  await jobs.runJob(j);
  await audit(null, { user: req.user, action: 'job.run', entity: 'job', details: { name: j.name } });
  res.json({ ok: true });
}));

function auditQuery(req) {
  const w = where();
  w.raw(req.user.role === 'super_admin' ? (req.query.zone_id ? (w.add('a.zone_id = ?', Number(req.query.zone_id)), 'TRUE') : 'TRUE') : zoneScope(req.user, 'a.zone_id', w.params));
  const q = req.query;
  if (q.action) w.add('a.action LIKE ?', `${String(q.action).replace(/[%_]/g, '')}%`);
  if (q.entity) w.add('a.entity = ?', String(q.entity));
  if (q.entity_id) w.add('a.entity_id = ?', Number(q.entity_id));
  if (q.actor) w.add('u.username = ?', String(q.actor));
  if (q.from) w.add('a.occurred_at >= ?', new Date(q.from));
  if (q.to) w.add('a.occurred_at <= ?', new Date(q.to));
  return w;
}
router.get('/audit', wrap(async (req, res) => {
  const w = auditQuery(req);
  const limit = parseLimit(req.query.limit, 100, 500); const offset = parseOffset(req.query.offset);
  const base = `FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ${w.sql()}`;
  const [rows, total] = await Promise.all([
    pool.query(`SELECT a.id, a.occurred_at, a.action, a.entity, a.entity_id, a.zone_id, a.details, u.username AS actor ${base} ORDER BY a.id DESC LIMIT ${limit} OFFSET ${offset}`, w.params),
    pool.query(`SELECT COUNT(*) AS n ${base}`, w.params)]);
  res.json({ rows: rows.rows, total: total.rows[0].n });
}));
router.get('/audit.csv', requireAdmin, wrap(async (req, res) => {
  const w = auditQuery(req);
  const { rows } = await pool.query(`SELECT a.id, a.occurred_at, u.username AS actor, a.action, a.entity, a.entity_id, a.zone_id, a.details FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ${w.sql()} ORDER BY a.id DESC LIMIT 20000`, w.params);
  const esc = (v) => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  await audit(null, { user: req.user, action: 'audit.export', entity: 'audit_log', details: { rows: rows.length } });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cms-audit.csv"' });
  res.send(['id,occurred_at,actor,action,entity,entity_id,zone_id,details', ...rows.map((r) => [r.id, r.occurred_at.toISOString(), r.actor, r.action, r.entity, r.entity_id, r.zone_id, r.details].map(esc).join(','))].join('\n'));
}));

router.get('/notifications', wrap(async (req, res) => {
  const w = where(); w.raw(req.user.role === 'super_admin' ? 'TRUE' : zoneScope(req.user, 'n.zone_id', w.params));
  const { rows } = await pool.query(`SELECT n.id, n.kind, n.title, n.body, n.created_at, n.read_at, p.name AS post_name FROM notification n LEFT JOIN rpf_post p ON p.id = n.post_id ${w.sql()} ORDER BY n.id DESC LIMIT ${parseLimit(req.query.limit, 50, 200)}`, w.params);
  res.json(rows);
}));

module.exports = router;
