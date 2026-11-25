#!/usr/bin/env node
'use strict';
/**
 * Put CMS computers into a cluster (N+1 redundancy, several locations).
 *
 *   node scripts/cluster.js create --name "Delhi CMS" --location "Delhi" --url http://10.1.1.10:7080
 *       The FIRST CMS of a new cluster (the one that already holds your data). It becomes node 1. Prints the cluster secret.
 *
 *   node scripts/cluster.js join --seed http://10.1.1.10:7080 --seed-db "host=10.1.1.10 port=5432 dbname=cms user=cms_repl password=..."
 *                                --name "Lucknow CMS" --location "Lucknow" --url http://10.2.2.20:7080
 *                                --my-db "host=10.2.2.20 port=5432 dbname=cms user=cms_repl password=..."
 *                                [--seed-admin-db "host=10.1.1.10 ... user=cms password=..."]
 *       A NEW computer (empty database, schema only) joins through any running CMS ("seed"): gets its node number and its own range of ids,
 *       copies everything the cluster holds, and is connected in both directions. --seed-admin-db (an account that may CREATE SUBSCRIPTION on
 *       the seed) lets this command also make the seed receive from the new CMS; without it the SQL for that is printed.
 *
 *   node scripts/cluster.js peer --node 3 --db "host=... user=cms_repl ..." [--admin-db "host=... user=cms ..."]
 *       Link THIS database with another CMS's database (every CMS must be linked to every other CMS: a mesh).
 *
 *   node scripts/cluster.js status
 *
 * Environment: the same as the CMS (DB_HOST, DB_NAME, ...). CMS_CLUSTER_SECRET must be the cluster secret (join) - `create` makes it.
 */
const crypto = require('crypto');
const { Client } = require('pg');
const { pool } = require('../src/db');
const cluster = require('../src/services/cluster');

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const need = (k) => { const v = opt(k); if (!v) { console.error(`missing --${k}`); process.exit(2); } return v; };
const say = (m) => console.log(m);
const parseConn = (s) => { const o = {}; for (const m of s.matchAll(/(\w+)=('([^']*)'|\S+)/g)) o[m[1]] = m[3] !== undefined ? m[3] : m[2]; return o; };
const clientFor = (conn) => { const o = parseConn(conn); return new Client({ host: o.host, port: Number(o.port || 5432), database: o.dbname, user: o.user, password: o.password }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function subscribeHere(client, { subname, conninfo, copy }) {
  await client.query(`CREATE SUBSCRIPTION ${subname} CONNECTION '${conninfo.replace(/'/g, "''")}' PUBLICATION cms_pub WITH (origin = none, copy_data = ${copy ? 'true' : 'false'}, slot_name = '${subname}')`);
}

async function waitSynced(subname) {
  for (let i = 0; i < 600; i++) {
    const { rows } = await pool.query(`SELECT count(*) FILTER (WHERE r.srsubstate <> 'r')::int AS pending, count(*)::int AS total FROM pg_subscription s JOIN pg_subscription_rel r ON r.srsubid = s.oid WHERE s.subname = $1`, [subname]);
    if (rows[0].total > 0 && rows[0].pending === 0) return rows[0].total;
    if (i % 5 === 0) say(`   copying... ${rows[0].total - rows[0].pending} of ${rows[0].total} tables`);
    await sleep(2000);
  }
  throw new Error('the initial copy did not finish in 20 minutes - check the PostgreSQL log');
}

async function main() {
  if (cmd === 'create') {
    const me = await cluster.createCluster({ name: need('name'), location: opt('location'), url: opt('url') });
    say(`\nThis computer is now node ${me.node_no} of cluster ${me.cluster_id}.`);
    say(`\nCluster secret (every CMS needs it as CMS_CLUSTER_SECRET in its .env; keep it private):\n  ${cluster.secret()}`);
    say(`\nNext: on the PostgreSQL of every computer run  cluster/prepare-db.sh  (wal_level=logical, a replication account), then on each new computer:\n  node scripts/cluster.js join --seed ${opt('url', '<this CMS URL>')} ...`);
  } else if (cmd === 'join') {
    if (await cluster.self({ fresh: true })) throw new Error('this CMS is already in a cluster');
    const { rows: u } = await pool.query(`SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM alert)::int AS alerts`);
    if (u[0].users || u[0].alerts) throw new Error('this database already holds data. A CMS that joins must start with an EMPTY database (schema only), otherwise its ids would collide.');
    const seed = need('seed').replace(/\/+$/, ''); const seedDb = need('seed-db'); const myDb = need('my-db');
    const secret = cluster.secret(); if (!secret) throw new Error('set CMS_CLUSTER_SECRET to the secret printed by `create` on the first CMS');
    // the same name + address always gives the same identity, so running `join` again after a failure re-uses the node number
    const h = crypto.createHash('sha1').update(`${opt('name')}|${opt('url')}|${myDb}`).digest('hex');
    const nodeUuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    const name = need('name'); const location = opt('location'); const url = opt('url');
    const sign = (method, p) => { const ts = Date.now(); return { 'X-Cluster-Node': nodeUuid, 'X-Cluster-Ts': String(ts), 'X-Cluster-Sig': crypto.createHmac('sha256', secret).update(`${nodeUuid}.${ts}.${method}.${p}`).digest('hex'), 'Content-Type': 'application/json' }; };
    say(`1/6 asking ${seed} for a node number...`);
    let r = await fetch(`${seed}/cluster/internal/join`, { method: 'POST', headers: sign('POST', '/cluster/internal/join'), body: JSON.stringify({ name, location, url, node_uuid: nodeUuid }) });
    if (!r.ok) throw new Error(`the seed refused: HTTP ${r.status} ${await r.text()}`);
    const j = await r.json();
    say(`    you are node ${j.node_no} of cluster ${j.cluster_id}`);
    say('2/6 preparing this database (own range of ids, places for the older alerts)...');
    r = await fetch(`${seed}/cluster/internal/info`, { headers: sign('GET', '/cluster/internal/info') });
    const info = r.ok ? await r.json() : {};
    {
      const tx = await pool.connect();
      try { // all or nothing: a failure here must not leave a half-joined database behind
        await tx.query('BEGIN');
        await tx.query(`INSERT INTO cms_cluster_config (id, cluster_id, node_uuid, node_no) VALUES (1, $1, $2, $3)`, [j.cluster_id, nodeUuid, j.node_no]);
        await tx.query(`SELECT cms_assign_id_space($1)`, [j.node_no]);
        await tx.query('COMMIT');
      } catch (e) { await tx.query('ROLLBACK'); throw e; } finally { tx.release(); }
    }
    const first = [info.alert_first, info.gps_first].filter(Boolean).map((d) => new Date(d)).sort((a, b) => a - b)[0] || new Date();
    await pool.query(`SELECT ensure_partitions_between($1::date, (now() + interval '4 months')::date)`, [first.toISOString().slice(0, 10)]);
    await pool.query(`SELECT cms_refresh_publication()`); await pool.query(`SELECT cms_enable_live_triggers()`);
    say('3/6 copying everything the cluster holds from the seed (this can take a while)...');
    const seedSub = `cms_sub_n${new URL(seed).port || 'seed'}_${j.node_no}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const c = await pool.connect();
    try { await subscribeHere(c, { subname: seedSub, conninfo: seedDb, copy: true }); } finally { c.release(); }
    const total = await waitSynced(seedSub);
    say(`    ${total} tables copied`);
    cluster.event && await cluster.event('join', j.node_no, `joined the cluster through ${seed}`);
    say('4/6 making the seed receive from this CMS too...');
    const rev = `CREATE SUBSCRIPTION cms_sub_from_n${j.node_no} CONNECTION '${myDb.replace(/'/g, "''")}' PUBLICATION cms_pub WITH (origin = none, copy_data = false, slot_name = 'cms_sub_from_n${j.node_no}');`;
    const adm = opt('seed-admin-db');
    if (adm) { const sc = clientFor(adm); await sc.connect(); try { await sc.query(rev); say('    done'); } finally { await sc.end(); } } else say(`    run this on the SEED database (as a superuser):\n    ${rev}`);
    say('5/6 node registry:'); for (const n of await cluster.nodes()) say(`    node ${n.node_no}: ${n.name}${n.location ? ` (${n.location})` : ''} ${n.url || ''}`);
    say(`6/6 done. Put these in this CMS's .env and start it:\n    CMS_CLUSTER_SECRET=${secret}\n    CMS_NODE_NAME="${name}"\n    CMS_NODE_LOCATION="${location || ''}"\n    CMS_PUBLIC_URL=${url || ''}\n  With more than two CMS, also link this CMS to the others:  node scripts/cluster.js peer --node <number> --db "<their replication connection>"`);
  } else if (cmd === 'peer') {
    const me = await cluster.self({ fresh: true }); if (!me) throw new Error('this CMS is not in a cluster');
    const no = Number(need('node')); const db = need('db');
    const subname = `cms_sub_n${no}`;
    const c = await pool.connect(); try { await subscribeHere(c, { subname, conninfo: db, copy: false }); } finally { c.release(); }
    say(`this database now receives the changes of node ${no}.`);
    const rev = `CREATE SUBSCRIPTION cms_sub_n${me.node_no} CONNECTION '<connection to THIS database>' PUBLICATION cms_pub WITH (origin = none, copy_data = false, slot_name = 'cms_sub_n${me.node_no}');`;
    const adm = opt('admin-db');
    if (adm && opt('my-db')) { const pc = clientFor(adm); await pc.connect(); try { await pc.query(rev.replace('<connection to THIS database>', opt('my-db').replace(/'/g, "''"))); say(`node ${no} now receives from this database too.`); } finally { await pc.end(); } } else say(`the other CMS must receive from this one too - on ITS database run:\n  ${rev}`);
  } else if (cmd === 'status') {
    const o = await cluster.overview();
    if (!o.clustered) say('this CMS is not part of a cluster');
    else { say(`cluster ${o.cluster_id} - ${o.summary.online}/${o.summary.nodes} CMS online${o.summary.redundant ? ' (N+1: yes)' : ' (N+1: NO - only one CMS is running)'}`); for (const n of o.nodes) say(`  node ${n.node_no} ${n.is_me ? '(this) ' : ''}${n.name} - ${n.status}${n.location ? ` - ${n.location}` : ''} ${n.url || ''}`); for (const s of o.replication.subscriptions) say(`  receives from ${s.subname}: ${s.pid ? 'running' : 'NOT running'}${s.errors ? `, ${s.errors} errors` : ''}`); }
  } else {
    say('usage: node scripts/cluster.js create | join | peer | status   (see the top of this file)');
    process.exitCode = 1;
  }
}
main().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exitCode = 1; }).finally(() => pool.end().catch(() => {}));
