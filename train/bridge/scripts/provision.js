#!/usr/bin/env node
/**
 * Registers this M-NVR (and its cameras) in the CMS registry, so the CMS knows the unit and routes its alerts.
 * It only writes DATA (nvr_unit, nvr_zone_assignment, camera rows) - the same rows the CMS console's
 * "Zones & posts / M-NVR fleet" pages create. No CMS code is touched. Safe to re-run: it adds what is missing.
 *
 *   node scripts/provision.js --name TRAIN-12301-NVR --zone "Zone 1" [--fingerprint <cert fp>] [--train-no "12301 Rajdhani"]
 *
 * Environment (or bridge/.env):  MNVR_DB_*  (the M-NVR database, to read its cameras)
 *                                CMS_DB_HOST/PORT/NAME/USER/PASSWORD  (the CMS database; defaults host localhost, db/user cms)
 */
const crypto = require('crypto');
const { Pool } = require('pg');
require('../src/config'); // loads .env
const mnvr = require('../src/mnvrDb');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const e = process.env;

(async () => {
  const name = arg('name'); const zoneName = arg('zone');
  if (!name || !zoneName) { console.error('usage: node scripts/provision.js --name <unit name> --zone "<zone name>" [--fingerprint <fp>] [--train-no <no>]'); process.exit(2); }
  const cmsDb = new Pool({ host: e.CMS_DB_HOST || 'localhost', port: Number(e.CMS_DB_PORT || 5432), database: e.CMS_DB_NAME || 'cms', user: e.CMS_DB_USER || 'cms', password: e.CMS_DB_PASSWORD || '' });
  try {
    const { rows: z } = await cmsDb.query('SELECT id FROM zone WHERE name = $1', [zoneName]);
    if (!z.length) { const all = (await cmsDb.query('SELECT name FROM zone ORDER BY name')).rows.map((r) => r.name).join(', '); throw new Error(`zone '${zoneName}' not found in CMS (have: ${all || 'none'})`); }
    const zoneId = z[0].id;
    const info = await mnvr.deviceInfo();
    const trainNo = arg('train-no', info.train_number || null);

    let fp = arg('fingerprint');
    const { rows: ex } = await cmsDb.query('SELECT id, cert_fingerprint FROM nvr_unit WHERE name = $1', [name]);
    let nvrId;
    if (ex.length) {
      nvrId = ex[0].id; fp = fp || ex[0].cert_fingerprint;
      if (fp !== ex[0].cert_fingerprint) await cmsDb.query('UPDATE nvr_unit SET cert_fingerprint = $2 WHERE id = $1', [nvrId, fp]);
      console.log(`unit '${name}' already registered (#${nvrId})`);
    } else {
      fp = fp || `fp-${crypto.randomBytes(16).toString('hex')}`;
      nvrId = (await cmsDb.query(`INSERT INTO nvr_unit (name, cert_fingerprint, current_zone_id) VALUES ($1,$2,$3) RETURNING id`, [name, fp, zoneId])).rows[0].id;
      console.log(`registered unit '${name}' (#${nvrId}) in ${zoneName}`);
    }
    if (trainNo) await cmsDb.query(`UPDATE nvr_unit SET train_no = $2 WHERE id = $1`, [nvrId, trainNo]).catch(() => {});
    const { rows: open } = await cmsDb.query('SELECT 1 FROM nvr_zone_assignment WHERE nvr_id = $1 AND assigned_until IS NULL', [nvrId]);
    if (!open.length) await cmsDb.query(`INSERT INTO nvr_zone_assignment (nvr_id, zone_id, assigned_from) VALUES ($1,$2, now() - interval '1 day')`, [nvrId, zoneId]);

    let added = 0;
    for (const c of await mnvr.cameras()) {
      const { rows } = await cmsDb.query('SELECT 1 FROM camera WHERE nvr_id = $1 AND lower(name) = lower($2)', [nvrId, c.camera_name]);
      if (rows.length) continue;
      await cmsDb.query('INSERT INTO camera (nvr_id, name, mount_position) VALUES ($1,$2,$3)', [nvrId, c.camera_name, c.location_description || null]);
      added++;
    }
    console.log(`cameras added to CMS: ${added}`);
    console.log(`\nPut this in bridge/.env:\n  NVR_FINGERPRINT=${fp}\n`);
  } finally { await cmsDb.end(); await mnvr.close(); }
})().catch((err) => { console.error('provision:', err.message); process.exit(1); });
