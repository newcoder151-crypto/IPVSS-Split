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

function requireText(value, name, maxLen = 2000) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw badRequest(`${name} is required`);
  if (s.length > maxLen) throw badRequest(`${name} must be at most ${maxLen} characters`);
  return s;
}

/** Date range on a timestamp column: `from` inclusive, `to` exclusive (ISO timestamps made by the browser from the officer's calendar days). Pushes params onto `params`, adds SQL to `where`. */
function rangeSql(where, params, from, to, col) {
  const f = from ? new Date(from) : null; const t = to ? new Date(to) : null;
  if (f && !Number.isNaN(f.getTime())) { params.push(f.toISOString()); where.push(`${col} >= $${params.length}`); }
  if (t && !Number.isNaN(t.getTime())) { params.push(t.toISOString()); where.push(`${col} < $${params.length}`); }
}
/** Partial, case-insensitive match on text columns ("123" finds train 12301). `%`/`_` in the input are dropped. */
function likeSql(where, params, text, cols) {
  const t = typeof text === 'string' ? text.trim().slice(0, 80).replace(/[%_\\]/g, '') : '';
  if (!t) return;
  params.push(`%${t}%`);
  where.push('(' + cols.map((c) => `${c}::text ILIKE $${params.length}`).join(' OR ') + ')');
}

/** Train number: an EXACT match - the number ("12301") or the whole text ("12301 Rajdhani"), ignoring case. "1" does not find 12301. */
function trainSql(where, params, text, col) {
  const t = typeof text === 'string' ? text.trim().slice(0, 40) : '';
  if (!t) return;
  params.push(t);
  const n = params.length;
  where.push(`(lower(${col}) = lower($${n}) OR lower(split_part(${col}, ' ', 1)) = lower($${n}))`);
}

module.exports = { parseTs, parseId, parseLimit, requireText, rangeSql, likeSql, trainSql };
