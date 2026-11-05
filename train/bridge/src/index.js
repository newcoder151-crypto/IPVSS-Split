#!/usr/bin/env node
/**
 * mNVR <-> CMS bridge. Runs on the train next to the M-NVR. Three jobs, all CMS-initiated or CMS-visible:
 *   1. heartbeat   position, health and GPS track to CMS;       commands come back
 *   2. alerts      M-NVR events -> CMS alerts (-> RPF post)
 *   3. footage     CMS "upload now" commands -> segments from the M-NVR's recordings -> CMS (-> RPF officer)
 */
const config = require('./config');
const cms = require('./cmsClient');
const mnvr = require('./mnvrDb');
const state = require('./state');
const cameras = require('./cameraMap');
const commands = require('./commands');
const heartbeat = require('./heartbeat');
const alerts = require('./alerts');
const status = require('./status');
const log = require('./log')('bridge');
const st = require('./stage');
const fs = require('fs');
const path = require('path');
const { sleep } = require('./util');

let stopping = false; let online = false;

let noTrainLogged = false;
async function refreshCameras() {
  const local = await mnvr.cameras();
  // Who this unit is: the train it rides on and its number in it, from TRAIN_NO / MNVR_NO or the M-NVR's own settings. Sent over HTTP together with the
  // cameras on every connect, so the unit takes part in train requests without needing any database link to the CMS.
  const info = await mnvr.deviceInfo().catch(() => ({}));
  const trainNo = String(process.env.TRAIN_NO || info.train_number || '').trim();
  const mn = config.mnvrNo || (Number.isInteger(Number(info.mnvr_number)) && Number(info.mnvr_number) > 0 ? Number(info.mnvr_number) : null);
  // The cameras are read straight from the M-NVR and pushed to the CMS on every connect: a camera added later joins its train's requests.
  try {
    const pushed = await cms.call('POST', '/cameras/sync', { json: { ...(trainNo ? { train_no: trainNo } : {}), ...(mn ? { unit_no: mn } : {}),
      cameras: local.map((c) => ({ camera_id: c.camera_id, name: c.camera_name, location: c.location_description || null })) } });
    if (pushed && (pushed.added || pushed.requests_added)) log.info(`CMS learned ${pushed.added} new camera(s); ${pushed.requests_added} footage request(s) added for them`);
  } catch (err) { log.warn(`could not push the identity / camera list to the CMS: ${err.message}`); }
  const me = await cms.call('GET', '/self');
  cameras.build(me.cameras, local, me.nvr);
  st.train_no = me.nvr.train_no || null; st.unit_no = me.nvr.unit_no == null ? null : me.nvr.unit_no;
  if (!st.train_no) {
    st.identity_problem = 'this M-NVR has no train number, so it is not part of any train and requests by train number can NOT reach it. Set it:  bash start.sh --train-no <train number>  (and restart)';
    if (!noTrainLogged) { noTrainLogged = true; log.error(st.identity_problem); }
  } else { st.identity_problem = null; noTrainLogged = false; }
  return me;
}

async function longPoll() {
  for (;;) {
    if (stopping) return;
    try {
      const cmds = await cms.call('GET', '/commands/wait?timeout=25', { timeoutMs: 35000 });
      commands.enqueue(cmds);
      if (!cmds.length) continue;
      await sleep(100);
    } catch (e) { await sleep(1500); }
  }
}

const IDENT = () => path.join(config.stateDir, 'identity.json');
function loadStoredIdentity() {   // an earlier registration left the unit's fingerprint here
  try { const j = JSON.parse(fs.readFileSync(IDENT(), 'utf8')); if (j.fingerprint && !config.fingerprint) config.fingerprint = j.fingerprint; } catch (_) { /* first run */ }
  return !!config.fingerprint;
}

// Self-registration writes registry rows straight into the CMS database. Retries with growing waits and says WHY every time it fails.
async function registerLoop() {
  let last = '';
  for (let wait = 3000; !stopping; wait = Math.min(60000, wait * 2)) {
    try { const r = await require('./autoProvision').ensureRegistered(); st.error = null; log.info(`identity: ${r.name}${r.trainNo ? ` / train ${r.trainNo}` : ''}`); return true; }
    catch (e) {
      st.error = `registering in CMS: ${e.message}`;
      if (e.message !== last) { log.warn(`registering in CMS: ${e.message}`); last = e.message; }
      await sleep(wait);
    }
  }
  return false;
}

(async () => {
  state.load();
  status.start();   // first of all: the local status page must answer even while nothing else works
  log.info(`starting: CMS ${config.cmsUrl}, M-NVR database ${config.db.user}@${config.db.host}/${config.db.database}`);

  // Registration needs the CMS DATABASE; everything else only needs the CMS web port. A unit that is already registered (its fingerprint is stored)
  // therefore starts working at once and registration carries on in the background - a database that cannot be reached from the train must never
  // stop the heartbeat and the upload commands.
  const known = loadStoredIdentity();
  const wantsRegistration = process.env.CMS_DB_PASSWORD !== undefined || process.env.AUTO_PROVISION === '1' || !config.fingerprint;
  if (wantsRegistration) {
    st.stage = 'registering';
    if (known) { log.info('already registered - connecting now, registration continues in the background'); registerLoop().catch((e) => log.error(`registration stopped: ${e.message}`)); }
    else await registerLoop();
  }
  // wait for both ends; a train may boot before it has coverage, so keep trying
  for (let i = 0; !stopping; i++) {
    st.stage = 'connecting';
    try { await mnvr.pool.query('SELECT 1'); const me = await refreshCameras(); st.error = null; log.info(`registered at CMS as '${me.nvr.name}' (zone ${me.nvr.zone_id}), ${me.cameras.length} camera(s)`); break; }
    catch (e) { st.error = `waiting for CMS / M-NVR database: ${e.message}`; if (i % 6 === 0) log.warn(st.error); await sleep(5000); }
  }
  st.stage = 'running';

  heartbeat.loop((on) => { online = on; alerts.setOnline(on); if (on) refreshCameras().catch(() => {}); });
  alerts.loop().catch((e) => { log.error(`alert loop stopped: ${e.message}`); process.exit(1); });
  longPoll();
  setInterval(() => { if (online) refreshCameras().catch(() => {}); }, 5 * 60000).unref(); // pick up cameras added in CMS or on the M-NVR
})();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { stopping = true; log.info('stopping'); await mnvr.close().catch(() => {}); process.exit(0); });
process.on('unhandledRejection', (e) => log.error(`unhandled: ${e && e.stack || e}`));