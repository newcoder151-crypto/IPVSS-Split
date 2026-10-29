const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { pool } = require('../../db');
const live = require('../../services/live');
const { unauthorized, wrap } = require('../../errors');

/** Everything under /console/api: login is open, the rest needs a console session. */
const router = express.Router();
router.use('/auth', require('./auth'));
// Live stream: GET /stream?ticket=...  (ticket from POST /stream-ticket, because EventSource cannot send headers)
router.get('/stream', wrap(async (req, res) => {
  let p; try { p = live.readTicket(String(req.query.ticket || '')); } catch (_) { throw unauthorized('stream ticket expired - reconnect'); }
  const { rows } = await pool.query(`SELECT id, role, zone_id, status FROM users WHERE id = $1`, [p.sub]);
  if (!rows.length || rows[0].status !== 'active') throw unauthorized('account not active');
  live.attach(req, res, rows[0]);
}));
const api = express.Router();
api.use(requireAuth);
api.post('/stream-ticket', (req, res) => res.json({ ticket: live.issueTicket(req.user) }));
for (const m of ['dashboard', 'alerts', 'requests', 'evidence', 'fleet', 'admin', 'dev']) api.use('/', require(`./${m}`));
router.use('/', api);
module.exports = router;
