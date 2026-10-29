/**
 * TEST LAB (development only; DEV_TOOLS=0 or NODE_ENV=production switches it off).
 * Lets a person stand in for the train's VMS/M-NVR from the console:
 *   - send an alert through the SAME ingest code the real NVR endpoint uses (priority routing, auto-dispatch, incident)
 *   - put a simulated unit "in a tunnel" (the M-NVR simulator stops contacting CMS) and bring it back
 * Everything it does is audited as dev.* so it is never mistaken for real traffic.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../../db');
const config = require('../../config');
const { zoneScope, canSeeZone } = require('../../middleware/auth');
const settings = require('../../services/settings');
const { ingestAlert } = require('../../services/alertService');
const { audit } = require('../../services/audit');
const { parseId, num, requireText } = require('../../services/util');
const { badRequest, notFound, wrap } = require('../../errors');

const router = express.Router();
router.use('/dev', (req, res, next) => (config.devTools ? next() : next(notFound('test lab is disabled'))));

const unitNumber = (name) => { const m = String(name).match(/(\d+)\s*$/); return m ? Number(m[1]) : null; };
const flagFile = (n) => path.join(config.simDir, `mnvr-offline-${n}`);

router.get('/dev/state', wrap(async (req, res) => {
  const cfg = await settings.all();
  const p = [cfg.nvr_offline_after_s];
  const nvrs = (await pool.query(
    `SELECT n.id, n.name, n.train_no, n.status, n.current_zone_id AS zone_id, z.name AS zone_name, n.last_seen, n.last_lat AS lat, n.last_lon AS lon,
            (n.last_seen > now() - make_interval(secs => $1)) AS online,
            COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'mount_position', c.mount_position) ORDER BY c.id) FROM camera c WHERE c.nvr_id = n.id AND c.active), '[]') AS cameras
       FROM nvr_unit n LEFT JOIN zone z ON z.id = n.current_zone_id WHERE ${zoneScope(req.user, 'n.current_zone_id', p)} ORDER BY n.name`, p)).rows;
  const q = [];
  const posts = (await pool.query(
    `SELECT po.id, po.name, po.zone_id, ST_Y(po.location::geometry) AS lat, ST_X(po.location::geometry) AS lon FROM rpf_post po WHERE po.active AND ${zoneScope(req.user, 'po.zone_id', q)} ORDER BY po.name`, q)).rows;
  for (const n of nvrs) { const u = unitNumber(n.name); n.sim_number = u; n.sim_offline = u != null && fs.existsSync(flagFile(u)); }
  res.json({ threshold: cfg.priority_threshold, low_mode: cfg.low_priority_mode, nvrs, posts, sim_dir: config.simDir });
}));

/** POST /dev/alert { nvr_id, camera_id?, alert_type, priority, near_post_id? | lat+lon } */
router.post('/dev/alert', wrap(async (req, res) => {
  const b = req.body || {};
  const nvrId = parseId(b.nvr_id, 'nvr_id');
  const { rows } = await pool.query(`SELECT id, name, current_zone_id AS zone_id, status, last_lat, last_lon FROM nvr_unit WHERE id = $1`, [nvrId]);
  const n = rows[0];
  if (!n || !canSeeZone(req.user, n.zone_id)) throw notFound('NVR not found');
  const type = requireText(b.alert_type, 'alert_type', 60).toLowerCase().replace(/\s+/g, '_');
  const priority = num(b.priority, 'priority', { min: 1, max: 10 });

  let lat; let lon; let where;
  if (b.near_post_id) {
    const { rows: pr } = await pool.query(`SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon, name FROM rpf_post WHERE id = $1 AND zone_id = $2`, [parseId(b.near_post_id, 'near_post_id'), n.zone_id]);
    if (!pr.length) throw badRequest('that post is not in the unit\'s zone');
    lat = pr[0].lat + 0.001; lon = pr[0].lon + 0.001; where = `next to ${pr[0].name}`;
  } else if (b.lat !== undefined && b.lat !== '' && b.lon !== undefined && b.lon !== '') {
    lat = num(b.lat, 'lat', { min: -90, max: 90 }); lon = num(b.lon, 'lon', { min: -180, max: 180 }); where = 'custom position';
  } else if (n.last_lat != null) { lat = n.last_lat; lon = n.last_lon; where = "the train's last reported position"; }
  else throw badRequest('this unit has never reported a position - choose "next to a post" or enter lat/lon');

  const result = await ingestAlert({ id: n.id, name: n.name, zone_id: n.zone_id }, {
    nvr_event_id: `lab-${crypto.randomUUID()}`, alert_type: type, priority, lat, lon, event_time: new Date().toISOString(),
    camera_id: b.camera_id ? parseId(b.camera_id, 'camera_id') : undefined, fix_quality: 'lab', fix_age_s: 0,
  });
  await audit(null, { user: req.user, action: 'dev.alert', entity: 'alert', entityId: result.alert.id, zoneId: n.zone_id, details: { nvr: n.name, type, priority, where } });
  let post = null;
  if (result.dispatched) post = (await pool.query('SELECT name FROM rpf_post WHERE id = $1', [result.postId])).rows[0] || null;
  res.status(201).json({ ...result, where, post_name: post && post.name, unit: n.name });
}));

/** POST /dev/nvr/:id/offline { offline } - the simulator checks CMS/run/mnvr-offline-N every few seconds. */
router.post('/dev/nvr/:id/offline', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, current_zone_id AS zone_id FROM nvr_unit WHERE id = $1', [parseId(req.params.id)]);
  const n = rows[0];
  if (!n || !canSeeZone(req.user, n.zone_id)) throw notFound('NVR not found');
  const u = unitNumber(n.name);
  if (u == null) throw badRequest(`cannot tell which simulator unit '${n.name}' is (its name must end in a number, e.g. nvr-1)`);
  const off = !!(req.body && req.body.offline);
  fs.mkdirSync(config.simDir, { recursive: true });
  if (off) fs.writeFileSync(flagFile(u), 'offline'); else fs.rmSync(flagFile(u), { force: true });
  await audit(null, { user: req.user, action: off ? 'dev.nvr_offline' : 'dev.nvr_online', entity: 'nvr_unit', entityId: n.id, zoneId: n.zone_id });
  res.json({ ok: true, offline: off });
}));

module.exports = router;
