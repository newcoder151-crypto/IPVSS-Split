/**
 * Transfer tracker: one record per footage transfer (a CMS "upload now" command, or an optional pre-upload), with live
 * progress. Served on the bridge's local status port (/transfers) and shown in the M-NVR "CMS Requests" page.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.stateDir, 'transfers.json');
const items = new Map();
let timer = null;

try {
  for (const r of JSON.parse(fs.readFileSync(FILE, 'utf8'))) {
    if (['queued', 'waiting_for_recording', 'preparing', 'uploading', 'paused'].includes(r.status)) { r.status = 'interrupted'; r.message = 'bridge restarted - resumes when CMS asks again'; }
    items.set(r.key, r);
  }
} catch (_) { /* first run */ }

function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(config.stateDir, { recursive: true });
      const keep = [...items.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100);
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(keep)); fs.renameSync(FILE + '.tmp', FILE);
      for (const k of [...items.keys()]) if (!keep.find((r) => r.key === k)) items.delete(k);
    } catch (_) { /* progress display only; never break a transfer */ }
  }, 1000); timer.unref();
}

const pct = (r) => (r.bytes_total > 0 ? Math.min(100, Math.floor((r.bytes_sent / r.bytes_total) * 100)) : (['completed', 'partial'].includes(r.status) ? 100 : 0));

/** Returns a handle: set(patch), add(bytes). Calling begin() again for the same key (a resume) reuses the record. */
function begin(key, base) {
  const now = new Date().toISOString();
  const r = items.get(key) || { key, created_at: now, bytes_total: 0, bytes_sent: 0, segments_total: 0, segments_done: 0, attempts: 0, ...base };
  Object.assign(r, base, { status: 'queued', error: null, message: null, bytes_sent: 0, segments_done: 0, attempts: (r.attempts || 0) + 1, updated_at: now, finished_at: null });
  items.set(key, r); persist();
  return {
    set(patch) { Object.assign(r, patch, { updated_at: new Date().toISOString() }); if (['completed', 'partial', 'failed'].includes(r.status)) r.finished_at = r.updated_at; persist(); },
    add(n) { r.bytes_sent = Math.max(0, r.bytes_sent + n); r.updated_at = new Date().toISOString(); persist(); },
  };
}

const list = () => [...items.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((r) => ({ ...r, percent: pct(r) }));
module.exports = { begin, list };
