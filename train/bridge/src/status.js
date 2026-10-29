/** Tiny local status endpoint:  GET http://127.0.0.1:<STATUS_PORT>/health  (loopback only, no secrets). */
const http = require('http');
const config = require('./config');
const state = require('./state');
const heartbeat = require('./heartbeat');
const alerts = require('./alerts');
const commands = require('./commands');
const uploader = require('./uploader');
const cameras = require('./cameraMap');
const transfers = require('./transfers');
const log = require('./log')('status');

function start() {
  if (!config.statusPort) return null;
  const srv = http.createServer((req, res) => {
    if (req.url === '/transfers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ online: heartbeat.status.online, last_ok: heartbeat.status.last_ok, transfers: transfers.list() })); return;
    }
    if (req.url !== '/health' && req.url !== '/') { res.writeHead(404).end(); return; }
    const s = state.get();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: 'mnvr-cms-bridge', cms: config.cmsUrl, ...heartbeat.status,
      alerts: { ...alerts.stats, cursor: s.alert_cursor, recently_skipped: (s.skipped_alerts || []).slice(-5) },
      commands: commands.state(), uploads: uploader.stats, gps_cursor: s.gps_cursor, ...cameras.snapshot(),
    }, null, 2));
  });
  srv.on('error', (e) => log.warn(`status endpoint not started: ${e.message}`));
  srv.listen(config.statusPort, '127.0.0.1', () => log.info(`status on http://127.0.0.1:${config.statusPort}/health`));
  return srv;
}
module.exports = { start };
