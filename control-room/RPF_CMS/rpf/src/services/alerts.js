const { notFound } = require('../errors');

/**
 * An RPF "alert" is one alert_delivery: CMS delivering one alert to one
 * post. The incident (if any) hangs off the delivery.
 */
const ALERT_SELECT = `
  SELECT d.id AS delivery_id, d.alert_id, d.alert_event_time,
         d.post_id, p.name AS post_name, p.zone_id,
         d.sent_at, d.ack_at, ub.username AS ack_by_username, d.escalated_from, d.mode,
         a.alert_type, a.priority, a.status AS alert_status, a.received_time,
         a.camera_id, c.name AS camera_name, a.nvr_id, n.name AS nvr_name,
         ST_Y(a.location::geometry) AS lat, ST_X(a.location::geometry) AS lon,
         a.fix_age_s, a.fix_quality, n.train_no,
         i.id AS incident_id, i.status AS incident_status, i.source AS incident_source
    FROM alert_delivery d
    JOIN rpf_post p ON p.id = d.post_id
    JOIN alert a ON a.id = d.alert_id AND a.event_time = d.alert_event_time
    JOIN nvr_unit n ON n.id = a.nvr_id
    LEFT JOIN camera c ON c.id = a.camera_id
    LEFT JOIN users ub ON ub.id = d.ack_by
    LEFT JOIN LATERAL (
        SELECT id, status, source FROM incident
         WHERE alert_delivery_id = d.id ORDER BY id LIMIT 1
    ) i ON TRUE`;

/** Change alert.status and leave a trail in alert_history. No-op if already there. */
async function setAlertStatus(client, user, alertId, eventTime, toStatus, allowedFrom, note) {
  const { rows } = await client.query(
    `SELECT status FROM alert WHERE id = $1 AND event_time = $2 FOR UPDATE`,
    [alertId, eventTime]
  );
  if (!rows.length) throw notFound(`alert ${alertId} not found`);
  const from = rows[0].status;
  if (from === toStatus || (allowedFrom && !allowedFrom.includes(from))) return false;

  await client.query(`UPDATE alert SET status = $3 WHERE id = $1 AND event_time = $2`, [alertId, eventTime, toStatus]);
  await client.query(
    `INSERT INTO alert_history (alert_id, alert_event_time, changed_by, from_status, to_status, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [alertId, eventTime, user.id, from, toStatus, note || null]
  );
  return true;
}

/** Officer acknowledges a delivery. Returns false if it was already acknowledged. */
async function ackDelivery(client, user, delivery, note) {
  const { rowCount } = await client.query(
    `UPDATE alert_delivery SET ack_at = now(), ack_by = $1 WHERE id = $2 AND ack_at IS NULL`,
    [user.id, delivery.id]
  );
  if (!rowCount) return false;
  // the bell must not keep counting a notice for an alert that has been dealt with
  await client.query(`UPDATE notification SET read_at = now(), read_by = $1 WHERE ref_entity = 'alert_delivery' AND ref_id = $2 AND read_at IS NULL`, [user.id, delivery.id]);
  await setAlertStatus(client, user, delivery.alert_id, delivery.alert_event_time,
    'acknowledged', ['new', 'routed', 'escalated'], note || 'acknowledged at RPF post');
  return true;
}

module.exports = { ALERT_SELECT, setAlertStatus, ackDelivery };
