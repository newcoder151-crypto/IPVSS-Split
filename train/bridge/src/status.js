/** Tiny local status endpoint:  GET http://127.0.0.1:<STATUS_PORT>/health  (loopback only, no secrets). */
const http = require("http");
const config = require("./config");
const state = require("./state");
const heartbeat = require("./heartbeat");
const alerts = require("./alerts");
const commands = require("./commands");
const uploader = require("./uploader");
const cameras = require("./cameraMap");
const transfers = require("./transfers");
const st = require("./stage");
const log = require("./log")("status");

function start() {
  if (!config.statusPort) return null;
  const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const cmdIdOf = (r) => (r && r.command_id) || null;
  // Remove a transfer from the list; a running one is stopped and reported to CMS as failed (so it is not handed out again - the operator can
  // re-send it from the console). Loopback only, like everything on this port.
  const removeTransfer = (r) => {
    const id = cmdIdOf(r);
    if (
      id &&
      r.kind === "cms_request" &&
      !["completed", "partial", "failed", "cancelled"].includes(r.status)
    )
      commands.cancel(id, {
        tell: true,
        why: "removed on the train by the operator",
      });
    transfers.remove(r.key);
  };
  const srv = http.createServer((req, res) => {
    if (req.method === "DELETE" && /^\/transfers\/[\w-]+$/.test(req.url)) {
      const r = transfers.get(req.url.split("/")[2]);
      if (!r) return json(res, 404, { error: "no such transfer" });
      removeTransfer(r);
      return json(res, 200, { removed: r.key });
    }
    if (req.method === "POST" && req.url === "/transfers/clear") {
      commands.cancelQueued({
        tell: true,
        why: "removed on the train by the operator",
      }); // first: nothing may start in a slot that frees up
      const all = transfers.list();
      all.forEach(removeTransfer);
      return json(res, 200, { removed: all.length });
    }
    if (req.url === "/transfers") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          online: heartbeat.status.online,
          last_ok: heartbeat.status.last_ok,
          transfers: transfers.list(),
        }),
      );
      return;
    }
    if (req.url !== "/health" && req.url !== "/") {
      res.writeHead(404).end();
      return;
    }
    const s = state.get();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          service: "mnvr-cms-bridge",
          cms: config.cmsUrl,
          stage: st.stage,
          error: st.error,
          identity: {
            train_no: st.train_no,
            unit_no: st.unit_no,
            problem: st.identity_problem,
          },
          ...heartbeat.status,
          alerts: {
            ...alerts.stats,
            cursor: s.alert_cursor,
            recently_skipped: (s.skipped_alerts || []).slice(-5),
          },
          commands: commands.state(),
          uploads: uploader.stats,
          gps_cursor: s.gps_cursor,
          ...cameras.snapshot(),
        },
        null,
        2,
      ),
    );
  });
  srv.on("error", (e) => log.warn(`status endpoint not started: ${e.message}`));
  srv.listen(config.statusPort, "127.0.0.1", () =>
    log.info(`status on http://127.0.0.1:${config.statusPort}/health`),
  );
  return srv;
}
module.exports = { start };
