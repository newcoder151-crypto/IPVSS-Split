const { pool } = require('../db');
const settings = require('./settings');
const { candidatePosts } = require('./routing');
const { dispatchAlert } = require('./incidentService');
const { getSystemUserId } = require('./alertService');

/**
 * A delivery nobody acknowledged within `escalation_minutes` is marked escalated and shows on the console dashboard as
 * needing the control room. DATA SECURITY: it is NOT handed to another post (that would show one post's alert, incident
 * and activity to a different post). Only with ESCALATE_TO_NEXT_POST=1 does it also go to the next-nearest post in the zone.
 */
async function run() {
  const mins = await settings.get('escalation_minutes');
  const { rows } = await pool.query(
    `SELECT d.id, d.alert_id, d.alert_event_time, d.post_id, a.status, a.zone_id
       FROM alert_delivery d JOIN alert a ON a.id = d.alert_id AND a.event_time = d.alert_event_time
      WHERE d.ack_at IS NULL AND d.sent_at < now() - make_interval(mins => $1)
        AND a.status IN ('routed','escalated')
        AND NOT EXISTS (SELECT 1 FROM alert_delivery e WHERE e.escalated_from = d.id)
        AND NOT EXISTS (SELECT 1 FROM alert_delivery o WHERE o.alert_id = d.alert_id AND o.alert_event_time = d.alert_event_time AND o.ack_at IS NOT NULL)
      ORDER BY d.id LIMIT 50`, [mins]);
  let escalated = 0; let exhausted = 0;
  const sys = { id: await getSystemUserId() };
  for (const d of rows) {
    const { rows: had } = await pool.query(`SELECT post_id FROM alert_delivery WHERE alert_id = $1 AND alert_event_time = $2`, [d.alert_id, d.alert_event_time]);
    const next = process.env.ESCALATE_TO_NEXT_POST === '1' ? await candidatePosts(null, d.alert_id, { exclude: had.map((h) => h.post_id), limit: 1 }) : [];
    if (!next.length) {
      if (d.status !== 'escalated') {
        await pool.query(`UPDATE alert SET status='escalated' WHERE id=$1 AND event_time=$2`, [d.alert_id, d.alert_event_time]);
        await pool.query(`INSERT INTO alert_history (alert_id, alert_event_time, from_status, to_status, note) VALUES ($1,$2,$3,'escalated',$4)`,
          [d.alert_id, d.alert_event_time, d.status, `not acknowledged within ${mins} min - needs the control room`]);
      }
      exhausted++; continue;
    }
    try {
      await dispatchAlert({ alertId: d.alert_id, postId: next[0].id, user: sys, mode: 'escalation', incident: false, allowedStatuses: ['routed', 'escalated'],
        escalatedFrom: d.id, note: `not acknowledged within ${mins} min - escalated to ${next[0].name}` });
      escalated++;
    } catch (e) { console.warn(`escalation of alert ${d.alert_id}:`, e.message); }
  }
  return `${escalated} escalated, ${exhausted} with no further post`;
}
module.exports = { run };
