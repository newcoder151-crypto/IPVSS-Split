/**
 * Commands from CMS: delivered both in the heartbeat answer and through the long-poll
 * (GET /commands/wait), so "upload now" reaches the unit within milliseconds while it has coverage.
 *   upload_now   -> find the footage for camera+window on this unit and upload it
 *   ping/sync_clock -> acknowledged (the bridge never changes the system clock; it only warns about drift)
 * A command that is interrupted (link lost) is simply left as it is: CMS keeps it open and hands it out again,
 * and the upload resumes from the last chunk CMS stored.
 */
const cms = require("./cmsClient");
const uploader = require("./uploader");
const config = require("./config");
const transfers = require("./transfers");
const { retryOnLinkLoss } = require("./resilient");
const cameras = require("./cameraMap");
const log = require("./log")("commands");

const inflight = new Set();
const queue = [];
let running = 0;
const seenAt = new Map(); // command id -> when this unit first took it
const stats = { done: 0, failed: 0, interrupted: 0, cancelled: 0 };

function enqueue(cmds) {
  for (const c of cmds || []) {
    if (inflight.has(c.id)) continue;
    inflight.add(c.id);
    seenAt.set(c.id, Date.now());
    queue.push(c);
  }
  pump();
}
function pump() {
  while (running < config.uploadConcurrency && queue.length) {
    const c = queue.shift();
    running++;
    run(c)
      .catch((e) => log.error(`command #${c.id}: ${e.message}`))
      .finally(() => {
        running--;
        inflight.delete(c.id);
        seenAt.delete(c.id);
        pump();
      });
  }
}

const report = (id, what, body) =>
  retryOnLinkLoss(
    `cmd #${id} ${what}`,
    null,
    () => cms.call("POST", `/commands/${id}/${what}`, { json: body || {} }),
    { serverPatienceS: 60 },
  );

/**
 * Stop a command: drop it from the queue, or make the running upload stop at its next step. tell = also report it to CMS as failed
 * (the operator can send it again from the console); without it CMS itself withdrew the command, so there is nothing to tell.
 */
function cancel(id, { tell = false, why = "cancelled" } = {}) {
  const qi = queue.findIndex((c) => c.id === id);
  const running = inflight.has(id) && qi < 0; // a running upload reports for itself when it stops
  if (qi >= 0) {
    queue.splice(qi, 1);
    inflight.delete(id);
    seenAt.delete(id);
  }
  const r = transfers.get(`cmd-${id}`);
  if (!running && r) {
    r.status = "cancelled";
    r.message = why;
    r.finished_at = new Date().toISOString();
  }
  transfers.flagCancel(`cmd-${id}`, { tell, why });
  if (!running && tell) report(id, "fail", { error: why }).catch(() => {});
}
/** Drop every command still waiting for a slot (they have no transfer record yet, so the transfer list cannot reach them). */
function cancelQueued(opts) {
  for (const c of [...queue]) cancel(c.id, opts);
}
/** The heartbeat answer lists every command CMS still has open for this unit: whatever we are working on that is not in it was withdrawn
 *  (request cancelled, expired, failed elsewhere) - stop it, it must not hold an upload slot. */
function reconcile(list) {
  if (!Array.isArray(list) || list.length >= 200) return; // 200 = CMS's page size: the list may be cut, do not guess
  const open = new Set(list.map((c) => c.id));
  for (const id of [...inflight]) {
    if (open.has(id) || Date.now() - (seenAt.get(id) || 0) < 60000) continue; // (a command taken in the last minute may be newer than this answer)
    log.info(`cmd #${id}: no longer open at CMS - stopping it`);
    cancel(id, {
      tell: false,
      why: "withdrawn by CMS (request cancelled, finished or expired)",
    });
  }
}

async function run(cmd) {
  if (cmd.kind === "ping" || cmd.kind === "sync_clock") {
    await report(cmd.id, "done");
    return;
  }
  if (cmd.kind !== "upload_now") {
    await report(cmd.id, "fail", {
      error: `unsupported command '${cmd.kind}'`,
    });
    stats.failed++;
    return;
  }

  // which camera of which M-NVR of which train (naming convention <TRAIN>_M<nn>_C<nn>)
  const who = cmd.train_no
    ? `train ${cmd.train_no} M${String(cmd.unit_no || 0).padStart(2, "0")} C${String(cmd.camera_no || 0).padStart(2, "0")}`
    : `camera ${cmd.camera_id}`;
  const label = `cmd #${cmd.id}${cmd.request_id ? ` (request #${cmd.request_id}${cmd.train_request_id ? `, train request #${cmd.train_request_id}` : ""})` : ""} ${who}`;
  const from = new Date(cmd.window_start).getTime();
  const to = new Date(cmd.window_end).getTime();
  log.info(
    `${label}: upload  ${new Date(from).toISOString()} .. ${new Date(to).toISOString()}`,
  );
  const tr = transfers.begin(`cmd-${cmd.id}`, {
    kind: "cms_request",
    command_id: cmd.id,
    request_id: cmd.request_id || null,
    train_request_id: cmd.train_request_id || null,
    train_no: cmd.train_no || null,
    unit_no: cmd.unit_no || null,
    camera_no: cmd.camera_no || null,
    cms_camera_id: cmd.camera_id,
    camera_name: cameras.nameOfCms(cmd.camera_id),
    window_start: new Date(from).toISOString(),
    window_end: new Date(to).toISOString(),
  });
  try {
    if (cmd.status !== "acked") await report(cmd.id, "ack");
    const r = await uploader.uploadWindow(cmd.camera_id, from, to, label, tr);
    await report(cmd.id, "done", { missing: r.missing });
    tr.set({
      status: r.missing.length ? "partial" : "completed",
      missing: r.missing,
      message: r.missing.length
        ? `${r.missing.length} part(s) of the window were not recorded`
        : null,
    });
    stats.done++;
  } catch (e) {
    if (e.cancelled) {
      const c = tr.isCancelled() || {};
      tr.set({ status: "cancelled", message: c.why || e.message });
      if (c.tell)
        await report(cmd.id, "fail", {
          error: String(c.why || "cancelled on the train").slice(0, 280),
        }).catch(() => {});
      stats.cancelled++;
      log.info(`${label} stopped: ${c.why || e.message}`);
      return;
    }
    if (e.permanent || (e instanceof cms.CmsError && !cms.isTransient(e))) {
      log.error(`${label} failed: ${e.message}`);
      tr.set({ status: "failed", error: String(e.message).slice(0, 280) });
      await report(cmd.id, "fail", {
        error: String(e.message).slice(0, 280),
      }).catch(() => {});
      stats.failed++;
    } else {
      stats.interrupted++;
      tr.set({
        status: "interrupted",
        message: `${e.message} - retrying when CMS is reachable`,
      });
      log.warn(
        `${label} interrupted: ${e.message} - will resume when CMS hands it out again`,
      );
    }
  }
}

const state = () => ({
  in_flight: [...inflight],
  queued: queue.length,
  ...stats,
});
module.exports = { enqueue, state, cancel, cancelQueued, reconcile };
