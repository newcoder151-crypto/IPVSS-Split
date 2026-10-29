/**
 * Self-registration: the bridge registers THIS M-NVR in the CMS registry by itself.
 *   unit name / train number  <- the M-NVR's own system_config (device_name, train_number)
 *   certificate fingerprint   <- generated once, kept in STATE_DIR/identity.json
 *   zone                      <- ZONE env, else the only/first zone in CMS
 *   cameras                   <- every M-NVR camera (added if missing, same name)
 * Writes only registry DATA into the CMS database (needs CMS_DB_* settings). Safe to run on every start.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const config = require('./config');
const mnvr = require('./mnvrDb');
const log = require('./log')('provision');

async function ensureRegistered() {
  const e = process.env;
  const idFile = path.join(config.stateDir, 'identity.json');
  fs.mkdirSync(config.stateDir, { recursive: true });
  let ident = {}; try { ident = JSON.parse(fs.readFileSync(idFile, 'utf8')); } catch (_) { /* first run */ }

  const info = await mnvr.deviceInfo();
  const name = e.NVR_NAME || info.device_name || 'MNVR-001';
  const trainNo = e.TRAIN_NO || info.train_number || null;
  const fp = config.fingerprint || ident.fingerprint || `fp-${crypto.randomBytes(16).toString('hex')}`;

  const db = new Pool({ host: e.CMS_DB_HOST || 'localhost', port: Number(e.CMS_DB_PORT || 5432), database: e.CMS_DB_NAME || 'cms', user: e.CMS_DB_USER || 'cms', password: e.CMS_DB_PASSWORD || '', max: 2 });
  try {
    const zones = (await db.query('SELECT id, name FROM zone ORDER BY id')).rows;
    if (!zones.length) throw new Error('CMS has no zones yet - create one in the CMS console (or load its fixtures)');
    const zone = (e.ZONE && zones.find((z) => z.name === e.ZONE)) || zones[0];

    let unit = (await db.query('SELECT id FROM nvr_unit WHERE cert_fingerprint = $1', [fp])).rows[0]
            || (await db.query('SELECT id FROM nvr_unit WHERE name = $1', [name])).rows[0];
    if (unit) await db.query('UPDATE nvr_unit SET cert_fingerprint = $2, name = $3 WHERE id = $1', [unit.id, fp, name]);
    else { unit = (await db.query('INSERT INTO nvr_unit (name, cert_fingerprint, current_zone_id) VALUES ($1,$2,$3) RETURNING id', [name, fp, zone.id])).rows[0]; log.info(`registered '${name}' in CMS zone '${zone.name}'`); }
    if (trainNo) await db.query('UPDATE nvr_unit SET train_no = $2 WHERE id = $1', [unit.id, trainNo]).catch(() => {});
    const cur = (await db.query('SELECT current_zone_id FROM nvr_unit WHERE id = $1', [unit.id])).rows[0].current_zone_id;
    if (cur == null) await db.query('UPDATE nvr_unit SET current_zone_id = $2 WHERE id = $1', [unit.id, zone.id]);
    if (!(await db.query('SELECT 1 FROM nvr_zone_assignment WHERE nvr_id = $1 AND assigned_until IS NULL', [unit.id])).rowCount)
      await db.query(`INSERT INTO nvr_zone_assignment (nvr_id, zone_id, assigned_from) VALUES ($1,$2, now() - interval '1 day')`, [unit.id, cur || zone.id]);

    let added = 0;
    for (const c of await mnvr.cameras()) {
      if ((await db.query('SELECT 1 FROM camera WHERE nvr_id = $1 AND lower(name) = lower($2)', [unit.id, c.camera_name])).rowCount) continue;
      await db.query('INSERT INTO camera (nvr_id, name, mount_position) VALUES ($1,$2,$3)', [unit.id, c.camera_name, c.location_description || null]); added++;
    }
    if (added) log.info(`added ${added} camera(s) to CMS`);
  } finally { await db.end(); }
  fs.writeFileSync(idFile, JSON.stringify({ fingerprint: fp, name, train_no: trainNo }, null, 2));
  config.fingerprint = fp;
  return { name, trainNo, fingerprint: fp };
}
module.exports = { ensureRegistered };
