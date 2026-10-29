const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log')('state');

const FILE = path.join(config.stateDir, 'bridge-state.json');
const DEFAULT = { alert_cursor: null, gps_cursor: 0, skipped_alerts: [] };
let data = { ...DEFAULT };

function load() {
  fs.mkdirSync(config.stateDir, { recursive: true });
  try { data = { ...DEFAULT, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch (e) { if (e.code !== 'ENOENT') log.warn(`state file unreadable (${e.message}); starting fresh`); }
  return data;
}
function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE); // atomic: a power cut never leaves half a file
}
const get = () => data;
function set(patch) { Object.assign(data, patch); save(); }

module.exports = { load, get, set, FILE };
