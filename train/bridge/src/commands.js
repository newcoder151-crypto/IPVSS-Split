/**
 * Commands from CMS: delivered both in the heartbeat answer and through the long-poll
 * (GET /commands/wait), so "upload now" reaches the unit within milliseconds while it has coverage.
 *   upload_now   -> find the footage for camera+window on this unit and upload it
 *   ping/sync_clock -> acknowledged (the bridge never changes the system clock; it only warns about drift)
 * A command that is interrupted (link lost) is simply left as it is: CMS keeps it open and hands it out again,
 * and the upload resumes from the last chunk CMS stored.
 */
const cms = require('./cmsClient');
const uploader = require('./uploader');
const config = require('./config');
const transfers = require('./transfers');
const { retryOnLinkLoss } = require('./resilient');
const cameras = require('./cameraMap');
const log = require('./log')('commands');

const inflight = new Set();
const queue = [];
let running = 0;
const stats = { done: 0, failed: 0, interrupted: 0 };

function enqueue(cmds) {
  for (const c of cmds || []) {
    if (inflight.has(c.id)) continue;
    inflight.add(c.id); queue.push(c);
  }
  pump();
}
function pump() {
  while (running < config.uploadConcurrency && queue.length) {
    const c = queue.shift(); running++;
    run(c).catch((e) => log.error(`command #${c.id}: ${e.message}`)).finally(() => { running--; inflight.delete(c.id); pump(); });
  }
}

const report = (id, what, body) => retryOnLinkLoss(`cmd #${id} ${what}`, null, () => cms.call('POST', `/commands/${id}/${what}`, { json: body || {} }));

async function run(cmd) {
  if (cmd.kind === 'ping' || cmd.kind === 'sync_clock') { await report(cmd.id, 'done'); return; }
  if (cmd.kind !== 'upload_now') { await report(cmd.id, 'fail', { error: `unsupported command '${cmd.kind}'` }); stats.failed++; return; }

  const label = `cmd #${cmd.id}${cmd.request_id ? ` (request #${cmd.request_id})` : ''}`;
  const from = new Date(cmd.window_start).getTime(); const to = new Date(cmd.window_end).getTime();
  log.info(`${label}: upload camera ${cmd.camera_id}  ${new Date(from).toISOString()} .. ${new Date(to).toISOString()}`);
  const tr = transfers.begin(`cmd-${cmd.id}`, { kind: 'cms_request', command_id: cmd.id, request_id: cmd.request_id || null, cms_camera_id: cmd.camera_id,
    camera_name: cameras.nameOfCms(cmd.camera_id), window_start: new Date(from).toISOString(), window_end: new Date(to).toISOString() });
  try {
    if (cmd.status !== 'acked') await report(cmd.id, 'ack');
    const r = await uploader.uploadWindow(cmd.camera_id, from, to, label, tr);
    await report(cmd.id, 'done', { missing: r.missing });
    tr.set({ status: r.missing.length ? 'partial' : 'completed', missing: r.missing, message: r.missing.length ? `${r.missing.length} part(s) of the window were not recorded` : null });
    stats.done++;
  } catch (e) {
    if (e.permanent || (e instanceof cms.CmsError && !cms.isTransient(e))) {
      log.error(`${label} failed: ${e.message}`);
      tr.set({ status: 'failed', error: String(e.message).slice(0, 280) });
      await report(cmd.id, 'fail', { error: String(e.message).slice(0, 280) }).catch(() => {});
      stats.failed++;
    } else {
      stats.interrupted++;
      tr.set({ status: 'interrupted', message: `${e.message} - retrying when CMS is reachable` });
      log.warn(`${label} interrupted: ${e.message} - will resume when CMS hands it out again`);
    }
  }
}

const state = () => ({ in_flight: [...inflight], queued: queue.length, ...stats });
module.exports = { enqueue, state };
