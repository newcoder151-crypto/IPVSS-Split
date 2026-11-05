const express = require('express');
const { pool, withTransaction } = require('../db');
const { TRAIN_REQUEST_SELECT, OPEN_TRAIN_STATUSES, TRAIN_STATUSES, createTrainRequest, cameraProgress } = require('../services/trainRequests');
const { footageForTrainRequests } = require('../services/requests');
const { postScopeSql, canSeePost } = require('../services/scope');
const { audit } = require('../services/audit');
const { parseId, parseLimit } = require('../services/util');
const { badRequest, notFound, conflict, wrap } = require('../errors');

const router = express.Router();

/** GET /api/train-requests?status=open|<status>&train_no=&limit= */
router.get('/', wrap(async (req, res) => {
  const params = [];
  const where = [postScopeSql(req.user, 'p', params)];
  const { status, train_no: trainNo } = req.query;
  if (status === 'open') { params.push(OPEN_TRAIN_STATUSES); where.push(`t.status = ANY($${params.length})`); }
  else if (status) {
    if (!TRAIN_STATUSES.includes(status)) throw badRequest(`status must be 'open' or one of ${TRAIN_STATUSES.join(', ')}`);
    params.push(status); where.push(`t.status = $${params.length}`);
  }
  if (trainNo) { params.push(String(trainNo).trim()); where.push(`lower(btrim(t.train_no)) = lower($${params.length})`); }
  const { rows } = await pool.query(`${TRAIN_REQUEST_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT ${parseLimit(req.query.limit)}`, params);
  res.json(rows);
}));

/** One train request: the request, one row per camera (unit no. / camera no. / state / file) and every delivered file. */
router.get('/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query(`${TRAIN_REQUEST_SELECT} WHERE t.id = $1`, [id]);
  const t = rows[0];
  if (!t || !canSeePost(req.user, t.post_id, t.zone_id)) throw notFound('train request not found');
  const cameras = await cameraProgress(id);
  res.json({ request: t, cameras, footage: await footageForTrainRequests([id]) });
}));

/** POST /api/train-requests  { train_no, window_start, window_end, reason, incident_id?, alert_id? } */
router.post('/', wrap(async (req, res) => {
  const id = await withTransaction((client) => createTrainRequest(client, req.user, req.body || {}));
  res.status(201).json({ id, status: 'submitted' });
}));

/** POST /api/train-requests/:id/cancel - withdraws whatever has not been delivered yet (delivered files stay). */
router.post('/:id/cancel', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const status = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT id, post_id, status FROM train_request WHERE id = $1 FOR UPDATE`, [id]);
    const t = rows[0];
    if (!t || t.post_id !== req.user.post_id) throw notFound('train request not found');
    if (!OPEN_TRAIN_STATUSES.includes(t.status)) throw conflict(`request is '${t.status}' and can no longer be cancelled`);
    await client.query(`UPDATE video_request SET status = 'cancelled' WHERE train_request_id = $1 AND status IN ('approved','amended','awaiting_upload')`, [id]);
    const { rows: c } = await client.query(`SELECT COUNT(*) FILTER (WHERE status = 'fulfilled')::int AS ful FROM video_request WHERE train_request_id = $1`, [id]);
    const next = c[0].ful > 0 ? 'partial' : 'cancelled';
    await client.query(`UPDATE train_request SET status = $2, cameras_open = 0, updated_at = now() WHERE id = $1`, [id, next]);
    await audit(client, { user: req.user, action: 'train_request.cancel', entity: 'train_request', entityId: id, details: { from: t.status } });
    return next;
  });
  res.json({ id, status });
}));

module.exports = router;
