const express = require('express');
const { pool } = require('../db');
const { notificationScope } = require('../services/scope');
const { parseLimit } = require('../services/util');
const { wrap } = require('../errors');

const router = express.Router();

/** GET /api/notifications?unread=1&limit= - notices CMS wrote for the caller's post (footage ready, request rejected, ...). */
router.get('/', wrap(async (req, res) => {
  const params = [];
  const where = [notificationScope(req.user, params)];
  if (req.query.unread === '1') where.push('n.read_at IS NULL');
  const { rows } = await pool.query(
    `SELECT n.id, n.kind, n.title, n.body, n.ref_entity, n.ref_id, n.created_at, n.read_at, p.name AS post_name
       FROM notification n LEFT JOIN rpf_post p ON p.id = n.post_id
      WHERE ${where.join(' AND ')} ORDER BY n.id DESC LIMIT ${parseLimit(req.query.limit, 30, 100)}`, params);
  res.json(rows);
}));

/** POST /api/notifications/read { ids? } - mark some (or all) of the post's notices read. */
router.post('/read', wrap(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
  const entity = ['evidence_flag', 'delivered_footage', 'video_request', 'incident', 'alert_delivery'].includes(req.body && req.body.entity) ? req.body.entity : null;
  const params = [req.user.post_id, req.user.id];
  let extra = '';
  if (ids) { params.push(ids); extra += ` AND id = ANY($${params.length})`; }
  if (entity) { params.push(entity); extra += ` AND ref_entity = $${params.length}`; }
  const { rowCount } = await pool.query(`UPDATE notification SET read_at = now(), read_by = $2 WHERE post_id = $1 AND read_at IS NULL${extra}`, params);
  res.json({ marked: rowCount });
}));

module.exports = router;
