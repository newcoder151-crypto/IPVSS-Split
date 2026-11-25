const express = require('express');
const { pool } = require('../../db');
const { zoneScope } = require('../../middleware/auth');
const { parseLimit } = require('../../services/util');
const { wrap } = require('../../errors');

/** The console's bell: notices for operators / administrators (see sql/migrations/010_console_notices.sql). Shared by the zone's console users. */
const router = express.Router();

/** GET /notices?unread=1&limit=  - newest first, with the post's name. */
router.get('/notices', wrap(async (req, res) => {
  const params = [];
  const where = [zoneScope(req.user, 'n.zone_id', params, req.query.zone_id)];
  if (req.query.unread === '1') where.push('n.read_at IS NULL');
  const { rows } = await pool.query(
    `SELECT n.id, n.kind, n.title, n.body, n.ref_entity, n.ref_id, n.created_at, n.read_at, p.name AS post_name
       FROM console_notice n LEFT JOIN rpf_post p ON p.id = n.post_id
      WHERE ${where.join(' AND ')} ORDER BY n.id DESC LIMIT ${parseLimit(req.query.limit, 40, 500)}`, params);
  res.json(rows);
}));

/** POST /notices/read { ids? | entity + ref_id? }  - nothing given = all of the caller's zone(s). Opening the thing a notice is about clears it. */
router.post('/notices/read', wrap(async (req, res) => {
  const b = req.body || {};
  const params = [req.user.id];
  let extra = '';
  if (Array.isArray(b.ids)) { params.push(b.ids.map(Number).filter(Number.isInteger)); extra += ` AND n.id = ANY($${params.length})`; }
  if (b.entity && ['alert', 'incident', 'train_request', 'evidence_flag'].includes(b.entity) && Number.isInteger(Number(b.ref_id))) {
    params.push(b.entity, Number(b.ref_id)); extra += ` AND n.ref_entity = $${params.length - 1} AND n.ref_id = $${params.length}`;
  }
  const scope = zoneScope(req.user, 'n.zone_id', params, req.query.zone_id);
  const { rowCount } = await pool.query(`UPDATE console_notice n SET read_at = now(), read_by = $1 WHERE n.read_at IS NULL AND ${scope}${extra}`, params);
  res.json({ marked: rowCount });
}));

module.exports = router;
