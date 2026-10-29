const { pool } = require('../db');

/**
 * Candidate RPF posts for an alert, nearest first (straight-line GPS distance, zone-scoped).
 * Routing sits behind this one function so jurisdiction polygons / route-based lookup can replace
 * pure distance later without touching callers. `exclude` skips posts that already got the alert.
 */
async function candidatePosts(client, alertId, { exclude = [], limit = 5 } = {}) {
  const { rows } = await (client || pool).query(
    `SELECT p.id, p.name, ST_Distance(p.location, a.location) AS distance_m
       FROM rpf_post p JOIN alert a ON a.zone_id = p.zone_id
      WHERE a.id = $1 AND p.active AND NOT (p.id = ANY($2))
      ORDER BY p.location <-> a.location LIMIT $3`,
    [alertId, exclude, limit]
  );
  return rows;
}
async function findNearestPostForAlert(client, alertId) {
  const c = await candidatePosts(client, alertId, { limit: 1 });
  return c.length ? c[0].id : null;
}
module.exports = { candidatePosts, findNearestPostForAlert };
