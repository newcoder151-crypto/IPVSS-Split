const express = require('express');
const { pool } = require('../../db');
const { zoneScope, canSeeZone } = require('../../middleware/auth');
const reqs = require('../../services/requestService');
const { coverage } = require('../../services/segmentService');
const { parseId, parseLimit, parseOffset, optText, where, whenFilter, searchFilter } = require('../../services/util');
const { notFound, wrap } = require('../../errors');

const router = express.Router();

/** GET /requests?tab=decide|waiting|done|all&status=&post_id=&camera_id= */
router.get('/requests', wrap(async (req, res) => {
  const w = where();
  w.raw(zoneScope(req.user, 'p.zone_id', w.params, req.query.zone_id));
  const q = req.query;
  if (q.tab === 'decide') w.raw(`r.status = 'submitted'`);
  else if (q.tab === 'waiting') w.raw(`r.status IN ('approved','amended','awaiting_upload')`);
  else if (q.tab === 'done') w.raw(`r.status IN ('fulfilled','rejected','cancelled','failed','expired')`);
  if (q.status) w.add('r.status = ?::request_status', q.status);
  if (q.post_id) w.add('r.post_id = ?', Number(q.post_id));
  if (q.camera_id) w.add('r.camera_id = ?', Number(q.camera_id));
  whenFilter(w, q.when, 'r.created_at');
  searchFilter(w, q.q, ['r.reason', 'c.name', 'n.name', 'n.train_no', 'p.name', 'ur.username', 'r.id']);
  const REQ_SORT = { new: 'r.id DESC', old: 'r.id ASC', attn: "(r.status = 'submitted') DESC, (r.status = 'awaiting_upload') DESC, r.id DESC", win: 'r.window_start DESC' };
  const limit = parseLimit(q.limit, 50, 200); const offset = parseOffset(q.offset);
  const [rows, total] = await Promise.all([
    pool.query(`${reqs.REQUEST_SELECT} ${w.sql()} ORDER BY ${REQ_SORT[q.sort] || REQ_SORT.attn} LIMIT ${limit} OFFSET ${offset}`, w.params),
    pool.query(`SELECT COUNT(*) AS n FROM video_request r JOIN rpf_post p ON p.id = r.post_id JOIN camera c ON c.id = r.camera_id JOIN nvr_unit n ON n.id = c.nvr_id JOIN users ur ON ur.id = r.requested_by ${w.sql()}`, w.params),
  ]);
  res.json({ rows: rows.rows, total: total.rows[0].n });
}));

router.get('/requests/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const r = await reqs.loadRequest(null, id);
  if (!r || !canSeeZone(req.user, r.zone_id)) throw notFound('request not found');
  const [cov, footage, cmds, history] = await Promise.all([
    coverage(r.camera_id, r.window_start, r.window_end),
    pool.query(`SELECT id, format, file_size_bytes, sha256, duration_s, start_time, end_time, segment_count, delivered_at FROM delivered_footage WHERE video_request_id = $1 ORDER BY id`, [id]),
    pool.query(`SELECT id, kind, status, created_at, sent_at, acked_at, completed_at, result FROM nvr_command WHERE request_id = $1 ORDER BY id`, [id]),
    pool.query(`SELECT a.occurred_at, a.action, a.details, u.username AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.entity = 'video_request' AND a.entity_id = $1 ORDER BY a.id`, [id]),
  ]);
  res.json({
    request: r,
    coverage: { covered: cov.covered, gaps: cov.gaps, segments: cov.segments.length, pending: cov.pending.length,
      seconds_have: cov.segments.reduce((a, s) => a + (new Date(s.end_time) - new Date(s.start_time)) / 1000, 0) },
    footage: footage.rows, commands: cmds.rows, history: history.rows,
  });
}));

const act = (name) => wrap(async (req, res) => {
  const r = await reqs.decide(req.user, parseId(req.params.id), name, req.body || {});
  res.json(r);
});
router.post('/requests/:id/approve', act('approve'));
router.post('/requests/:id/amend', act('amend'));
router.post('/requests/:id/reject', act('reject'));
router.post('/requests/:id/cancel', wrap(async (req, res) => res.json(await reqs.operatorCancel(req.user, parseId(req.params.id), optText(req.body && req.body.note, 300)))));
router.post('/requests/:id/retry-upload', wrap(async (req, res) => res.json(await reqs.reissueUpload(req.user, parseId(req.params.id)))));
router.post('/requests/:id/deliver-partial', wrap(async (req, res) => res.json(await reqs.forceDeliver(req.user, parseId(req.params.id)))));

module.exports = router;
