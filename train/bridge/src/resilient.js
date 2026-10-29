/**
 * "Pause when the signal goes, carry on when it returns." Runs an operation again for as long as the failure is the
 * link (no connection, timeouts, 5xx), with growing waits, up to UPLOAD_PATIENCE_H hours. While waiting the transfer
 * shows as PAUSED in the M-NVR "CMS Requests" page and nothing already uploaded is lost: the caller re-asks CMS
 * where it stands before sending anything again.
 */
const cms = require('./cmsClient');
const config = require('./config');
const log = require('./log')('link');
const { sleep } = require('./util');

async function retryOnLinkLoss(label, progress, fn) {
  let delay = 1000; let paused = false; const t0 = Date.now();
  for (;;) {
    try {
      const r = await fn();
      if (paused) { progress && progress.set({ status: 'uploading', message: null }); log.info(`${label}: signal is back - continuing where it stopped`); }
      return r;
    } catch (e) {
      if (!cms.isTransient(e)) throw e;
      if (Date.now() - t0 > config.uploadPatienceH * 3600e3) throw e;
      if (!paused) {
        paused = true;
        progress && progress.set({ status: 'paused', message: 'No signal - paused. It continues automatically from where it stopped; nothing is sent twice.' });
        log.warn(`${label}: no signal (${e.message}) - paused, will continue from the same byte`);
      }
      await sleep(delay); delay = Math.min(15000, Math.round(delay * 1.7));
    }
  }
}
module.exports = { retryOnLinkLoss };
