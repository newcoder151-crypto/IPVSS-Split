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
const { sleep } = require('./util');

let stopping = false; let online = false;

async function refreshCameras() {
  const [me, local] = await Promise.all([cms.call('GET', '/self'), mnvr.cameras()]);
  cameras.build(me.cameras, local);
  return me;
}

async function longPoll() {
  for (;;) {
    if (stopping) return;
    if (!online) { await sleep(500); continue; }
    try {
      const cmds = await cms.call('GET', '/commands/wait?timeout=25', { timeoutMs: 35000 });
      commands.enqueue(cmds);
      if (!cmds.length) continue;
      await sleep(100);
    } catch (e) { await sleep(1500); }
  }
}

(async () => {
  state.load();
  log.info(`starting: CMS ${config.cmsUrl}, M-NVR database ${config.db.user}@${config.db.host}/${config.db.database}`);

  // self-register in CMS (name/train number come from the M-NVR itself); retried until the databases are up
  if (process.env.CMS_DB_PASSWORD !== undefined || process.env.AUTO_PROVISION === '1' || !config.fingerprint) {
    for (let i = 0; !stopping; i++) {
      try { const r = await require('./autoProvision').ensureRegistered(); log.info(`identity: ${r.name}${r.trainNo ? ` / train ${r.trainNo}` : ''}`); break; }
      catch (e) { if (i % 6 === 0) log.warn(`registering in CMS: ${e.message}`); await sleep(5000); }
    }
  }
  // wait for both ends; a train may boot before it has coverage, so keep trying
  for (let i = 0; !stopping; i++) {
    try { await mnvr.pool.query('SELECT 1'); const me = await refreshCameras(); log.info(`registered at CMS as '${me.nvr.name}' (zone ${me.nvr.zone_id}), ${me.cameras.length} camera(s)`); break; }
    catch (e) { if (i % 6 === 0) log.warn(`waiting for CMS / M-NVR database: ${e.message}`); await sleep(5000); }
  }

  status.start();
  heartbeat.loop((on) => { online = on; alerts.setOnline(on); if (on) refreshCameras().catch(() => {}); });
  alerts.loop().catch((e) => { log.error(`alert loop stopped: ${e.message}`); process.exit(1); });
  longPoll();
  setInterval(() => { if (online) refreshCameras().catch(() => {}); }, 5 * 60000).unref(); // pick up cameras added in CMS or on the M-NVR
})();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { stopping = true; log.info('stopping'); await mnvr.close().catch(() => {}); process.exit(0); });
process.on('unhandledRejection', (e) => log.error(`unhandled: ${e && e.stack || e}`));
