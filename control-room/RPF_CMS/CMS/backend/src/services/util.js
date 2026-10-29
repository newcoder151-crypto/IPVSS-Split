const { badRequest } = require('../errors');

function parseTs(value, name) {
  if (value == null || value === '') throw badRequest(`${name} is required`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`${name} is not a valid timestamp`);
  return d;
}
function parseId(value, name = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${name} must be a positive integer`);
  return n;
}
function parseLimit(value, dflt = 100, max = 500) {
  if (value == null || value === '') return dflt;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('limit must be a positive integer');
  return Math.min(n, max);
}
function parseOffset(value) {
  const n = Number(value || 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
function requireText(value, name, maxLen = 2000) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw badRequest(`${name} is required`);
  if (s.length > maxLen) throw badRequest(`${name} must be at most ${maxLen} characters`);
  return s;
}
function optText(value, maxLen = 2000) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s.slice(0, maxLen) : null;
}
function num(value, name, { min, max } = {}) {
  const n = Number(value);
  if (value === '' || value == null || !Number.isFinite(n)) throw badRequest(`${name} must be a number`);
  if (min != null && n < min) throw badRequest(`${name} must be at least ${min}`);
  if (max != null && n > max) throw badRequest(`${name} must be at most ${max}`);
  return n;
}
/** Builds "WHERE a AND b" and params incrementally. */
function where() {
  const parts = []; const params = [];
  return {
    params,
    add(sqlWithQ, value) { params.push(value); parts.push(sqlWithQ.replace('?', `$${params.length}`)); },
    raw(sql) { parts.push(sql); },
    sql() { return parts.length ? 'WHERE ' + parts.join(' AND ') : ''; },
  };
}
/** Date presets for list filters. Literals only, so safe to splice into SQL. */
const WHEN_SQL = { today: "date_trunc('day', now())", '24h': "now() - interval '24 hours'", '7d': "now() - interval '7 days'", '30d': "now() - interval '30 days'" };
function whenFilter(w, preset, col) { if (WHEN_SQL[preset]) w.raw(`${col} >= ${WHEN_SQL[preset]}`); }
/** Case-insensitive search across several columns. */
function searchFilter(w, text, cols) {
  const t = typeof text === 'string' ? text.trim().slice(0, 80).replace(/[%_\\]/g, '') : '';
  if (!t) return;
  w.params.push(`%${t}%`); const n = w.params.length;
  w.raw('(' + cols.map((c) => `${c}::text ILIKE $${n}`).join(' OR ') + ')');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { whenFilter, searchFilter, parseTs, parseId, parseLimit, parseOffset, requireText, optText, num, where, sleep };
