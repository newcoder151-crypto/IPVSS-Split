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

module.exports = { parseTs, parseId, parseLimit, requireText };
