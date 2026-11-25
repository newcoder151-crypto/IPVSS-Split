'use strict';
const express = require('express');
const { pool, withTransaction } = require('../../db');
const config = require('../../config');
const cluster = require('../../services/cluster');
const { audit } = require('../../services/audit');
const { requireAdmin, requireSuper } = require('../../middleware/auth');
const { badRequest, notFound, conflict, wrap } = require('../../errors');

/**
 * The Cluster tab: which CMS exist, which are running, what each holds, and how they are connected.
 * Everybody who can sign in may LOOK; changing things needs an administrator (replication: the super administrator).
 */
const router = express.Router();

router.get('/cluster', wrap(async (req, res) => { res.json(await cluster.overview()); }));

/** Rename / relocate THIS CMS (a CMS writes only its own row of the registry, so nothing ever conflicts). */
router.patch('/cluster/self', requireAdmin, wrap(async (req, res) => {
  const me = await cluster.self({ fresh: true });
  if (!me) throw conflict('this CMS is not part of a cluster yet');
  const b = req.body || {};
  const name = b.name == null ? null : String(b.name).trim().slice(0, 80);
  if (name !== null && !name) throw badRequest('the name cannot be empty');
  if (b.role != null && !['active', 'standby'].includes(b.role)) throw badRequest('role must be active or standby');
  const url = b.url == null ? null : String(b.url).trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw badRequest('the address must look like http://10.1.2.3:7080');
  await withTransaction(async (c) => {
    await c.query(`UPDATE cms_node SET name = COALESCE($2, name), location = COALESCE($3, location), url = COALESCE($4, url), role = COALESCE($5, role) WHERE node_uuid = $1`,
      [me.node_uuid, name, b.location == null ? null : String(b.location).trim().slice(0, 120), url, b.role || null]);
    await audit(c, { user: req.user, action: 'cluster.edit', entity: 'cms_node', entityId: me.node_no, details: { name, location: b.location, url, role: b.role } });
  });
  await cluster.self({ fresh: true });
  res.json({ ok: true });
}));

/** Take a CMS out of the cluster list (for good: a CMS that was retired). Not this CMS. */
router.post('/cluster/nodes/:uuid/remove', requireAdmin, wrap(async (req, res) => {
  const me = await cluster.self();
  if (!me) throw conflict('this CMS is not part of a cluster yet');
  if (req.params.uuid === me.node_uuid) throw conflict('a CMS cannot remove itself - remove it from another CMS');
  const n = (await pool.query(`SELECT * FROM cms_node WHERE node_uuid = $1`, [req.params.uuid])).rows[0];
  if (!n) throw notFound('no such CMS');
  const alive = await cluster.isAlive(n.node_no);
  if (alive && !(req.body && req.body.force)) throw conflict(`"${n.name}" is online. Shut it down first, or confirm that you really want to remove a running CMS.`);
  await withTransaction(async (c) => {
    await c.query(`UPDATE cms_node SET removed_at = now() WHERE node_uuid = $1`, [n.node_uuid]);
    await audit(c, { user: req.user, action: 'cluster.remove', entity: 'cms_node', entityId: n.node_no, details: { name: n.name, location: n.location } });
  });
  await cluster.event('remove', n.node_no, `${n.name} was removed from the cluster by ${req.user.username}`);
  res.json({ ok: true });
}));
router.post('/cluster/nodes/:uuid/restore', requireAdmin, wrap(async (req, res) => {
  await pool.query(`UPDATE cms_node SET removed_at = NULL WHERE node_uuid = $1`, [req.params.uuid]);
  res.json({ ok: true });
}));

/** Ask every other CMS "are you there?" right now. */
router.post('/cluster/probe', wrap(async (req, res) => { await cluster.probe(); res.json(await cluster.overview()); }));

/** What an administrator needs to add another computer to the cluster. */
router.get('/cluster/join-info', requireAdmin, wrap(async (req, res) => {
  const me = await cluster.self();
  if (!me) throw conflict('this CMS is not part of a cluster yet: run  node scripts/cluster.js create  on this computer first');
  res.json({ cluster_id: me.cluster_id, seed_url: me.url, secret_set: !!cluster.secret(), secret: req.user.role === 'super_admin' ? cluster.secret() : null });
}));

/** Connect THIS CMS's database to another CMS's database (one direction; the other CMS does the same towards this one). */
router.post('/cluster/replication/subscribe', requireSuper, wrap(async (req, res) => {
  const b = req.body || {};
  const peer = (await pool.query(`SELECT * FROM cms_node WHERE node_uuid = $1`, [b.node_uuid])).rows[0];
  if (!peer) throw notFound('choose the CMS to receive data from');
  for (const k of ['host', 'dbname', 'user', 'password']) if (!b[k]) throw badRequest(`${k} of the other CMS database is required`);
  const port = Number(b.port || 5432);
  if (!Number.isInteger(port)) throw badRequest('bad port');
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const conn = `host=${esc(b.host)} port=${port} dbname=${esc(b.dbname)} user=${esc(b.user)} password=${esc(b.password)}`;
  const subname = `cms_sub_n${peer.node_no}`;
  const copy = b.copy_data === true;
  try {
    const c = await pool.connect();
    try {
      // CREATE SUBSCRIPTION cannot run inside a transaction block
      await c.query(`CREATE SUBSCRIPTION ${subname} CONNECTION '${conn.replace(/'/g, "''")}' PUBLICATION cms_pub WITH (origin = none, copy_data = ${copy}, slot_name = '${subname}_${(await cluster.self()).node_no}')`);
    } finally { c.release(); }
  } catch (e) { throw conflict(`could not connect to "${peer.name}": ${e.message}`); }
  await audit(null, { user: req.user, action: 'cluster.subscribe', entity: 'cms_node', entityId: peer.node_no, details: { subscription: subname, copy_data: copy, host: b.host } });
  await cluster.event('replication', peer.node_no, `${req.user.username} connected to the database of ${peer.name} (${copy ? 'with an initial copy' : 'new changes only'})`);
  res.status(201).json({ ok: true, subscription: subname });
}));
router.post('/cluster/replication/:subname/drop', requireSuper, wrap(async (req, res) => {
  const sub = String(req.params.subname);
  if (!/^cms_sub_[a-z0-9_]+$/.test(sub)) throw badRequest('not a CMS subscription');
  const c = await pool.connect();
  try { await c.query(`ALTER SUBSCRIPTION ${sub} DISABLE`); await c.query(`ALTER SUBSCRIPTION ${sub} SET (slot_name = NONE)`); await c.query(`DROP SUBSCRIPTION ${sub}`); } catch (e) { throw conflict(e.message); } finally { c.release(); }
  await audit(null, { user: req.user, action: 'cluster.unsubscribe', entity: 'cms_node', entityId: 0, details: { subscription: sub } });
  res.json({ ok: true });
}));

module.exports = router;
