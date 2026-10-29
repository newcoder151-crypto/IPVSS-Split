const express = require('express');
const { pool, withTransaction } = require('../db');
const { REQUEST_SELECT, OPEN_STATUSES, createRequest, footageForRequests } = require('../services/requests');
const { postScopeSql, canSeePost } = require('../services/scope');
const { audit } = require('../services/audit');
const { parseId, parseLimit } = require('../services/util');
const { badRequest, notFound, conflict, wrap } = require('../errors');

const router = express.Router();
const STATUSES = ['submitted', 'approved', 'rejected', 'amended', 'awaiting_upload', 'fulfilled', 'cancelled', 'failed', 'expired'];

/** GET /api/requests?status=&limit= (also serves the admin cross-post view, by role scope). */
router.get('/', wrap(async (req, res) => {
  const params = [];
  const where = [postScopeSql(req.user, 'p', params)];
  const { status } = req.query;
  if (status === 'open') {
    params.push(OPEN_STATUSES);
    where.push(`r.status = ANY($${params.length})`);
  } else if (status) {
    if (!STATUSES.includes(status)) throw badRequest(`status must be 'open' or one of ${STATUSES.join(', ')}`);
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  const limit = parseLimit(req.query.limit);
  const { rows } = await pool.query(`${REQUEST_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ${limit}`, params);
  res.json(rows);
}));

router.get('/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
  const r = rows[0];
  if (!r || !canSeePost(req.user, r.post_id, r.zone_id)) throw notFound('request not found');
  res.json({ request: r, footage: await footageForRequests([id]) });
}));

/** POST /api/requests - request footage for any camera in the zone (alert_id optional). */
router.post('/', wrap(async (req, res) => {
  const id = await withTransaction((client) => createRequest(client, req.user, req.body || {}));
  res.status(201).json({ id, status: 'submitted' });
}));

/** POST /api/requests/:id/cancel - withdraw a request CMS has not yet fulfilled. */
router.post('/:id/cancel', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT id, post_id, status FROM video_request WHERE id = $1 FOR UPDATE`, [id]);
    const r = rows[0];
    if (!r || r.post_id !== req.user.post_id) throw notFound('request not found');
    if (!OPEN_STATUSES.includes(r.status)) throw conflict(`request is '${r.status}' and can no longer be cancelled`);
    await client.query(`UPDATE video_request SET status = 'cancelled' WHERE id = $1`, [id]);
    await audit(client, { user: req.user, action: 'request.cancel', entity: 'video_request', entityId: id, details: { from: r.status } });
  });
  res.json({ id, status: 'cancelled' });
}));

module.exports = router;
