'use strict';
const express = require('express');
const fs = require('fs');
const { pool } = require('../db');
const config = require('../config');
const cluster = require('../services/cluster');
const { serveFile } = require('../services/mediaServe');
const { absPath, exists, mimeFor } = require('../services/fsutil');
const { notFound, badRequest, wrap } = require('../errors');

/**
 * CMS <-> CMS. Mounted at /cluster (not under /console: browsers never call these).
 *   GET  /cluster/health                    anybody (a CMS asks "are you there?"): who I am, nothing secret
 *   GET  /cluster/internal/media/:kind/:id  signed: the bytes of a recording that is on MY disk (footage | evidence), with Range
 *   GET  /cluster/internal/info             signed: what data range I hold (a joining CMS needs it to prepare its partitions)
 *   POST /cluster/internal/join             signed: give a joining CMS its node number
 */
const router = express.Router();

router.get('/health', wrap(async (req, res) => {
  const me = await cluster.self();
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, clustered: !!me, cluster_id: me && me.cluster_id, node_uuid: me && me.node_uuid, node_no: me && me.node_no, name: me && me.name, version: config.version, time: new Date().toISOString() });
}));

const internal = express.Router();
internal.use(cluster.requireCluster);

/** What do I know about this recording (the file path, the checksum, which CMS made it)? */
async function describe(kind, id) {
  if (kind === 'footage') {
    const { rows } = await pool.query(`SELECT id, storage_path AS rel, format, sha256, file_name FROM delivered_footage WHERE id = $1`, [id]);
    return rows[0] && { rel: rows[0].rel, mime: mimeFor(rows[0].format), sha256: rows[0].sha256, filename: rows[0].file_name, holder: id };
  }
  if (kind === 'evidence') {
    const { rows } = await pool.query(`SELECT footage_id, archive_path AS rel, archive_sha256 AS sha256 FROM evidence_flag WHERE id = $1 AND archive_status = 'archived'`, [id]);
    return rows[0] && { rel: rows[0].rel, mime: 'video/mp4', sha256: rows[0].sha256, filename: `evidence-${id}.mp4`, holder: rows[0].footage_id };
  }
  throw badRequest('unknown kind');
}
/** Serve it from my disk; if it is on ANOTHER CMS (and this request was not already forwarded) pass the request on to that CMS. */
async function serve(req, res, kind, id, rec) {
  if (!rec || !rec.rel) throw notFound('no such recording');
  const file = absPath(rec.rel);
  if (exists(file)) return serveFile(req, res, { file, size: fs.statSync(file).size, mime: rec.mime, sha256: rec.sha256, filename: rec.filename });
  const me = await cluster.self();
  if (me && !req.get('x-cluster-hop') && cluster.nodeOfId(rec.holder) !== me.node_no) {
    try { return await cluster.proxyMedia(req, res, cluster.nodeOfId(rec.holder), kind, id, { hop: true }); } catch (e) { const { HttpError } = require('../errors'); throw new HttpError(e.status || 502, e.message); }
  }
  throw notFound('that recording is not on this CMS');
}

internal.get('/media/:kind/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('bad id');
  await serve(req, res, req.params.kind, id, await describe(req.params.kind, id));
}));

/** A post only knows the file path of a recording. Look it up (the path must belong to a recording the database knows). */
internal.get('/media-by-path', wrap(async (req, res) => {
  const p = String(req.query.p || '');
  if (!p || p.includes('..')) throw badRequest('bad path');
  const f = (await pool.query(`SELECT id FROM delivered_footage WHERE storage_path = $1 LIMIT 1`, [p])).rows[0];
  if (f) return serve(req, res, 'footage', f.id, await describe('footage', f.id));
  const e = (await pool.query(`SELECT id FROM evidence_flag WHERE archive_path = $1 AND archive_status = 'archived' LIMIT 1`, [p])).rows[0];
  if (e) return serve(req, res, 'evidence', e.id, await describe('evidence', e.id));
  throw notFound('no recording has that path');
}));

internal.get('/info', wrap(async (req, res) => {
  const a = (await pool.query(`SELECT min(event_time) AS first, max(event_time) AS last FROM alert`)).rows[0];
  const g = (await pool.query(`SELECT min(recorded_at) AS first, max(recorded_at) AS last FROM gps_point`).catch(() => ({ rows: [{}] }))).rows[0];
  const me = await cluster.self();
  res.json({ cluster_id: me.cluster_id, alert_first: a.first, alert_last: a.last, gps_first: g.first, gps_last: g.last });
}));

internal.post('/join', express.json(), wrap(async (req, res) => {
  const { name, location, url, node_uuid } = req.body || {};
  if (!name || !node_uuid) throw badRequest('name and node_uuid are required');
  res.json(await cluster.allocateNode({ name: String(name).slice(0, 80), location: location && String(location).slice(0, 120), url: url && String(url).slice(0, 200), node_uuid }));
}));

router.use('/internal', internal);
module.exports = router;
