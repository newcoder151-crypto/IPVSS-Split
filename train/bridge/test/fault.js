#!/usr/bin/env node
/**
 * FAULT TOLERANCE of a footage transfer. Real CMS + RPF + bridge; a proxy between bridge and CMS breaks the link in the
 * nastiest ways while one request is being fetched:
 *   - connection cut in the middle of a chunk            - reply lost AFTER CMS stored the chunk (so a blind resend would duplicate)
 *   - a chunk damaged in transit (a flipped byte)        - the signal gone for 15 s (tunnel), then back
 * Afterwards every segment at CMS must be byte-identical to the file recorded on the M-NVR, the stitched clip must
 * contain every frame, and nothing may have been uploaded twice or skipped.
 */
const http = require('http'); const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process'); const { Pool } = require('pg'); const fx = require('./fixture');
const CMS = 'http://localhost:7080'; const RPF = 'http://localhost:7090'; const PORT = 7082; const MEDIA = process.env.MEDIA_ROOT || '/tmp/ipvss/media';
const cmsDb = new Pool({ host: 'localhost', user: 'cms', password: process.env.CMS_DB_PASSWORD || 'cmspass', database: 'cms' });
let failed = 0; const ok = (c, m) => { console.log(`${c ? '  ok   -' : '  FAIL -'} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
async function until(fn, ms, step = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } }
async function api(base, p, { method = 'GET', token, body } = {}) { const r = await fetch(base + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }
const login = async (b, pre, u, p) => (await api(b, `${pre}/auth/login`, { method: 'POST', body: { username: u, password: p } })).data.token;

// ---- the hostile network ---------------------------------------------------------------------------------------
const faults = new Map(); // chunk PUT number -> 'cut' | 'lostreply' | 'corrupt' | 'outage'
const net = { down: false, puts: 0, injected: { cut: 0, lostreply: 0, corrupt: 0, outage: 0 }, applied: new Map() };
const srv = http.createServer((req, res) => {
  if (net.down) { req.socket.destroy(); return; }
  const isChunk = req.method === 'PUT' && /\/chunks\/\d+$/.test(req.url);
  const fault = isChunk ? faults.get(++net.puts) : null;
  const forward = (body, afterReply) => {
    const up = http.request({ host: 'localhost', port: 7080, path: req.url, method: req.method, headers: body ? { ...req.headers, 'content-length': Buffer.byteLength(body) } : req.headers }, (r) => {
      if (afterReply === 'lostreply') { r.resume(); r.on('end', () => req.socket.destroy()); return; } // CMS stored it; the reply never arrives
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on('error', () => { try { res.writeHead(502).end(); } catch (_) {} });
    if (body) up.end(body); else req.pipe(up);
  };
  if (!isChunk) return forward(null);
  if (fault === 'cut') { net.injected.cut++; let n = 0; req.on('data', (d) => { n += d.length; if (n > 20000) req.socket.destroy(); }); return; }
  if (fault === 'lostreply') { net.injected.lostreply++; const bufs = []; req.on('data', (d) => bufs.push(d)); req.on('end', () => forward(Buffer.concat(bufs), 'lostreply')); return; }
  if (fault === 'corrupt') { net.injected.corrupt++; const bufs = []; req.on('data', (d) => bufs.push(d)); req.on('end', () => { const b = Buffer.concat(bufs); b[Math.floor(b.length / 2)] ^= 0xff; forward(b); }); return; }
  if (fault === 'outage') { net.injected.outage++; req.resume(); net.down = true; setTimeout(() => { net.down = false; }, 15000); req.socket.destroy(); return; }
  forward(null);
});

let bridge = null; const logs = [];
function startBridge() {
  bridge = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], { env: { ...process.env, BRIDGE_ENV_FILE: '/tmp/ipvss/bridge.env', CMS_URL: `http://localhost:${PORT}`, STATE_DIR: '/tmp/ipvss/bridge-state-fault', STATUS_PORT: '8098', HEARTBEAT_S: '2', CHUNK_BYTES: '65536' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [bridge.stdout, bridge.stderr]) s.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) { logs.push(l); if (process.env.SHOW_BRIDGE) console.log('      |', l); } });
}
(async () => {
  srv.listen(PORT);
  fs.rmSync('/tmp/ipvss/bridge-state-fault', { recursive: true, force: true });
  const ids = await fx.setup(); await fx.history(ids, 8); await fx.gpsHistory(5, 2); const stopLive = fx.startLive(ids);
  const nvr = (await cmsDb.query(`SELECT id FROM nvr_unit WHERE cert_fingerprint = 'fp-bridge-test'`)).rows[0];
  const cam = (await cmsDb.query(`SELECT id FROM camera WHERE nvr_id = $1 AND name = 'cam-1'`, [nvr.id])).rows[0];
  const op = await login(CMS, '/console/api', 'cms-operator', 'cms-demo-123'); const postA = (await cmsDb.query(`SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon FROM rpf_post WHERE name = 'Post A'`)).rows[0]; const off = await login(RPF, '/api', 'post-a-officer', 'rpf-demo-123');
  await cmsDb.query(`DELETE FROM upload_session WHERE segment_id IN (SELECT id FROM video_segment WHERE camera_id = $1)`, [cam.id]);
  await cmsDb.query(`DELETE FROM video_segment WHERE camera_id = $1`, [cam.id]); // a clean slate: everything must really travel
  startBridge();
  await until(async () => (await cmsDb.query(`SELECT 1 FROM nvr_unit WHERE id=$1 AND last_seen > now() - interval '10 seconds'`, [nvr.id])).rowCount, 20000);

  // an incident to hang the request on
  const ev = await fx.addEvent({ type: 'PANIC_BUTTON', severity: 'EMERGENCY', title: 'fault test', cameraId: ids[0], lat: postA.lat, lon: postA.lon });
  const inc = await until(async () => (await cmsDb.query(`SELECT i.id FROM incident i JOIN alert_delivery d ON d.id = i.alert_delivery_id JOIN alert a ON a.id = d.alert_id WHERE a.nvr_event_id = $1`, [`mnvr-${ev}`])).rows[0], 15000, 200);
  const tok = off;

  // chunk #4 cut mid-body, #9 reply lost, #14 corrupted, #20 tunnel (15 s), #27 reply lost again
  [[4, 'cut'], [9, 'lostreply'], [14, 'corrupt'], [20, 'outage'], [27, 'lostreply']].forEach(([n, f]) => faults.set(n, f));
  const now = Date.now(); const wS = now - 5 * 60000; const wE = now - 2 * 60000;
  const rq = await api(RPF, `/api/incidents/${inc.id}/requests`, { method: 'POST', token: tok, body: { window_start: new Date(wS).toISOString(), window_end: new Date(wE).toISOString(), reason: 'fault test', camera_id: Number(cam.id) } });
  if (rq.status !== 201) { console.log('request creation failed:', rq.status, JSON.stringify(rq.data)); process.exit(2); }
  await api(CMS, `/console/api/requests/${rq.data.id}/approve`, { method: 'POST', token: op, body: {} });
  console.log('transfer started under attack (cut, lost reply, corruption, 15 s tunnel)...');

  let sawPaused = false; const t0 = Date.now(); let status = null;
  while (Date.now() - t0 < 240000) {
    const tr = await (await fetch('http://127.0.0.1:8098/transfers').catch(() => ({ json: async () => ({ transfers: [] }) }))).json();
    const mine = tr.transfers.find((x) => Number(x.request_id) === Number(rq.data.id)); if (mine && mine.status === 'paused') sawPaused = true;
    status = (await api(RPF, `/api/requests/${rq.data.id}`, { token: tok })).data.request.status; if (status === 'fulfilled' || status === 'failed') break;
    await sleep(500);
  }
  ok(status === 'fulfilled', `request fulfilled despite the faults after ${((Date.now() - t0) / 1000).toFixed(0)} s (status: ${status})`);
  ok(net.injected.cut === 1 && net.injected.lostreply === 2 && net.injected.corrupt === 1 && net.injected.outage === 1, `all faults were actually injected: ${JSON.stringify(net.injected)}`);
  ok(sawPaused, 'during the tunnel the transfer showed PAUSED (not failed)');
  ok(logs.some((l) => /signal is back - continuing/.test(l)), 'the bridge logged that it continued where it stopped');

  // integrity: every segment at CMS identical to the M-NVR's file
  const src = (await fx.db.query(`SELECT file_path, start_timestamp FROM recordings WHERE camera_id = $1 AND start_timestamp < $3 AND end_timestamp > $2 ORDER BY start_timestamp`, [ids[0], new Date(wS), new Date(wE)])).rows;
  const dst = (await cmsDb.query(`SELECT object_key, upload_status, size_bytes, bytes_received FROM video_segment s JOIN upload_session u ON u.segment_id = s.id WHERE s.camera_id = $1 AND s.start_time < $3 AND s.end_time > $2 ORDER BY s.start_time`, [cam.id, new Date(wS), new Date(wE)])).rows;
  ok(dst.length === src.length && src.length >= 8, `CMS holds exactly the ${src.length} segments of the window (no missing, no extra): ${dst.length}`);
  ok(dst.every((d) => d.upload_status === 'complete' && Number(d.bytes_received) === Number(d.size_bytes)), 'every segment is complete and its byte count equals the file size');
  const same = src.every((s, i) => sha(s.file_path) === sha(path.join(MEDIA, dst[i].object_key)));
  ok(same, 'every segment at CMS is BYTE-IDENTICAL to the file recorded on the M-NVR (SHA-256 of all of them)');
  ok(!fs.readdirSync(path.join(MEDIA)).some((d) => d.startsWith('zone-')) || !execFileSync('find', [MEDIA, '-name', '*.part']).toString().trim(), 'no half-written .part files are left behind');

  // the delivered clip contains every frame of every segment
  const rqD = (await api(RPF, `/api/requests/${rq.data.id}`, { token: tok })).data; const clip = path.join(MEDIA, 'zone-1', `req-${rq.data.id}.mp4`);
  const frames = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f]).toString().trim());
  const expect = src.reduce((n, s) => n + frames(s.file_path), 0);
  ok(frames(clip) === expect, `the delivered clip has all ${expect} frames of the ${src.length} source segments (found ${frames(clip)}) - no frame lost`);
  ok(rqD.footage[0] && sha(clip) === rqD.footage[0].sha256, 'the stored clip matches the hash CMS recorded for delivery');

  bridge.kill('SIGTERM'); stopLive(); srv.close(); await cmsDb.end(); await fx.db.end();
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('fault test error:', e); try { bridge && bridge.kill(); } catch (_) {} process.exit(2); });
