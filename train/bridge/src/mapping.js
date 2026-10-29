/** M-NVR event row -> { forward, alert_type, priority } using config/alert-rules.json (read fresh on change). */
const fs = require('fs');
const config = require('./config');
const log = require('./log')('rules');

const SEV = ['INFO', 'WARNING', 'ERROR', 'CRITICAL', 'EMERGENCY'];
let cache = { mtime: 0, rules: null };

function rules() {
  try {
    const st = fs.statSync(config.alertRulesFile);
    if (st.mtimeMs !== cache.mtime) {
      const j = JSON.parse(fs.readFileSync(config.alertRulesFile, 'utf8'));
      cache = { mtime: st.mtimeMs, rules: { list: (j.rules || []).map((r) => ({ ...r, re: r.match ? new RegExp(r.match, 'i') : null })), def: j.default || {} } };
      log.info(`loaded ${cache.rules.list.length} alert rule(s) from ${config.alertRulesFile}`);
    }
  } catch (e) {
    if (!cache.rules) { log.error(`cannot read ${config.alertRulesFile}: ${e.message} - using severity only`); cache = { mtime: 0, rules: { list: [], def: {} } }; }
  }
  return cache.rules;
}

const slug = (s) => String(s || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'event';
const clampPrio = (n) => Math.min(10, Math.max(1, Math.round(Number(n))));

function parseData(ev) {
  if (!ev.event_data) return {};
  if (typeof ev.event_data === 'object') return ev.event_data;
  try { const j = JSON.parse(ev.event_data); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; }
}

function classify(ev) {
  const { list, def } = rules();
  const data = parseData(ev);
  const sev = String(ev.severity || 'INFO').toUpperCase();
  const defPrio = ((def.severity_priority || { INFO: 1, WARNING: 3, ERROR: 5, CRITICAL: 8, EMERGENCY: 9 })[sev]) || 3;

  const hay = [ev.event_type, ev.event_subtype, ev.title].filter(Boolean).join(' | ');
  const rule = list.find((r) => r.re && r.re.test(hay));
  let forward; let alertType; let priority;
  if (rule) {
    forward = rule.forward !== false; alertType = rule.alert_type || slug(ev.event_subtype || ev.event_type); priority = rule.priority != null ? rule.priority : defPrio;
  } else {
    const min = SEV.indexOf(String(def.min_severity || 'WARNING').toUpperCase());
    forward = SEV.indexOf(sev) >= (min < 0 ? 1 : min); alertType = slug(ev.event_subtype || ev.event_type); priority = defPrio;
  }
  // the event's own say-so (e.g. an AI module that knows its confidence) beats the generic rules
  if (data.cms_forward === false) forward = false;
  if (data.cms_forward === true) forward = true;
  if (Number.isFinite(Number(data.priority))) priority = Number(data.priority);
  if (typeof data.alert_type === 'string' && data.alert_type.trim()) alertType = slug(data.alert_type);
  return { forward, alert_type: alertType, priority: clampPrio(priority) };
}

module.exports = { classify, rules };
