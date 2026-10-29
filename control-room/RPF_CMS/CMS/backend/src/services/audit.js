const { pool } = require('../db');

/** Append-only audit trail. `user` may be null (system / NVR). Pass a transaction client to commit together. */
async function audit(clientOrNull, { user, action, entity, entityId, zoneId, details }) {
  const q = clientOrNull || pool;
  await q.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, zone_id, details) VALUES ($1,$2,$3,$4,$5,$6)`,
    [user ? user.id : null, action, entity, entityId == null ? null : entityId,
      zoneId == null ? (user ? user.zone_id : null) : zoneId, details ? JSON.stringify(details) : null]
  );
}
module.exports = { audit };
