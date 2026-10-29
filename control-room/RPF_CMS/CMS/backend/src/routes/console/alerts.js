const express = require('express');
const { pool, withTransaction } = require('../../db');
const { zoneScope, canSeeZone } = require('../../middleware/auth');
const { candidatePosts } = require('../../services/routing');
const { dispatchAlert } = require('../../services/incidentService');
const { dismissAlert } = require('../../services/alertService');
const { audit } = require('../../services/audit');
const notify = require('../../services/notify');
const { parseId, parseLimit, parseOffset, requireText, optText, where, whenFilter, searchFilter } = require('../../services/util');
const { badRequest, notFound, conflict, wrap } = require('../../errors');

const router = express.Router();

const ALERT_LIST = `
  SELECT a.id, a.event_time, a.received_time, a.alert_type, a.priority, a.status, a.routing_mode, a.zone_id, z.name AS zone_name,
         a.nvr_id, n.name AS nvr_name, n.train_no, a.camera_id, c.name AS camera_name,
         ST_Y(a.location::geometry) AS lat, ST_X(a.location::geometry) AS lon, a.fix_quality, a.fix_age_s,
         a.assigned_post_id, po.name AS post_name,
         (SELECT MIN(d.ack_at) FROM alert_delivery d WHERE d.alert_id = a.id AND d.alert_event_time = a.event_time) AS ack_at,
         (SELECT COUNT(*) FROM alert_delivery d WHERE d.alert_id = a.id AND d.alert_event_time = a.event_time) AS deliveries,
         (SELECT i.id FROM incident i JOIN alert_delivery d ON d.id = i.alert_delivery_id WHERE d.alert_id = a.id AND d.alert_event_time = a.event_time ORDER BY i.id LIMIT 1) AS incident_id
    FROM alert a
    JOIN zone z ON z.id = a.zone_id
    JOIN nvr_unit n ON n.id = a.nvr_id
    LEFT JOIN camera c ON c.id = a.camera_id
    LEFT JOIN rpf_post po ON po.id = a.assigned_post_id`;

/** GET /alerts?status=&queue=1&priority_min=&type=&nvr_id=&from=&to=&limit=&offset= */
router.get('/alerts', wrap(async (req, res) => {
  const w = where();
  w.raw(zoneScope(req.user, 'a.zone_id', w.params, req.query.zone_id));
  const q = req.query;
  if (q.queue === '1') w.raw(`a.status = 'new'`);
  else if (q.status) w.add('a.status = ?::alert_status', q.status);
  if (q.priority_min) w.add('a.priority >= ?', Number(q.priority_min));
  if (q.priority_max) w.add('a.priority <= ?', Number(q.priority_max));
  if (q.type) w.add('a.alert_type = ?', String(q.type));
  if (q.nvr_id) w.add('a.nvr_id = ?', Number(q.nvr_id));
  if (q.post_id) w.add('a.assigned_post_id = ?', Number(q.post_id));
  if (q.from) w.add('a.event_time >= ?', new Date(q.from));
  if (q.to) w.add('a.event_time <= ?', new Date(q.to));
  whenFilter(w, q.when, 'a.event_time');
  searchFilter(w, q.q, ['a.alert_type', 'n.name', 'n.train_no', 'c.name', 'po.name', 'a.id']);
  if (q.mode) w.add('a.routing_mode = ?', String(q.mode));
  const ALERT_SORT = { new: 'a.event_time DESC, a.id DESC', old: 'a.event_time ASC, a.id ASC', prio: 'a.priority DESC, a.event_time DESC',
    status: "(CASE a.status WHEN 'escalated' THEN 0 WHEN 'new' THEN 1 WHEN 'routed' THEN 2 ELSE 3 END), a.event_time DESC" };
  const limit = parseLimit(q.limit, 50, 200); const offset = parseOffset(q.offset);
  const [rows, total] = await Promise.all([
    pool.query(`${ALERT_LIST} ${w.sql()} ORDER BY ${ALERT_SORT[q.sort] || ALERT_SORT.new} LIMIT ${limit} OFFSET ${offset}`, w.params),
    pool.query(`SELECT COUNT(*) AS n FROM alert a JOIN nvr_unit n ON n.id = a.nvr_id LEFT JOIN camera c ON c.id = a.camera_id LEFT JOIN rpf_post po ON po.id = a.assigned_post_id ${w.sql()}`, w.params),
  ]);
  res.json({ rows: rows.rows, total: total.rows[0].n });
}));

router.get('/alerts/types', wrap(async (req, res) => {
  const p = [];
  const { rows } = await pool.query(`SELECT DISTINCT alert_type FROM alert a WHERE ${zoneScope(req.user, 'a.zone_id', p)} AND a.event_time > now() - interval '60 days' ORDER BY 1`, p);
  res.json(rows.map((r) => r.alert_type));
}));

async function loadAlert(user, id) {
  const { rows } = await pool.query(`${ALERT_LIST} WHERE a.id = $1`, [id]);
  const a = rows[0];
  if (!a || !canSeeZone(user, a.zone_id)) throw notFound('alert not found');
  return a;
}

router.get('/alerts/:id', wrap(async (req, res) => {
  const a = await loadAlert(req.user, parseId(req.params.id));
  const [history, deliveries, incidents, requests, nearest, nvrState] = await Promise.all([
    pool.query(`SELECT h.changed_at, h.from_status, h.to_status, h.note, u.username AS changed_by_username
                  FROM alert_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.alert_id = $1 AND h.alert_event_time = $2 ORDER BY h.id`, [a.id, a.event_time]),
    pool.query(`SELECT d.id, d.post_id, po.name AS post_name, d.sent_at, d.ack_at, ua.username AS ack_by_username, d.mode, d.escalated_from, uf.username AS forwarded_by_username
                  FROM alert_delivery d JOIN rpf_post po ON po.id = d.post_id LEFT JOIN users ua ON ua.id = d.ack_by LEFT JOIN users uf ON uf.id = d.forwarded_by
                 WHERE d.alert_id = $1 AND d.alert_event_time = $2 ORDER BY d.id`, [a.id, a.event_time]),
    pool.query(`SELECT i.id, i.status, i.source, i.title, i.created_at, po.name AS post_name FROM incident i JOIN alert_delivery d ON d.id = i.alert_delivery_id JOIN rpf_post po ON po.id = i.post_id
                 WHERE d.alert_id = $1 AND d.alert_event_time = $2 ORDER BY i.id`, [a.id, a.event_time]),
    pool.query(`SELECT r.id, r.status, r.window_start, r.window_end, po.name AS post_name FROM video_request r JOIN rpf_post po ON po.id = r.post_id WHERE r.alert_id = $1 ORDER BY r.id DESC`, [a.id]),
    candidatePosts(null, a.id, { limit: 6 }),
    pool.query(`SELECT last_seen, health FROM nvr_unit WHERE id = $1`, [a.nvr_id]),
  ]);
  res.json({ alert: a, history: history.rows, deliveries: deliveries.rows, incidents: incidents.rows, requests: requests.rows, candidates: nearest, nvr: nvrState.rows[0] });
}));

// ---- operator actions on a queued alert ------------------------------------------------------
async function resolvePost(user, a, postId) {
  if (postId) return parseId(postId, 'post_id');
  const c = await candidatePosts(null, a.id, { limit: 1 });
  if (!c.length) throw badRequest('no active post exists in this alert\'s zone - add one in Registry first');
  return c[0].id;
}
const WAITING = ['new', 'escalated'];

/** Forward: the alert reaches the post's inbox; the officer decides whether to raise an incident. */
router.post('/alerts/:id/forward', wrap(async (req, res) => {
  const a = await loadAlert(req.user, parseId(req.params.id));
  const r = await dispatchAlert({ alertId: a.id, postId: await resolvePost(req.user, a, req.body && req.body.post_id), user: req.user, mode: 'operator', incident: false,
    allowedStatuses: WAITING, note: optText(req.body && req.body.note) || undefined });
  res.status(201).json(r);
}));
/** Promote: forward AND raise the incident (the operator judged it serious). */
router.post('/alerts/:id/promote', wrap(async (req, res) => {
  const a = await loadAlert(req.user, parseId(req.params.id));
  const r = await dispatchAlert({ alertId: a.id, postId: await resolvePost(req.user, a, req.body && req.body.post_id), user: req.user, mode: 'operator', incident: true,
    allowedStatuses: WAITING, note: optText(req.body && req.body.note) || undefined });
  res.status(201).json(r);
}));
router.post('/alerts/:id/dismiss', wrap(async (req, res) => {
  const a = await loadAlert(req.user, parseId(req.params.id));
  await dismissAlert(req.user, a.id, requireText(req.body && req.body.reason, 'reason', 500));
  res.json({ ok: true });
}));
router.post('/alerts/dismiss-bulk', wrap(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 100) : [];
  const reason = requireText(req.body && req.body.reason, 'reason', 500);
  if (!ids.length) throw badRequest('ids is required');
  let done = 0; const failed = [];
  for (const id of ids) {
    try { const a = await loadAlert(req.user, id); await dismissAlert(req.user, a.id, reason); done++; } catch (e) { failed.push({ id, error: e.message }); }
  }
  res.json({ dismissed: done, failed });
}));

// ---- incidents ------------------------------------------------------------------------------------
const INCIDENT_LIST = `
  SELECT i.id, i.status, i.source, i.title, i.alert_type, i.priority, i.occurred_at, i.created_at, i.updated_at, i.closed_at,
         i.post_id, po.name AS post_name, po.zone_id, i.raised_by, ur.username AS raised_by_username,
         i.nvr_id, n.name AS nvr_name, n.train_no, i.camera_id, c.name AS camera_name,
         ST_Y(i.location::geometry) AS lat, ST_X(i.location::geometry) AS lon, i.alert_delivery_id,
         (SELECT COUNT(*) FROM video_request r WHERE r.incident_id = i.id OR (i.alert_delivery_id IS NOT NULL AND r.alert_id = (SELECT alert_id FROM alert_delivery WHERE id = i.alert_delivery_id) AND r.post_id = i.post_id)) AS requests,
         (SELECT COUNT(*) FROM evidence_flag e WHERE e.incident_id = i.id AND e.status = 'active') AS flags
    FROM incident i
    JOIN rpf_post po ON po.id = i.post_id
    JOIN users ur ON ur.id = i.raised_by
    LEFT JOIN nvr_unit n ON n.id = i.nvr_id
    LEFT JOIN camera c ON c.id = i.camera_id`;

router.get('/incidents', wrap(async (req, res) => {
  const w = where();
  w.raw(zoneScope(req.user, 'po.zone_id', w.params, req.query.zone_id));
  const q = req.query;
  if (q.status === 'active') w.raw(`i.status <> 'closed'`); else if (q.status) w.add('i.status = ?', q.status);
  if (q.source) w.add('i.source = ?', q.source);
  if (q.post_id) w.add('i.post_id = ?', Number(q.post_id));
  if (q.from) w.add('i.created_at >= ?', new Date(q.from));
  if (q.to) w.add('i.created_at <= ?', new Date(q.to));
  whenFilter(w, q.when, 'i.created_at');
  searchFilter(w, q.q, ['i.title', 'i.alert_type', 'n.name', 'n.train_no', 'c.name', 'po.name', 'i.id']);
  if (q.prio === 'high') w.raw('i.priority >= 7'); else if (q.prio === 'low') w.raw('i.priority < 7');
  const INC_SORT = { new: 'i.id DESC', old: 'i.id ASC', prio: 'i.priority DESC NULLS LAST, i.id DESC', upd: 'i.updated_at DESC' };
  const limit = parseLimit(q.limit, 50, 200); const offset = parseOffset(q.offset);
  const [rows, total] = await Promise.all([
    pool.query(`${INCIDENT_LIST} ${w.sql()} ORDER BY ${INC_SORT[q.sort] || INC_SORT.new} LIMIT ${limit} OFFSET ${offset}`, w.params),
    pool.query(`SELECT COUNT(*) AS n FROM incident i JOIN rpf_post po ON po.id = i.post_id LEFT JOIN nvr_unit n ON n.id = i.nvr_id LEFT JOIN camera c ON c.id = i.camera_id ${w.sql()}`, w.params),
  ]);
  res.json({ rows: rows.rows, total: total.rows[0].n });
}));

router.get('/incidents/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query(`${INCIDENT_LIST} WHERE i.id = $1`, [id]);
  const i = rows[0];
  if (!i || !canSeeZone(req.user, i.zone_id)) throw notFound('incident not found');
  const { rows: det } = await pool.query(`SELECT description, closing_note FROM incident WHERE id = $1`, [id]);
  const [reqs, flags, notes, alert] = await Promise.all([
    pool.query(`SELECT r.id, r.status, r.window_start, r.window_end, r.reason, c.name AS camera_name,
                       (SELECT id FROM delivered_footage f WHERE f.video_request_id = r.id ORDER BY id DESC LIMIT 1) AS footage_id
                  FROM video_request r JOIN camera c ON c.id = r.camera_id
                 WHERE r.incident_id = $1 OR (r.post_id = $2 AND r.alert_id IS NOT NULL AND r.alert_id = (SELECT alert_id FROM alert_delivery WHERE id = $3)) ORDER BY r.id DESC`, [id, i.post_id, i.alert_delivery_id]),
    pool.query(`SELECT e.id, e.retention, e.status, e.archive_status, e.section_start_s, e.section_end_s, e.justification FROM evidence_flag e WHERE e.incident_id = $1 ORDER BY e.id DESC`, [id]),
    pool.query(`SELECT a.occurred_at, a.action, a.details, u.username AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
                 WHERE a.entity = 'incident' AND a.entity_id = $1 ORDER BY a.id`, [id]),
    i.alert_delivery_id ? pool.query(`SELECT a.id, a.alert_type, a.priority, a.event_time FROM alert a JOIN alert_delivery d ON d.alert_id = a.id AND d.alert_event_time = a.event_time WHERE d.id = $1`, [i.alert_delivery_id]) : { rows: [] },
  ]);
  res.json({ incident: { ...i, ...det[0] }, requests: reqs.rows, flags: flags.rows, timeline: notes.rows, alert: alert.rows[0] || null });
}));

router.post('/incidents/:id/note', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query(`SELECT i.id, po.zone_id FROM incident i JOIN rpf_post po ON po.id = i.post_id WHERE i.id = $1`, [id]);
  if (!rows.length || !canSeeZone(req.user, rows[0].zone_id)) throw notFound('incident not found');
  await audit(null, { user: req.user, action: 'incident.note', entity: 'incident', entityId: id, zoneId: rows[0].zone_id, details: { text: requireText(req.body && req.body.text, 'text', 1000) } });
  res.status(201).json({ ok: true });
}));

/** Reopening a closed incident is a CMS-side decision (RPF's lifecycle is forward-only). */
router.post('/incidents/:id/reopen', wrap(async (req, res) => {
  const id = parseId(req.params.id); const reason = requireText(req.body && req.body.reason, 'reason', 500);
  await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT i.id, i.status, i.post_id, po.zone_id FROM incident i JOIN rpf_post po ON po.id = i.post_id WHERE i.id = $1 FOR UPDATE OF i`, [id]);
    const i = rows[0];
    if (!i || !canSeeZone(req.user, i.zone_id)) throw notFound('incident not found');
    if (i.status !== 'closed') throw conflict(`incident is '${i.status}', only closed incidents can be reopened`);
    await client.query(`UPDATE incident SET status='open', closed_at=NULL, closed_by=NULL, updated_at=now() WHERE id=$1`, [id]);
    await audit(client, { user: req.user, action: 'incident.reopen', entity: 'incident', entityId: id, zoneId: i.zone_id, details: { reason } });
    await notify.send(client, { zone_id: i.zone_id, post_id: i.post_id, kind: 'incident', ref_entity: 'incident', ref_id: id, title: `Incident #${id} was reopened by CMS`, body: reason });
  });
  res.json({ ok: true });
}));

module.exports = router;
