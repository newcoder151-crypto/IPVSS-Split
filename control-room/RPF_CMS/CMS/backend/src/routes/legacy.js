/**
 * The original v0.1 endpoints, kept so existing scripts (seed_demo_data.sh, curl) keep working.
 * Unauthenticated: development only. Disabled in production (LEGACY_API=0 or NODE_ENV=production).
 */
const express = require('express');
const { pool } = require('../db');
const { ingestAlert } = require('../services/alertService');
const { dispatchAlertToPost } = require('../services/incidentService');
const { findNearestPostForAlert } = require('../services/routing');
const { dismissAlert } = require('../services/alertService');
const { wrap } = require('../errors');

const alerts = express.Router();
alerts.post('/', wrap(async (req, res) => {
  const { nvr_id, alert_type, priority, lat, lon, event_time, camera_id } = req.body || {};
  if (!nvr_id) return res.status(400).json({ error: 'nvr_id, alert_type, priority, lat, lon are required' });
  const { rows } = await pool.query('SELECT id, name, current_zone_id AS zone_id FROM nvr_unit WHERE id = $1', [nvr_id]);
  if (!rows.length || rows[0].zone_id == null) return res.status(400).json({ error: `nvr_unit ${nvr_id} not found or has no current_zone_id set` });
  const r = await ingestAlert(rows[0], { nvr_event_id: `dummy-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, alert_type, priority, lat, lon, event_time, camera_id });
  res.status(201).json(r);
}));
alerts.get('/pending', wrap(async (req, res) => {
  const params = []; let w = `status = 'new'`;
  if (req.query.zone_id) { params.push(req.query.zone_id); w += ` AND zone_id = $1`; }
  res.json((await pool.query(`SELECT id, nvr_id, zone_id, alert_type, priority, event_time, received_time, routing_mode FROM alert WHERE ${w} ORDER BY received_time DESC`, params)).rows);
}));
alerts.post('/:id/promote', wrap(async (req, res) => {
  const { raised_by, post_id } = req.body || {};
  if (!raised_by) return res.status(400).json({ error: 'raised_by (operator user id) is required' });
  const id = Number(req.params.id);
  const postId = post_id || await findNearestPostForAlert(null, id);
  if (!postId) return res.status(400).json({ error: "no active post found in this alert's zone; supply post_id explicitly" });
  res.status(201).json(await dispatchAlertToPost({ alertId: id, postId, raisedByUserId: raised_by }));
}));
alerts.post('/:id/dismiss', wrap(async (req, res) => {
  try { await dismissAlert({ id: (await pool.query(`SELECT id FROM users WHERE username='system'`)).rows[0].id }, Number(req.params.id), 'dismissed via legacy API'); res.json({ id: Number(req.params.id), status: 'dismissed' }); }
  catch (e) { res.status(409).json({ error: e.message }); }
}));

const incidents = express.Router();
incidents.get('/', wrap(async (req, res) => {
  const params = []; const c = [];
  if (req.query.post_id) { params.push(req.query.post_id); c.push(`i.post_id = $${params.length}`); }
  if (req.query.status) { params.push(req.query.status); c.push(`i.status = $${params.length}`); }
  res.json((await pool.query(`SELECT i.id, i.post_id, i.alert_type, i.status, i.occurred_at, i.created_at, i.raised_by, u.username AS raised_by_username FROM incident i JOIN users u ON u.id = i.raised_by ${c.length ? 'WHERE ' + c.join(' AND ') : ''} ORDER BY i.created_at DESC`, params)).rows);
}));
incidents.get('/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT i.*, u.username AS raised_by_username FROM incident i JOIN users u ON u.id = i.raised_by WHERE i.id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: `incident ${req.params.id} not found` });
  res.json(rows[0]);
}));

module.exports = { alerts, incidents };
