const { pool, withTransaction } = require('../db');
const { badRequest, notFound } = require('../errors');
const settings = require('./settings');
const notify = require('./notify');
const { candidatePosts } = require('./routing');
const { dispatchAlert } = require('./incidentService');
const { audit } = require('./audit');

let systemUserId = null;
async function getSystemUserId() {
  if (systemUserId) return systemUserId;
  const { rows } = await pool.query(`SELECT id FROM users WHERE username = 'system'`);
  if (!rows.length) throw new Error("no 'system' user found - did you apply sql/seed.sqlx?");
  systemUserId = rows[0].id;
  return systemUserId;
}

/** The zone that owned the unit when the event happened (assignment history), else its current zone. */
async function zoneAt(nvrId, at) {
  const { rows } = await pool.query(
    `SELECT zone_id FROM nvr_zone_assignment
      WHERE nvr_id = $1 AND assigned_from <= $2 AND (assigned_until IS NULL OR assigned_until > $2)
      ORDER BY assigned_from DESC LIMIT 1`, [nvrId, at]);
  if (rows.length) return rows[0].zone_id;
  const { rows: n } = await pool.query('SELECT current_zone_id FROM nvr_unit WHERE id = $1', [nvrId]);
  return n.length ? n[0].current_zone_id : null;
}

const knownMonths = new Set();
async function ensurePartition(ts) {
  const key = `${ts.getUTCFullYear()}-${ts.getUTCMonth()}`;
  if (knownMonths.has(key)) return;
  await pool.query('SELECT ensure_partition_for($1)', [ts]);
  knownMonths.add(key);
}

/**
 * One alert from an M-NVR (or the legacy dummy endpoint). Idempotent on (nvr, nvr_event_id, event_time),
 * so an NVR that retries after a dropped link never creates a second alert.
 *   priority >= threshold -> nearest post in the zone, incident created automatically
 *   otherwise             -> waits in the CMS operator queue (status 'new')
 */
async function ingestAlert(nvr, a) {
  const { nvr_event_id, alert_type, priority, lat, lon } = a;
  if (!nvr_event_id || !alert_type || priority == null || lat == null || lon == null) throw badRequest('nvr_event_id, alert_type, priority, lat, lon are required');
  const prio = Number(priority);
  if (!Number.isInteger(prio) || prio < 1 || prio > 10) throw badRequest('priority must be an integer 1-10');
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon)) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw badRequest('lat/lon out of range');
  const eventTime = a.event_time ? new Date(a.event_time) : new Date();
  if (Number.isNaN(eventTime.getTime())) throw badRequest('event_time is not a valid timestamp');

  let cameraId = null;
  if (a.camera_id != null) {
    const { rows } = await pool.query('SELECT id FROM camera WHERE id = $1 AND nvr_id = $2', [Number(a.camera_id), nvr.id]);
    if (!rows.length) throw badRequest(`camera ${a.camera_id} does not belong to this NVR`);
    cameraId = rows[0].id;
  }
  const zoneId = await zoneAt(nvr.id, eventTime);
  if (zoneId == null) throw badRequest(`NVR ${nvr.id} has no zone assignment`);
  if (eventTime > new Date(Date.now() + 5 * 60000)) throw badRequest('event_time is in the future (check the unit clock)');
  await ensurePartition(eventTime);
  const threshold = await settings.get('priority_threshold');
  const mode = prio >= threshold ? 'auto' : 'manual';

  const { rows } = await pool.query(
    `INSERT INTO alert (nvr_id, nvr_event_id, camera_id, zone_id, alert_type, priority, event_time, location, fix_age_s, fix_quality, routing_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7, ST_SetSRID(ST_MakePoint($8,$9),4326)::geography, $10,$11,$12)
     ON CONFLICT (nvr_id, nvr_event_id, event_time) DO NOTHING
     RETURNING id, event_time, status, routing_mode, priority`,
    [nvr.id, String(nvr_event_id), cameraId, zoneId, String(alert_type).toLowerCase(), prio, eventTime, Number(lon), Number(lat),
      a.fix_age_s != null ? Math.round(Number(a.fix_age_s)) : null, a.fix_quality || null, mode]);
  if (!rows.length) {
    const { rows: ex } = await pool.query(
      `SELECT id, event_time, status, routing_mode, priority FROM alert WHERE nvr_id = $1 AND nvr_event_id = $2 AND event_time = $3`,
      [nvr.id, String(nvr_event_id), eventTime]);
    return { alert: ex[0], duplicate: true, dispatched: ex[0].status !== 'new' };
  }
  const alert = rows[0];
  await pool.query(
    `INSERT INTO alert_history (alert_id, alert_event_time, from_status, to_status, note) VALUES ($1,$2,NULL,'new',$3)`,
    [alert.id, alert.event_time, `received from ${nvr.name}`]);

  const lowMode = await settings.get('low_priority_mode');
  if (mode === 'manual' && lowMode !== 'auto_deliver') return { alert, dispatched: false };

  const cands = await candidatePosts(null, alert.id, { limit: 1 });
  if (!cands.length && mode === 'manual') return { alert, dispatched: false, warning: 'no active post in this zone - left in the operator queue' };
  if (!cands.length) {
    await pool.query(
      `INSERT INTO alert_history (alert_id, alert_event_time, from_status, to_status, note) VALUES ($1,$2,'new','new','high priority but no active post in zone - left for operator')`,
      [alert.id, alert.event_time]);
    return { alert, dispatched: false, warning: 'priority is above the threshold but no active post exists in this zone - left in the operator queue' };
  }
  const sys = await getSystemUserId();
  const high = mode === 'auto';
  const r = await dispatchAlert({ alertId: alert.id, postId: cands[0].id, user: { id: sys }, mode: 'auto', incident: high,
    note: high ? undefined : 'below the priority threshold - delivered to the nearest post, no incident yet (the officer decides)' });
  return { alert: { ...alert, status: 'routed' }, dispatched: true, ...r };
}

/**
 * Control room dismisses an alert: it was never real, or it is dealt with elsewhere. Allowed while the alert is still
 * open (new in the queue, routed to a post, or escalated with nobody answering). Posts that already received it are told,
 * so their screens stop asking them to acknowledge it.
 */
async function dismissAlert(user, alertId, reason, client) {
  const run = async (q) => {
    const { rows: cur } = await q.query(`SELECT id, event_time, zone_id, status FROM alert WHERE id = $1 FOR UPDATE`, [alertId]);
    const a = cur[0];
    if (!a) throw notFound(`alert ${alertId} not found`);
    if (!['new', 'routed', 'escalated'].includes(a.status)) throw notFound(`alert ${alertId} is '${a.status}' - only an open alert can be dismissed`);
    await q.query(`UPDATE alert SET status = 'dismissed' WHERE id = $1 AND event_time = $2`, [a.id, a.event_time]);
    await q.query(
      `INSERT INTO alert_history (alert_id, alert_event_time, changed_by, from_status, to_status, note) VALUES ($1,$2,$3,$4,'dismissed',$5)`,
      [a.id, a.event_time, user.id, a.status, `Dismissed by CMS: ${reason}`]);
    await audit(q, { user, action: 'alert.dismiss', entity: 'alert', entityId: a.id, zoneId: a.zone_id, details: { reason, from: a.status } });
    const { rows: posts } = await q.query(`SELECT DISTINCT d.post_id, d.id AS delivery_id FROM alert_delivery d WHERE d.alert_id = $1 AND d.alert_event_time = $2`, [a.id, a.event_time]);
    for (const p of posts) {
      await q.query(`UPDATE notification SET read_at = now() WHERE ref_entity = 'alert_delivery' AND ref_id = $1 AND read_at IS NULL`, [p.delivery_id]);
      await notify.send(q, { zone_id: a.zone_id, post_id: p.post_id, kind: 'alert', ref_entity: 'alert_delivery', ref_id: p.delivery_id, title: 'An alert was dismissed by the control room', body: reason });
    }
    return a;
  };
  if (client) return run(client);
  return withTransaction(run);
}

module.exports = { ingestAlert, dismissAlert, zoneAt, getSystemUserId };
