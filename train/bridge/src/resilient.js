/**
 * "Pause when the signal goes, carry on when it returns." Runs an operation again for as long as the failure is the
 * link (no connection, timeouts), with growing waits, up to UPLOAD_PATIENCE_H hours. While waiting the transfer
 * shows as PAUSED in the M-NVR "CMS Requests" page and nothing already uploaded is lost: the caller re-asks CMS
 * where it stands before sending anything again.
 * When CMS ANSWERS but with a server error (5xx), that is not a lost signal: it is retried for SERVER_PATIENCE_S only, then the
 * transfer fails with CMS's message, so a broken request can never hold an upload slot (and block every request behind it) for hours.
 * A transfer that was withdrawn or removed (progress.isCancelled()) stops at once.
 */
const cms = require("./cmsClient");
const config = require("./config");
const log = require("./log")("link");
const { sleep } = require("./util");

const cancelledErr = (progress) =>
  Object.assign(
    new Error(`stopped: ${(progress.isCancelled() || {}).why || "cancelled"}`),
    { cancelled: true, permanent: true },
  );

async function retryOnLinkLoss(
  label,
  progress,
  fn,
  { serverPatienceS = config.serverPatienceS } = {},
) {
  let delay = 1000;
  let paused = false;
  const t0 = Date.now();
  let serverSince = null;
  for (;;) {
    if (progress && progress.isCancelled && progress.isCancelled())
      throw cancelledErr(progress);
    try {
      const r = await fn();
      if (paused) {
        progress && progress.set({ status: "uploading", message: null });
        log.info(`${label}: back to normal - continuing where it stopped`);
      }
      return r;
    } catch (e) {
      if (!cms.isTransient(e)) throw e;
      const answered = !e.network && e.status > 0; // CMS replied (5xx / 429 / 408) - the link itself is fine
      if (answered) {
        serverSince = serverSince || Date.now();
        if (Date.now() - serverSince > serverPatienceS * 1000)
          throw Object.assign(
            new Error(`CMS keeps answering with an error: ${e.message}`),
            { permanent: true },
          );
      } else serverSince = null;
      if (Date.now() - t0 > config.uploadPatienceH * 3600e3) throw e;
      if (!paused) {
        paused = true;
        log.warn(
          `${label}: ${answered ? `CMS error (${e.message})` : `no signal (${e.message})`} - paused, will continue from the same byte`,
        );
      }
      progress &&
        progress.set({
          status: "paused",
          message: answered
            ? `CMS error: ${e.message} - retrying`
            : "No signal - paused. It continues automatically from where it stopped; nothing is sent twice.",
        });
      await sleep(delay);
      delay = Math.min(15000, Math.round(delay * 1.7));
    }
  }
}
module.exports = { retryOnLinkLoss };
