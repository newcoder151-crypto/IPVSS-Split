const express = require('express');
const { pool, withTransaction } = require('../db');
const { ackDelivery, setAlertStatus } = require('../services/alerts');
const { createRequest, REQUEST_SELECT, footageForRequests } = require('../services/requests');
const { postScopeSql, canSeePost } = require('../services/scope');
const { audit } = require('../services/audit');
const { parseId, parseLimit, parseTs, requireText } = require('../services/util');
const { badRequest, notFound, conflict, wrap } = require('../errors');

const router = express.Router();

// Forward-only lifecycle. Reopening is a CMS-side decision, not an RPF one.
const NEXT = { open: ['under_review', 'closed'], under_review: ['closed'], closed: [] };

const CATEGORIES = ['theft', 'harassment', 'assault', 'unattended_bag', 'fire_smoke', 'trespass', 'vandalism', 'medical', 'other'];

const INCIDENT_SELECT = `
  SELECT i.id, i.status, i.source, i.title, i.description, i.alert_type, i.priority, i.occurred_at, i.created_at, i.updated_at,
         i.closed_at, i.closing_note, i.post_id, p.name AS post_name, p.zone_id,
         ur.username AS raised_by_username, uc.username AS closed_by_username,
         i.nvr_id, n.name AS nvr_name, n.train_no, i.camera_id, c.name AS camera_name,
         ST_Y(i.location::geometry) AS lat, ST_X(i.location::geometry) AS lon, i.alert_delivery_id,
         (SELECT COUNT(*) FROM video_request r WHERE r.incident_id = i.id) AS request_count,
         (SELECT COUNT(*) FROM evidence_flag e WHERE e.incident_id = i.id AND e.status = 'active') AS active_flags
    FROM incident i
    JOIN rpf_post p ON p.id = i.post_id
    JOIN users ur ON ur.id = i.raised_by
    LEFT JOIN users uc ON uc.id = i.closed_by
    LEFT JOIN nvr_unit n ON n.id = i.nvr_id
    LEFT JOIN camera c ON c.id = i.camera_id`;

/** GET /api/incidents?status=active|open|under_review|closed|all&source=   (the dashboard tabs: active = open + under review, closed) */
router.get('/', wrap(async (req, res) => {
  const params = [];
  const where = [postScopeSql(req.user, 'p', params)];
  const { status, source } = req.query;
  if (!status || status === 'active') where.push(`i.status <> 'closed'`);
  else if (status !== 'all') { params.push(status); where.push(`i.status = $${params.length}`); }
  if (source) { params.push(source); where.push(`i.source = $${params.length}`); }
  const limit = parseLimit(req.query.limit);
  const { rows } = await pool.query(`${INCIDENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT ${limit}`, params);
  res.json(rows);
}));

/** GET /api/incidents/:id - the incident with its requests, footage, evidence flags and timeline. */
router.get('/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query(`${INCIDENT_SELECT} WHERE i.id = $1`, [id]);
  const inc = rows[0];
  if (!inc || !canSeePost(req.user, inc.post_id, inc.zone_id)) throw notFound('incident not found');
  const [reqs, flags, timeline] = await Promise.all([
    pool.query(`${REQUEST_SELECT} WHERE r.incident_id = $1 AND r.post_id = $2 ORDER BY r.id DESC`, [id, inc.post_id]),
    pool.query(
      `SELECT e.id, e.footage_id, e.retention, e.retain_to, e.status, e.archive_status, e.section_start_s, e.section_end_s, e.justification, e.flagged_at
         FROM evidence_flag e JOIN delivered_footage f ON f.id = e.footage_id JOIN video_request r ON r.id = f.video_request_id
        WHERE e.incident_id = $1 AND r.post_id = $2 ORDER BY e.id DESC`, [id, inc.post_id]),
    pool.query(
      `SELECT t.occurred_at, t.action, t.details, t.actor FROM (
         SELECT a.occurred_at, a.action, a.details::jsonb AS details, u.username AS actor
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.entity = 'incident' AND a.entity_id = $1
         UNION ALL
         SELECT h.changed_at, 'alert.' || h.to_status, jsonb_build_object('note', h.note, 'from', h.from_status), u.username
           FROM alert_history h JOIN alert_delivery d ON d.alert_id = h.alert_id AND d.alert_event_time = h.alert_event_time
           LEFT JOIN users u ON u.id = h.changed_by WHERE d.id = $2
            AND (u.post_id IS NULL OR u.post_id = $3)
            AND NOT (COALESCE(h.note, '') ~* '(dispatched|escalated|forwarded) to ' AND position(lower($4) in lower(COALESCE(h.note, ''))) = 0)
       ) t ORDER BY t.occurred_at`, [id, inc.alert_delivery_id, inc.post_id, inc.post_name]),
]);
  const footage = await footageForRequests(reqs.rows.map((r) => r.id));
  res.json({ incident: inc, requests: reqs.rows, footage, flags: flags.rows, timeline: timeline.rows });
}));

/**
 * POST /api/incidents
 *   { delivery_id, title?, description? }     raise from an alert delivered to the post (low-priority alerts
 *                                             forwarded by a CMS operator, or any alert the officer wants to work)
 *   { manual: true, title, category?, description?, camera_id, occurred_at?, lat?, lon?, priority? }
 *                                             no alert behind it: a complaint, a patrol sighting, a passenger report.
 *                                             The officer then requests footage for it from the incident page.
 */
router.post('/', wrap(async (req, res) => {
  const b = req.body || {};
  const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 200) : null;
  const description = typeof b.description === 'string' && b.description.trim() ? b.description.trim().slice(0, 4000) : null;

  const incident = await withTransaction(async (client) => {
    if (b.delivery_id != null) {
      const deliveryId = parseId(b.delivery_id, 'delivery_id');
      const { rows } = await client.query(
        `SELECT d.id, d.post_id, d.alert_id, d.alert_event_time, a.alert_type, a.priority, a.nvr_id, a.camera_id, a.location, a.event_time
           FROM alert_delivery d JOIN alert a ON a.id = d.alert_id AND a.event_time = d.alert_event_time
          WHERE d.id = $1 FOR UPDATE OF d`, [deliveryId]);
      const d = rows[0];
      if (!d || d.post_id !== req.user.post_id) throw notFound('alert not found');
      const { rows: existing } = await client.query(`SELECT id FROM incident WHERE alert_delivery_id = $1 LIMIT 1`, [d.id]);
      if (existing.length) throw conflict(`incident #${existing[0].id} already exists for this alert`);
      const { rows: ins } = await client.query(
        `INSERT INTO incident (alert_delivery_id, post_id, alert_type, location, occurred_at, raised_by, source, priority, nvr_id, camera_id, title, description)
         VALUES ($1,$2,$3,$4,$5,$6,'officer',$7,$8,$9,$10,$11) RETURNING id, status, created_at`,
        [d.id, d.post_id, d.alert_type, d.location, d.event_time, req.user.id, d.priority, d.nvr_id, d.camera_id,
          title || `${d.alert_type.replace(/_/g, ' ')} (P${d.priority})`, description]);
      await ackDelivery(client, req.user, { id: d.id, alert_id: d.alert_id, alert_event_time: d.alert_event_time }, 'incident raised');
      await audit(client, { user: req.user, action: 'incident.create', entity: 'incident', entityId: ins[0].id, details: { delivery_id: d.id, alert_id: d.alert_id, source: 'officer' } });
      return ins[0];
    }

    if (!b.manual) throw badRequest('send delivery_id (from an alert) or manual: true with the incident details');
    if (!title) throw badRequest('title is required');
    const category = CATEGORIES.includes(b.category) ? b.category : 'other';
    const cameraId = parseId(b.camera_id, 'camera_id');
    const occurred = b.occurred_at ? parseTs(b.occurred_at, 'occurred_at') : new Date();
    if (occurred > new Date(Date.now() + 60000)) throw badRequest('occurred_at is in the future');
    const prio = b.priority == null || b.priority === '' ? 5 : Number(b.priority);
    if (!Number.isInteger(prio) || prio < 1 || prio > 10) throw badRequest('priority must be a whole number from 1 to 10');

    const { rows: cams } = await client.query(
      `SELECT c.id, c.nvr_id, n.last_lat, n.last_lon FROM camera c JOIN nvr_unit n ON n.id = c.nvr_id
        WHERE c.id = $1 AND c.active AND n.current_zone_id = $2`, [cameraId, req.user.zone_id]);
    if (!cams.length) throw badRequest(`camera ${cameraId} is not an active camera in your zone`);

    // Where it happened: what the officer gave, else the train's last known position, else the post itself.
    let lat = b.lat === '' || b.lat == null ? null : Number(b.lat);
    let lon = b.lon === '' || b.lon == null ? null : Number(b.lon);
    if ((lat != null && !(Math.abs(lat) <= 90)) || (lon != null && !(Math.abs(lon) <= 180))) throw badRequest('lat/lon are out of range');
    if (lat == null || lon == null) { lat = cams[0].last_lat; lon = cams[0].last_lon; }
    let sql = `ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography`; let locParams = [lon, lat];
    if (lat == null || lon == null) { sql = `(SELECT location FROM rpf_post WHERE id = $1)`; locParams = [req.user.post_id]; }

    const { rows: ins } = await client.query(
      `INSERT INTO incident (alert_delivery_id, post_id, alert_type, location, occurred_at, raised_by, source, priority, nvr_id, camera_id, title, description)
       VALUES (NULL, $${locParams.length + 1}, $${locParams.length + 2}, ${sql}, $${locParams.length + 3}, $${locParams.length + 4}, 'manual', $${locParams.length + 5}, $${locParams.length + 6}, $${locParams.length + 7}, $${locParams.length + 8}, $${locParams.length + 9})
       RETURNING id, status, created_at`,
      [...locParams, req.user.post_id, category, occurred, req.user.id, prio, cams[0].nvr_id, cameraId, title, description]);
    await audit(client, { user: req.user, action: 'incident.create', entity: 'incident', entityId: ins[0].id, details: { source: 'manual', category, camera_id: cameraId, occurred_at: occurred } });
    return ins[0];
  });
  res.status(201).json(incident);
}));

/** PATCH /api/incidents/:id/status { status, note? } - open -> under_review -> closed. */
router.patch('/:id/status', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const to = req.body && req.body.status;
  if (!['under_review', 'closed'].includes(to)) throw badRequest("status must be 'under_review' or 'closed'");
  const note = req.body.note ? String(req.body.note).slice(0, 1000) : null;

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT i.id, i.status, i.post_id, i.alert_delivery_id AS delivery_id, d.alert_id, d.alert_event_time
         FROM incident i LEFT JOIN alert_delivery d ON d.id = i.alert_delivery_id
        WHERE i.id = $1 FOR UPDATE OF i`, [id]);
    const inc = rows[0];
    if (!inc || inc.post_id !== req.user.post_id) throw notFound('incident not found');
    if (!NEXT[inc.status].includes(to)) throw conflict(`incident is '${inc.status}'; cannot move to '${to}'`);

    if (to === 'closed') {
      await client.query(`UPDATE incident SET status = 'closed', closed_at = now(), closed_by = $2, closing_note = $3, updated_at = now() WHERE id = $1`, [id, req.user.id, note]);
    } else {
      await client.query(`UPDATE incident SET status = $2, updated_at = now() WHERE id = $1`, [id, to]);
    }
    if (inc.delivery_id) {
      // Working an incident implies the alert was seen.
      await ackDelivery(client, req.user, { id: inc.delivery_id, alert_id: inc.alert_id, alert_event_time: inc.alert_event_time }, 'incident ' + to);
      if (to === 'closed') {
        // Alert is resolved once no incident on it (from any delivery) is still open.
        const { rows: still } = await client.query(
          `SELECT 1 FROM incident i2 JOIN alert_delivery d2 ON d2.id = i2.alert_delivery_id
            WHERE d2.alert_id = $1 AND d2.alert_event_time = $2 AND i2.status <> 'closed' AND i2.id <> $3 LIMIT 1`,
          [inc.alert_id, inc.alert_event_time, id]);
        if (!still.length) await setAlertStatus(client, req.user, inc.alert_id, inc.alert_event_time, 'resolved', null, note || 'incident closed');
      }
    }
    await audit(client, { user: req.user, action: 'incident.status', entity: 'incident', entityId: id, details: { from: inc.status, to, note } });
    return { id, status: to, delivery_id: inc.delivery_id };
  });
  res.json(result);
}));

/** POST /api/incidents/:id/notes { text } - a dated note on the incident (kept in the audit trail). */
router.post('/:id/notes', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const text = requireText(req.body && req.body.text, 'text', 1000);
  const { rows } = await pool.query(`SELECT post_id, status FROM incident WHERE id = $1`, [id]);
  if (!rows.length || rows[0].post_id !== req.user.post_id) throw notFound('incident not found');
  await audit(null, { user: req.user, action: 'incident.note', entity: 'incident', entityId: id, details: { text } });
  res.status(201).json({ ok: true });
}));

/**
 * POST /api/incidents/:id/requests - request footage for an incident.
 * Defaults: the incident's camera, occurred_at +/- 5 minutes (clamped to now).
 */
router.post('/:id/requests', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body || {};
  const requestId = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT i.post_id, i.status, i.occurred_at, i.camera_id AS inc_camera, d.alert_id, a.camera_id AS alert_camera
         FROM incident i
         LEFT JOIN alert_delivery d ON d.id = i.alert_delivery_id
         LEFT JOIN alert a ON a.id = d.alert_id AND a.event_time = d.alert_event_time
        WHERE i.id = $1`, [id]);
    const inc = rows[0];
    if (!inc || inc.post_id !== req.user.post_id) throw notFound('incident not found');
    if (inc.status === 'closed') throw conflict('this incident is closed - footage can no longer be requested for it');

    const camera = body.camera_id != null ? body.camera_id : (inc.inc_camera != null ? inc.inc_camera : inc.alert_camera);
    if (camera == null) throw badRequest('this incident has no camera - choose a camera_id for the request');
    const pad = 5 * 60000;
    return createRequest(client, req.user, {
      camera_id: camera,
      window_start: body.window_start || new Date(inc.occurred_at.getTime() - pad).toISOString(),
      window_end: body.window_end || new Date(Math.min(inc.occurred_at.getTime() + pad, Date.now())).toISOString(),
      reason: body.reason,
      alert_id: inc.alert_id,
      incident_id: id,
    });
  });
  res.status(201).json({ id: requestId, status: 'submitted' });
}));

module.exports = router;
