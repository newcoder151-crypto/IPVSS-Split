const { withTransaction } = require('../db');
const { ServiceError } = require('../errors');
const { audit } = require('./audit');
const notify = require('./notify');

/**
 * Turns one alert into an alert_delivery (+ optionally an incident), atomically, and records the
 * status change in alert_history. This is the single place "an alert reaches a post" happens:
 *   auto      high priority, nearest post, incident created at once           (system)
 *   operator  low priority, an operator forwards it; incident only if `incident` is true
 *   escalation  the previous post did not acknowledge in time                    (system)
 * Locks the alert row first so concurrent callers (double-click, two workers) cannot both succeed.
 */
async function dispatchAlert({ alertId, postId, user, mode = 'operator', incident = false, note, allowedStatuses = ['new'], escalatedFrom = null }) {
  return withTransaction(async (client) => {
    const { rows: ar } = await client.query(
      `SELECT id, event_time, zone_id, alert_type, priority, nvr_id, camera_id, location, status
         FROM alert WHERE id = $1 FOR UPDATE`, [alertId]);
    if (!ar.length) throw new ServiceError(404, `alert ${alertId} not found`);
    const a = ar[0];
    if (!allowedStatuses.includes(a.status)) throw new ServiceError(409, `alert ${alertId} is '${a.status}', not one of: ${allowedStatuses.join(', ')}`);

    const { rows: pr } = await client.query(
      `SELECT id, name FROM rpf_post WHERE id = $1 AND zone_id = $2 AND active`, [postId, a.zone_id]);
    if (!pr.length) throw new ServiceError(400, `post ${postId} is not an active post in this alert's zone`);

    const { rows: dr } = await client.query(
      `INSERT INTO alert_delivery (alert_id, alert_event_time, post_id, sent_at, mode, forwarded_by, escalated_from)
       VALUES ($1,$2,$3,now(),$4,$5,$6) RETURNING id, post_id`,
      [a.id, a.event_time, postId, mode, user ? user.id : null, escalatedFrom]);
    const delivery = dr[0];

    let inc = null;
    if (incident) {
      const source = mode === 'auto' ? 'auto' : 'operator';
      const { rows: ir } = await client.query(
        `INSERT INTO incident (alert_delivery_id, post_id, alert_type, location, occurred_at, raised_by,
                               source, priority, nvr_id, camera_id, title)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, status, created_at`,
        [delivery.id, postId, a.alert_type, a.location, a.event_time, user.id, source, a.priority, a.nvr_id, a.camera_id,
          `${a.alert_type.replace(/_/g, ' ')} (P${a.priority})`]);
      inc = ir[0];
    }

    const to = mode === 'escalation' ? 'escalated' : 'routed';
    await client.query(`UPDATE alert SET status = $3, assigned_post_id = $4 WHERE id = $1 AND event_time = $2`, [a.id, a.event_time, to, postId]);
    await client.query(
      `INSERT INTO alert_history (alert_id, alert_event_time, changed_by, from_status, to_status, note) VALUES ($1,$2,$3,$4,$5,$6)`,
      [a.id, a.event_time, user ? user.id : null, a.status, to,
        note || (mode === 'auto' ? `auto-dispatched to ${pr[0].name}` : mode === 'escalation' ? `escalated to ${pr[0].name}` : `forwarded to ${pr[0].name}`)]);
    await audit(client, {
      user, action: `alert.${mode === 'auto' ? 'auto_dispatch' : mode === 'escalation' ? 'escalate' : incident ? 'promote' : 'forward'}`,
      entity: 'alert', entityId: a.id, zoneId: a.zone_id,
      details: { post_id: postId, delivery_id: delivery.id, incident_id: inc && inc.id, mode },
    });
    await notify.send(client, {
      zone_id: a.zone_id, post_id: postId, kind: 'alert', ref_entity: 'alert_delivery', ref_id: delivery.id,
      title: `${a.alert_type.replace(/_/g, ' ')} - priority ${a.priority}${incident ? ' (incident raised)' : ''}`,
      body: mode === 'escalation' ? 'Escalated: the previous post did not acknowledge in time.' : mode === 'auto' && !incident ? 'Lower priority: delivered automatically. Raise an incident if it needs action.' : mode === 'operator' && !incident ? 'Forwarded by CMS operator - review and raise an incident if needed.' : null,
    });
    return {
      deliveryId: delivery.id, postId, postName: pr[0].name,
      incidentId: inc ? inc.id : null, incidentStatus: inc ? inc.status : null,
      // names the original incidentService returned, kept for the legacy routes
      alertDeliveryId: delivery.id,
    };
  });
}

/** Original signature (alert -> post + incident), used by the legacy routes. */
const dispatchAlertToPost = ({ alertId, postId, raisedByUserId }) =>
  dispatchAlert({ alertId, postId, user: { id: raisedByUserId }, mode: 'operator', incident: true })
    .then((r) => ({ ...r, createdAt: new Date() }));

module.exports = { dispatchAlert, dispatchAlertToPost, ServiceError };
