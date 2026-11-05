/**
 * Self-registration: the bridge registers THIS M-NVR in the CMS registry by itself.
 *   unit name / train number  <- the M-NVR's own system_config (device_name, train_number)
 *   certificate fingerprint   <- generated once, kept in STATE_DIR/identity.json
 *   zone                      <- ZONE env, else the only/first zone in CMS
 *   M-NVR number in the train <- MNVR_NO env, else system_config 'mnvr_number', else CMS numbers it (next free number of the train)
 *   cameras                   <- every M-NVR camera (added if missing, same name), numbered by the M-NVR's own camera id
 *                                (CAMERA_NO_MAP="mnvrCameraId:cameraNo,..." overrides)
 *   => every recording is named  <TRAIN>_M<nn>_C<nn>_<start>_<end>.mp4  (train number, M-NVR no., camera no.)
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
  const wantedUnitNo = config.mnvrNo || (Number.isInteger(Number(info.mnvr_number)) && Number(info.mnvr_number) > 0 ? Number(info.mnvr_number) : null);
  if (wantedUnitNo != null && (wantedUnitNo < 1 || wantedUnitNo > 99)) throw new Error(`MNVR_NO must be 1..99 (got ${wantedUnitNo})`);
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
    // train: the unit joins the train whose number it reports; its M-NVR number comes from MNVR_NO / the M-NVR setting (else the CMS gives it the next free one)
    if (trainNo) await db.query('UPDATE nvr_unit SET train_no = $2 WHERE id = $1', [unit.id, trainNo]);
    else log.warn('this M-NVR has no train number (set train_number in its settings or TRAIN_NO): requests BY TRAIN NUMBER will not reach it');
    if (wantedUnitNo != null) {
      try { await db.query('UPDATE nvr_unit SET unit_no = $2 WHERE id = $1 AND unit_no IS DISTINCT FROM $2', [unit.id, wantedUnitNo]); }
      catch (err) {
        if (err.code !== '23505') throw err;
        const other = (await db.query('SELECT name FROM nvr_unit WHERE lower(btrim(train_no)) = lower(btrim($3)) AND unit_no = $2 AND id <> $1', [unit.id, wantedUnitNo, trainNo])).rows[0];
        throw new Error(`M-NVR number ${wantedUnitNo} is already used in train ${trainNo} by '${other ? other.name : 'another unit'}' - give each M-NVR of a train its own MNVR_NO`);
      }
    }
    const cur = (await db.query('SELECT current_zone_id FROM nvr_unit WHERE id = $1', [unit.id])).rows[0].current_zone_id;
    if (cur == null) await db.query('UPDATE nvr_unit SET current_zone_id = $2 WHERE id = $1', [unit.id, zone.id]);
    if (!(await db.query('SELECT 1 FROM nvr_zone_assignment WHERE nvr_id = $1 AND assigned_until IS NULL', [unit.id])).rowCount)
      await db.query(`INSERT INTO nvr_zone_assignment (nvr_id, zone_id, assigned_from) VALUES ($1,$2, now() - interval '1 day')`, [unit.id, cur || zone.id]);

    // cameras: read straight from the M-NVR; the camera number is the M-NVR's own camera id (CAMERA_NO_MAP can override it).
    // (The same list is pushed to the CMS on every connect too - see index.js - so a camera added later is picked up without re-registering.)
    let added = 0;
    const camNo = (c) => { const n = config.cameraNoMap.get(c.camera_id) ?? c.camera_id; return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null; };
    for (const c of await mnvr.cameras()) {
      const no = camNo(c);
      if (no == null) { log.warn(`M-NVR camera '${c.camera_name}' has an id that cannot be used as a camera number (${c.camera_id}); the CMS numbers it`); }
      const row = (await db.query('SELECT id, mnvr_camera_id FROM camera WHERE nvr_id = $1 AND (mnvr_camera_id = $2 OR (mnvr_camera_id IS NULL AND lower(name) = lower($3))) ORDER BY (mnvr_camera_id = $2) DESC NULLS LAST LIMIT 1', [unit.id, no, c.camera_name])).rows[0];
      if (row) { if (no != null && row.mnvr_camera_id !== no) await db.query('UPDATE camera SET mnvr_camera_id = $2 WHERE id = $1', [row.id, no]).catch((e) => log.warn(`camera '${c.camera_name}': ${e.message}`)); }
      else { await db.query('INSERT INTO camera (nvr_id, name, mount_position, mnvr_camera_id) VALUES ($1,$2,$3,$4)', [unit.id, c.camera_name, c.location_description || null, no]); added++; }
    }
    if (added) log.info(`added ${added} camera(s) to CMS`);
  } finally { await db.end(); }
  fs.writeFileSync(idFile, JSON.stringify({ fingerprint: fp, name, train_no: trainNo }, null, 2));
  config.fingerprint = fp;
  return { name, trainNo, fingerprint: fp };
}
module.exports = { ensureRegistered };
