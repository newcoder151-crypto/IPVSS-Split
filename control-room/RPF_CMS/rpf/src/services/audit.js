/**
 * Writes to CMS's append-only audit_log. Every view / download / flag /
 * acknowledgement / request is recorded here - this is RPF's chain-of-custody
 * trail (design doc: ACCESS_LOG). Pass the transaction client when the action
 * being audited is itself in a transaction so both commit or neither does.
 */
const { pool } = require('../db');

async function audit(clientOrNull, { user, action, entity, entityId, zoneId, details }) {
  const q = clientOrNull || pool;
  await q.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, zone_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      user ? user.id : null,
      action,
      entity,
      entityId == null ? null : entityId,
      zoneId == null ? (user ? user.zone_id : null) : zoneId,
      details ? JSON.stringify(details) : null,
    ]
  );
}

module.exports = { audit };
