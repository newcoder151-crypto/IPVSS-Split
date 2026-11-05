const express = require('express');
const { pool } = require('../../db');
const { zoneScope, canSeeZone } = require('../../middleware/auth');
const trains = require('../../services/trainRequestService');
const { parseId, parseLimit, parseOffset, optText, where, whenFilter, searchFilter } = require('../../services/util');
const { notFound, wrap } = require('../../errors');

const router = express.Router();

// ---------------------------------------------------------------------------------------------
// Footage requests - ALWAYS by train number (RPF -> CMS). One request = every camera of every M-NVR unit of the train.
// ---------------------------------------------------------------------------------------------

/** GET /train-requests?tab=decide|waiting|done|all&status=&post_id=&train_no=&q= */
router.get('/requests', wrap(async (req, res) => {
  const w = where();
  w.raw(zoneScope(req.user, 't.zone_id', w.params, req.query.zone_id));
  const q = req.query;
  if (q.tab === 'decide') w.raw(`t.status = 'submitted'`);
  else if (q.tab === 'waiting') w.raw(`t.status IN ('approved','awaiting_upload')`);
  else if (q.tab === 'done') w.raw(`t.status IN ('fulfilled','partial','rejected','cancelled','failed','expired')`);
  if (q.status) w.add('t.status = ?', q.status);
  if (q.post_id) w.add('t.post_id = ?', Number(q.post_id));
  if (q.train_no) w.add('lower(btrim(t.train_no)) = lower(btrim(?))', String(q.train_no));
  whenFilter(w, q.when, 't.created_at');
  searchFilter(w, q.q, ['t.train_no', 't.reason', 'p.name', 'ur.username', 't.id']);
  const SORT = { new: 't.id DESC', old: 't.id ASC', attn: "(t.status = 'submitted') DESC, (t.status = 'awaiting_upload') DESC, t.id DESC", win: 't.window_start DESC' };
  const limit = parseLimit(q.limit, 50, 200); const offset = parseOffset(q.offset);
  const [rows, total] = await Promise.all([
    pool.query(`${trains.TR_SELECT} ${w.sql()} ORDER BY ${SORT[q.sort] || SORT.attn} LIMIT ${limit} OFFSET ${offset}`, w.params),
    pool.query(`SELECT COUNT(*) AS n FROM train_request t JOIN rpf_post p ON p.id = t.post_id JOIN users ur ON ur.id = t.requested_by ${w.sql()}`, w.params),
  ]);
  res.json({ rows: rows.rows, total: total.rows[0].n });
}));

router.get('/requests/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const t = await trains.load(null, id);
  if (!t || !canSeeZone(req.user, t.zone_id)) throw notFound('train request not found');
  const [cameras, units, cmds, history] = await Promise.all([
    trains.cameraRows(id),
    trains.trainOverview(t.train_no),
    pool.query(`SELECT m.id, m.kind, m.status, m.request_id, m.camera_id, m.nvr_id, m.created_at, m.sent_at, m.acked_at, m.completed_at, m.result
                  FROM nvr_command m WHERE m.train_request_id = $1 ORDER BY m.id`, [id]),
    pool.query(`SELECT a.occurred_at, a.action, a.details, u.username AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
                 WHERE a.entity = 'train_request' AND a.entity_id = $1 ORDER BY a.id`, [id]),
  ]);
  res.json({ request: t, units, cameras, commands: cmds.rows, history: history.rows });
}));

const trainAct = (name) => wrap(async (req, res) => res.json(await trains.decide(req.user, parseId(req.params.id), name, req.body || {})));
router.post('/requests/:id/approve', trainAct('approve'));
router.post('/requests/:id/amend', trainAct('amend'));
router.post('/requests/:id/reject', trainAct('reject'));
router.post('/requests/:id/cancel', wrap(async (req, res) => res.json(await trains.operatorCancel(req.user, parseId(req.params.id), optText(req.body && req.body.note, 300)))));
router.post('/requests/:id/retry-upload', wrap(async (req, res) => res.json(await trains.retryUpload(req.user, parseId(req.params.id)))));
router.post('/requests/:id/deliver-partial', wrap(async (req, res) => res.json(await trains.deliverPartial(req.user, parseId(req.params.id)))));

module.exports = router;
