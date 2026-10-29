const { pool } = require('../db');
const settings = require('./settings');

/**
 * Notifications for RPF posts (Cl. 3.15.8). Always written in-app (the RPF dashboard
 * shows them and polls for new ones). If a webhook URL is configured in Settings, each
 * notification is also POSTed there as JSON, so an SMS / e-mail gateway can be bolted on
 * without touching this code.
 */
async function send(client, n) {
  const q = client || pool;
  const { rows } = await q.query(
    `INSERT INTO notification (zone_id, post_id, kind, title, body, ref_entity, ref_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [n.zone_id || null, n.post_id || null, n.kind, n.title, n.body || null, n.ref_entity || null, n.ref_id || null]
  );
  // Webhook only after the row exists; never let a slow gateway block or fail the caller.
  settings.get('notify_webhook_url').then((url) => {
    if (!url) return;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: rows[0].id, ...n }), signal: AbortSignal.timeout(5000) })
      .catch((e) => console.warn('notify webhook failed:', e.message));
  }).catch(() => {});
  return rows[0].id;
}
module.exports = { send };
