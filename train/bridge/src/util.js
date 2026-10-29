const fs = require('fs');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => new Date(d).toISOString();

/** Sleep that can be woken early by calling the returned .wake() */
function wakeableSleep(ms) {
  let wake; const p = new Promise((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
  p.wake = wake; return p;
}

/** One at a time per key (two commands can overlap on the same segment). */
class KeyedMutex {
  constructor() { this.tails = new Map(); }
  async run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    let release; const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try { return await fn(); } finally { release(); if (this.tails.get(key) === tail) this.tails.delete(key); }
  }
}

const shaCache = new Map(); // path|size|mtime -> sha256 (a recorded segment never changes once closed)
async function sha256File(file, st) {
  const key = `${file}|${st.size}|${Math.round(st.mtimeMs)}`;
  if (shaCache.has(key)) return shaCache.get(key);
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', resolve).on('error', reject));
  const hex = h.digest('hex');
  if (shaCache.size > 2000) shaCache.delete(shaCache.keys().next().value);
  shaCache.set(key, hex);
  return hex;
}

/** Gaps in [from,to] (ms) not covered by the given [start,end] ms intervals; tolerance in ms. */
function gaps(intervals, from, to, tol = 1500) {
  const out = []; let cur = from;
  for (const [s, e] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (s - cur > tol) out.push([cur, Math.min(s, to)]);
    cur = Math.max(cur, e);
    if (cur >= to) break;
  }
  if (to - cur > tol) out.push([cur, to]);
  return out;
}

module.exports = { sleep, iso, wakeableSleep, KeyedMutex, sha256File, gaps };
