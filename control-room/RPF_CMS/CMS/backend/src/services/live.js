/**
 * Live push. One dedicated Postgres connection LISTENs on 'cms_events' (fired by triggers from migration 003);
 * every event is fanned out to the open Server-Sent-Event streams whose user is allowed to see it, and to
 * in-process listeners (the CMS uses these to kick background jobs the moment work appears).
 * A browser cannot send an Authorization header on EventSource, so it first POSTs for a 60-second
 * single-purpose ticket and opens the stream with that.
 */
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const config = require('../config');

const streams = new Set();
const listeners = new Set();
let client = null; let started = false; let stopping = false; let backoff = 500;

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function dispatch(evt) {
  for (const fn of listeners) { try { fn(evt); } catch (e) { console.error('live listener:', e.message); } }
  const data = `event: change\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const s of streams) { if (s.allow(evt)) s.res.write(data); }
}

async function connect() {
  if (stopping) return;
  client = new Client(config.db);
  client.on('notification', (m) => { try { dispatch(JSON.parse(m.payload)); } catch (_) { /* ignore malformed */ } });
  const lost = () => {
    if (stopping || !client) return; client = null;
    setTimeout(() => connect().catch(() => {}), backoff); backoff = Math.min(backoff * 2, 8000);
  };
  client.on('error', (e) => { console.warn('live: listener connection error:', e.message); lost(); });
  client.on('end', lost);
  try {
    await client.connect();
    await client.query('LISTEN cms_events');
    backoff = 500;
    dispatch({ t: 'resync' }); // events may have been missed while disconnected: tell screens to reload
  } catch (e) { console.warn('live: cannot LISTEN:', e.message); try { await client.end(); } catch (_) { /* gone */ } lost(); }
}
function start() { if (started) return; started = true; connect().catch(() => {}); }
function stop() { stopping = true; for (const s of streams) s.res.end(); streams.clear(); if (client) client.end().catch(() => {}); }

const issueTicket = (user) => jwt.sign({ sub: user.id, k: 'stream' }, config.jwtSecret, { expiresIn: '60s', issuer: 'cms-stream' });
const readTicket = (t) => jwt.verify(t, config.jwtSecret, { issuer: 'cms-stream' });

/** Console visibility: operators and zone admins see their zone; super admins see everything. */
const canSee = (user) => (evt) => evt.t === 'resync' || user.role === 'super_admin' || (evt.z != null && Number(evt.z) === Number(user.zone_id));

function attach(req, res, user) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 1000\n\nevent: hello\ndata: {}\n\n');
  const s = { res, allow: canSee(user) };
  streams.add(s);
  const beat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(beat); streams.delete(s); });
}

module.exports = { start, stop, subscribe, attach, issueTicket, readTicket, count: () => streams.size };
