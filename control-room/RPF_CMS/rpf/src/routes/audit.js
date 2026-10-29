const express = require('express');
const { pool } = require('../db');
const { parseLimit } = require('../services/util');
const { wrap } = require('../errors');

const router = express.Router();

/**
 * GET /api/audit?action=&limit= - the post's activity log (chain of custody): every sign-in, acknowledgement,
 * request, view, download and flag made by this post's officers, newest first. Read-only.
 */
router.get('/', wrap(async (req, res) => {
  const params = [req.user.post_id];
  let extra = '';
  if (req.query.action) { params.push(`${String(req.query.action)}%`); extra = `AND a.action LIKE $${params.length}`; }
  const limit = parseLimit(req.query.limit, 100, 500);
  const { rows } = await pool.query(
    `SELECT a.id, a.occurred_at, a.action, a.entity, a.entity_id, a.details, u.username AS actor_username
       FROM audit_log a JOIN users u ON u.id = a.actor_id
      WHERE u.post_id = $1 ${extra}
      ORDER BY a.id DESC LIMIT ${limit}`, params);
  res.json(rows);
}));

module.exports = router;
