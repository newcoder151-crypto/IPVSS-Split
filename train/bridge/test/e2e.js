#!/usr/bin/env node
/**
 * END-TO-END: real CMS + real RPF (running) + this bridge + a stand-in M-NVR (test/fixture.js, real M-NVR schema).
 * A fault-injecting proxy sits between bridge and CMS so tunnels and dropped uploads can be simulated.
 *
 *   needs: CMS on :7080, RPF on :7090 (demo logins), the mNVR database, ffmpeg.   node test/e2e.js
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { Pool } = require('pg');
const fx = require('./fixture');

const CMS = 'http://localhost:7080'; const RPF = 'http://localhost:7090'; const PROXY_PORT = 7081;
const MEDIA = process.env.MEDIA_ROOT || '/tmp/ipvss/media';
const cmsDb = new Pool({ host: 'localhost', user: 'cms', password: process.env.CMS_DB_PASSWORD || 'cmspass', database: 'cms' });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ok   -' : '  FAIL -'} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000, step = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return { v, ms: Date.now() - t0 }; if (Date.now() - t0 > ms) return { v: null, ms: Date.now() - t0 }; await sleep(step); } }
async function http_(base, p, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const login = async (base, prefix, u, pw) => (await http_(base, `${prefix}/auth/login`, { method: 'POST', body: { username: u, password: pw } })).data.token;

// ---- fault-injecting proxy ------------------------------------------------------------------
const proxy = { down: false, failChunk: null /* {n} fail the nth chunk PUT once with 502 */, chunkPuts: 0, injected: 0 };
const proxySrv = http.createServer((req, res) => {
  if (proxy.down) { req.socket.destroy(); return; }
  const isChunk = req.method === 'PUT' && /\/chunks\/\d+$/.test(req.url);
  if (isChunk) { proxy.chunkPuts++; if (proxy.failChunk && proxy.chunkPuts === proxy.failChunk) { proxy.failChunk = null; proxy.injected++; req.resume(); res.writeHead(502).end('{"error":"injected"}'); return; } }
  const up = http.request({ host: 'localhost', port: 7080, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { try { res.writeHead(502).end(); } catch (_) {} });
  res.on('close', () => up.destroy());
  req.pipe(up);
});

// ---- the bridge under test -------------------------------------------------------------------
let bridge = null;
function startBridge(extra = {}) {
  const env = { ...process.env, BRIDGE_ENV_FILE: '/tmp/ipvss/bridge.env', CMS_URL: `http://localhost:${PROXY_PORT}`, STATE_DIR: '/tmp/ipvss/bridge-state-e2e', STATUS_PORT: '8096', HEARTBEAT_S: '2', ALERT_POLL_MS: '300', ...extra };
  bridge = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; bridge.logs = lines;
  for (const s of [bridge.stdout, bridge.stderr]) s.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) { lines.push(l); if (process.env.SHOW_BRIDGE) console.log('      |', l); } });
  return bridge;
}
const stopBridge = () => new Promise((r) => { if (!bridge) return r(); bridge.once('exit', r); bridge.kill('SIGTERM'); bridge = null; });
const logged = (re) => bridge.logs.some((l) => re.test(l));

(async () => {
  proxySrv.listen(PROXY_PORT);
  fs.rmSync('/tmp/ipvss/bridge-state-e2e', { recursive: true, force: true });
  const ids = await fx.setup(); await fx.history(ids, 15); await fx.gpsHistory(10, 2);
  const stopLive = fx.startLive(ids);
  const nvr = (await cmsDb.query(`SELECT id FROM nvr_unit WHERE cert_fingerprint = 'fp-bridge-test'`)).rows[0];
  if (!nvr) throw new Error('unit not provisioned in CMS (run scripts/provision.js)');
  await cmsDb.query(`DELETE FROM gps_point WHERE nvr_id = $1`, [nvr.id]);
  const camsCms = (await cmsDb.query(`SELECT id, name FROM camera WHERE nvr_id = $1 ORDER BY name`, [nvr.id])).rows.map((r) => ({ ...r, id: Number(r.id) }));

  const opTok = await login(CMS, '/console/api', 'cms-operator', 'cms-demo-123');
  const supTok = await login(CMS, '/console/api', 'cms-super', 'cms-demo-123');
  const offA = await login(RPF, '/api', 'post-a-officer', 'rpf-demo-123');
  ok(opTok && supTok && offA, 'operator, super admin and the post officer can sign in');
  await http_(CMS, '/console/api/settings', { method: 'PUT', token: supTok, body: { low_priority_mode: 'auto_deliver' } });
  const op = (p, o = {}) => http_(CMS, `/console/api${p}`, { token: opTok, ...o });
  const officerOf = () => offA; // this dashboard serves one post: Post A
  const postA = (await cmsDb.query(`SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon FROM rpf_post WHERE name = 'Post A'`)).rows[0];

  // ============ 1. start-up, heartbeat, GPS track ============
  console.log('1. start-up / heartbeat / GPS');
  startBridge();
  const hb = await until(async () => (await cmsDb.query(`SELECT last_seen, last_lat FROM nvr_unit WHERE id = $1`, [nvr.id])).rows[0].last_lat != null, 15000);
  ok(hb.v, `CMS sees the unit alive with a position (${(hb.ms / 1000).toFixed(1)} s after start)`);
  const gp = await until(async () => Number((await cmsDb.query(`SELECT count(*) FROM gps_point WHERE nvr_id = $1`, [nvr.id])).rows[0].count) > 100, 20000);
  ok(gp.v, 'the buffered GPS track reached CMS (more than 100 points, thinned to one per 5 s)');
  ok(logged(/camera mapping \(mNVR -> CMS\): \d+->\d+, \d+->\d+, \d+->\d+/), 'the three M-NVR cameras were matched to the three CMS cameras by name');

  // ============ 2. alerts: M-NVR event -> CMS -> RPF ============
  console.log('2. alerts (M-NVR event -> CMS -> RPF post)');
  const t0 = Date.now();
  const evPanic = await fx.addEvent({ type: 'PANIC_BUTTON', severity: 'EMERGENCY', title: 'Passenger pressed panic button', cameraId: ids[0], lat: postA.lat, lon: postA.lon });
  const a1 = await until(async () => (await cmsDb.query(`SELECT a.id, a.priority, a.alert_type, a.status, a.camera_id FROM alert a WHERE a.nvr_id = $1 AND a.nvr_event_id = $2`, [nvr.id, `mnvr-${evPanic}`])).rows[0], 10000, 100);
  ok(a1.v && a1.v.alert_type === 'panic_button' && a1.v.priority === 9, `panic button event became a P9 'panic_button' alert at CMS in ${(a1.ms / 1000).toFixed(1)} s`);
  ok(a1.v && Number(a1.v.camera_id) === camsCms[0].id, 'the alert carries the right CMS camera (M-NVR cam-1 -> CMS cam-1)');
  const inc = await until(async () => (await cmsDb.query(`SELECT i.id, p.name AS post FROM incident i JOIN rpf_post p ON p.id = i.post_id JOIN alert_delivery d ON d.id = i.alert_delivery_id WHERE d.alert_id = $1`, [a1.v && a1.v.id])).rows[0], 5000, 100);
  ok(inc.v, `CMS auto-created incident #${inc.v && inc.v.id} and dispatched it to ${inc.v && inc.v.post} (high priority, no operator involved)`);
  const tok = officerOf(inc.v.post);
  const rpfAlerts = (await http_(RPF, '/api/alerts?state=active', { token: tok })).data;
  ok(rpfAlerts.some((a) => Number(a.alert_id) === Number(a1.v.id) && Number(a.incident_id) === Number(inc.v.id)), `the officer at ${inc.v.post} sees the alert with its incident on the RPF dashboard (${((Date.now() - t0) / 1000).toFixed(1)} s after the event)`);

  const evInfo = await fx.addEvent({ type: 'DOOR_STATE', severity: 'INFO', title: 'Door closed', cameraId: ids[1] });
  const evSys = await fx.addEvent({ type: 'RECORDING_FAILURE', severity: 'ERROR', title: 'disk slow' });
  const evLow = await fx.addEvent({ type: 'AI_DETECTION', subtype: 'LOITERING', severity: 'WARNING', title: 'Loitering near door', cameraId: ids[1] });
  const evOverride = await fx.addEvent({ type: 'AI_DETECTION', severity: 'WARNING', title: 'Smoke model, 97% confidence', cameraId: ids[2], data: { priority: 10, alert_type: 'smoke' } });
  const low = await until(async () => (await cmsDb.query(`SELECT a.id, a.priority, a.status FROM alert a WHERE a.nvr_id = $1 AND a.nvr_event_id = $2`, [nvr.id, `mnvr-${evLow}`])).rows[0], 8000, 150);
  ok(low.v && low.v.priority === 3 && low.v.status === 'routed', 'a WARNING loitering event is a P3 alert, delivered to the nearest post automatically, without an incident');
  const ov = await until(async () => (await cmsDb.query(`SELECT a.priority, a.alert_type FROM alert a WHERE a.nvr_id = $1 AND a.nvr_event_id = $2`, [nvr.id, `mnvr-${evOverride}`])).rows[0], 8000, 150);
  ok(ov.v && ov.v.priority === 10 && ov.v.alert_type === 'smoke', "an event carrying its own priority/alert_type in event_data (an AI module) overrides the generic rules");
  const none = (await cmsDb.query(`SELECT count(*)::int AS n FROM alert WHERE nvr_id = $1 AND nvr_event_id = ANY($2)`, [nvr.id, [`mnvr-${evInfo}`, `mnvr-${evSys}`]])).rows[0].n;
  ok(none === 0, 'INFO door event and a system RECORDING_FAILURE event are NOT forwarded as security alerts');

  // ============ 3. footage on request (past window) ============
  console.log('3. footage: officer requests -> operator approves -> bridge uploads from the M-NVR recordings -> officer receives');
  const now = Date.now();
  const wS = now - 6 * 60000; const wE = now - 3 * 60000;
  const rq = await http_(RPF, `/api/incidents/${inc.v.id}/requests`, { method: 'POST', token: tok, body: { window_start: new Date(wS).toISOString(), window_end: new Date(wE).toISOString(), reason: 'e2e: review the panic button incident', camera_id: camsCms[0].id } });
  ok(rq.status === 201, `officer requested footage (request #${rq.data && rq.data.id}) for the incident, 3 minutes from camera cam-1`);
  const tA = Date.now();
  const ap = await op(`/requests/${rq.data.id}/approve`, { method: 'POST', body: { note: 'approved (e2e)' } });
  ok(ap.status === 200, `CMS operator approved it -> '${ap.data && ap.data.status}'`);
  const done = await until(async () => (await http_(RPF, `/api/requests/${rq.data.id}`, { token: tok })).data.request.status === 'fulfilled', 60000, 250);
  ok(done.v, `bridge uploaded the segments, CMS stitched them and the officer's request is 'fulfilled' ${((Date.now() - tA) / 1000).toFixed(1)} s after approval - no manual step on the train`);
  const rqD = (await http_(RPF, `/api/requests/${rq.data.id}`, { token: tok })).data; const f = rqD.footage && rqD.footage[0];
  ok(f && f.duration_s >= 180 && f.duration_s <= 230, `delivered ONE stitched clip of ${f && Math.round(f.duration_s)} s covering the 180 s window (whole ${fx.SEG_S} s segments)`);
  const stored = path.join(MEDIA, 'zone-1', `req-${rq.data.id}.mp4`);
  ok(fs.existsSync(stored) && crypto.createHash('sha256').update(fs.readFileSync(stored)).digest('hex') === f.sha256, 'stored clip hash matches what CMS recorded');
  const segs = (await cmsDb.query(`SELECT count(*)::int AS n, bool_and(upload_status='complete') AS all_ok FROM video_segment WHERE camera_id = $1 AND start_time < $3 AND end_time > $2`, [camsCms[0].id, new Date(wS), new Date(wE)])).rows[0];
  ok(segs.n >= 9 && segs.all_ok, `CMS catalogue holds ${segs.n} complete segments for that window (each SHA-256 verified on upload)`);
  const srcSegs = await fx.db.query(`SELECT file_path FROM recordings WHERE camera_id = $1 AND start_timestamp < $3 AND end_timestamp > $2 ORDER BY start_timestamp`, [ids[0], new Date(wS), new Date(wE)]);
  const first = srcSegs.rows[0].file_path; const cmsFirst = (await cmsDb.query(`SELECT object_key FROM video_segment WHERE camera_id = $1 ORDER BY start_time LIMIT 1`, [camsCms[0].id])).rows[0].object_key;
  ok(crypto.createHash('sha256').update(fs.readFileSync(first)).digest('hex') === crypto.createHash('sha256').update(fs.readFileSync(path.join(MEDIA, cmsFirst))).digest('hex'), 'a segment at CMS is byte-identical to the file recorded on the M-NVR');
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', stored])).format.duration;
  ok(Number(probe) > 170, `the delivered file plays (ffprobe reads ${Number(probe).toFixed(0)} s)`);
  const tr = (await (await fetch('http://127.0.0.1:8096/transfers')).json()).transfers.find((x) => Number(x.request_id) === Number(rq.data.id));
  ok(tr && tr.status === 'completed' && tr.percent === 100 && tr.segments_done === tr.segments_total && tr.bytes_sent === tr.bytes_total && tr.bytes_total > 0, `the M-NVR transfer view shows request #${rq.data.id} as completed, 100%, ${tr && tr.segments_done}/${tr && tr.segments_total} segments, ${tr && tr.bytes_sent}/${tr && tr.bytes_total} bytes`);
  ok((await http_(RPF, '/api/notifications', { token: tok })).data.some((n) => n.kind === 'footage' && n.ref_id === f.id), 'the post got a "footage ready" notification');

  // ============ 4. footage while the M-NVR is still recording ============
  console.log('4. footage up to "now" (the segment still being recorded)');
  const rq2 = await http_(RPF, `/api/incidents/${inc.v.id}/requests`, { method: 'POST', token: tok, body: { window_start: new Date(Date.now() - 60000).toISOString(), window_end: new Date().toISOString(), reason: 'e2e: live tail', camera_id: camsCms[1].id } });
  const reqEnd = Date.now();
  await op(`/requests/${rq2.data.id}/approve`, { method: 'POST', body: {} });
  const d2 = await until(async () => (await http_(RPF, `/api/requests/${rq2.data.id}`, { token: tok })).data.request.status === 'fulfilled', 120000, 500);
  const r2 = (await http_(RPF, `/api/requests/${rq2.data.id}`, { token: tok })).data;
  ok(d2.v, `request ending "now" was fulfilled after ${(d2.ms / 1000).toFixed(0)} s (bridge waited for the open segment to finish)`);
  const endT = r2.footage[0] && new Date(r2.footage[0].end_time).getTime();
  ok(endT && endT >= reqEnd - 1500 - fx.SEG_S * 1000 * 0 && !/partial/i.test(r2.request.decision_note || ''), 'delivery is complete up to the moment of the request (no "partial delivery" note)');

  // ============ 5. nothing recorded ============
  console.log('5. window with no recording');
  const rq3 = await http_(RPF, `/api/incidents/${inc.v.id}/requests`, { method: 'POST', token: tok, body: { window_start: new Date(Date.now() - 3 * 3600000).toISOString(), window_end: new Date(Date.now() - 3 * 3600000 + 120000).toISOString(), reason: 'e2e: before recording started', camera_id: camsCms[2].id } });
  await op(`/requests/${rq3.data.id}/approve`, { method: 'POST', body: {} });
  const d3 = await until(async () => ['failed', 'fulfilled'].includes((await http_(RPF, `/api/requests/${rq3.data.id}`, { token: tok })).data.request.status), 30000, 300);
  const r3 = (await http_(RPF, `/api/requests/${rq3.data.id}`, { token: tok })).data.request;
  ok(r3.status === 'failed' && /no recording/i.test(r3.failure_reason || ''), `the bridge honestly reports "no recording for this window" -> request failed with: ${r3.failure_reason}`);

  // ============ 6. dropped upload resumes ============
  console.log('6. upload interrupted mid-way resumes (no restart from zero)');
  await stopBridge();
  proxy.chunkPuts = 0; proxy.failChunk = 4; proxy.injected = 0;
  startBridge({ CHUNK_BYTES: '4096' });
  await until(async () => (await cmsDb.query(`SELECT 1 FROM nvr_unit WHERE id=$1 AND last_seen > now() - interval '10 seconds'`, [nvr.id])).rowCount, 15000);
  const rq4 = await http_(RPF, `/api/incidents/${inc.v.id}/requests`, { method: 'POST', token: tok, body: { window_start: new Date(Date.now() - 12 * 60000).toISOString(), window_end: new Date(Date.now() - 11 * 60000).toISOString(), reason: 'e2e: resume', camera_id: camsCms[2].id } });
  await op(`/requests/${rq4.data.id}/approve`, { method: 'POST', body: {} });
  const d4 = await until(async () => (await http_(RPF, `/api/requests/${rq4.data.id}`, { token: tok })).data.request.status === 'fulfilled', 60000, 300);
  ok(proxy.injected === 1, 'a chunk upload was made to fail with a 502 in the middle of a segment');
  ok(d4.v, 'the request still completed: the bridge resumed from the last chunk CMS had stored');
  ok(!logged(/SHA-256 mismatch|checksum/i), 'no corrupted segment: every segment passed CMS SHA-256 verification');

  // ============ 7. tunnel: no coverage, then back ============
  console.log('7. train in a tunnel (no contact with CMS), then back in coverage');
  proxy.down = true;
  const evTunnel = await fx.addEvent({ type: 'PANIC_BUTTON', severity: 'EMERGENCY', title: 'Panic inside the tunnel', cameraId: ids[0] });
  const gpsBefore = Number((await cmsDb.query(`SELECT count(*) FROM gps_point WHERE nvr_id = $1`, [nvr.id])).rows[0].count);
  await sleep(14000);
  ok(!(await cmsDb.query(`SELECT 1 FROM alert WHERE nvr_id = $1 AND nvr_event_id = $2`, [nvr.id, `mnvr-${evTunnel}`])).rowCount, 'while offline the alert is held on the train (not lost, not yet at CMS)');
  ok(logged(/no contact with CMS/), 'the bridge logged the loss of coverage');
  proxy.down = false;
  const back = await until(async () => (await cmsDb.query(`SELECT 1 FROM alert WHERE nvr_id = $1 AND nvr_event_id = $2`, [nvr.id, `mnvr-${evTunnel}`])).rowCount, 20000, 300);
  ok(back.v, `back in coverage: the held alert reached CMS ${(back.ms / 1000).toFixed(1)} s later, with its ORIGINAL event time`);
  const evRow = (await cmsDb.query(`SELECT event_time FROM alert WHERE nvr_id = $1 AND nvr_event_id = $2`, [nvr.id, `mnvr-${evTunnel}`])).rows[0];
  ok(evRow && Math.abs(new Date(evRow.event_time).getTime() - (Date.now() - back.ms - 14000)) < 20000, 'event_time is when it happened, not when it was delivered');
  const gpsAfter = await until(async () => Number((await cmsDb.query(`SELECT count(*) FROM gps_point WHERE nvr_id = $1`, [nvr.id])).rows[0].count) > gpsBefore + 3, 15000);
  ok(gpsAfter.v, 'the GPS fixes recorded during the outage were back-filled into the CMS track');

  // ============ 8. restart: nothing duplicated, nothing lost ============
  console.log('8. bridge restart');
  const sentBefore = Number((await cmsDb.query(`SELECT count(*) FROM alert WHERE nvr_id = $1`, [nvr.id])).rows[0].count);
  await stopBridge();
  const evWhileDown = await fx.addEvent({ type: 'TAMPERING', severity: 'CRITICAL', title: 'Camera tampering while bridge was down', cameraId: ids[1] });
  startBridge();
  const dn = await until(async () => (await cmsDb.query(`SELECT 1 FROM alert WHERE nvr_id = $1 AND nvr_event_id = $2`, [nvr.id, `mnvr-${evWhileDown}`])).rowCount, 20000, 300);
  ok(dn.v, 'an event raised while the bridge was stopped is sent after restart');
  await sleep(2000);
  const sentAfter = Number((await cmsDb.query(`SELECT count(*) FROM alert WHERE nvr_id = $1`, [nvr.id])).rows[0].count);
  ok(sentAfter === sentBefore + 1, `no old event was re-sent (${sentBefore} -> ${sentAfter} alerts)`);

  // ============ 9. optional: footage pushed ahead of the request ============
  console.log('9. optional pre-upload around a serious alert (AUTO_UPLOAD_ON_ALERT)');
  await stopBridge();
  startBridge({ AUTO_UPLOAD_ON_ALERT: '1', AUTO_UPLOAD_PRE_S: '20', AUTO_UPLOAD_POST_S: '10' });
  await sleep(3000);
  const evAuto = await fx.addEvent({ type: 'INTRUSION', severity: 'CRITICAL', title: 'Intruder in cab', cameraId: ids[2] });
  const evAt = Date.now();
  const pre = await until(async () => (await cmsDb.query(`SELECT count(*)::int AS n FROM video_segment WHERE camera_id = $1 AND start_time > $2 AND upload_status = 'complete'`, [camsCms[2].id, new Date(evAt - 60000)])).rows[0].n >= 2, 150000, 1000);
  ok(pre.v, `without anyone asking, footage around the alert was already at CMS ${(pre.ms / 1000).toFixed(0)} s later - so the officer's later request is delivered instantly`);

  await stopBridge(); stopLive(); proxySrv.close(); await cmsDb.end(); await fx.db.end();
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('e2e error:', e); try { await stopBridge(); } catch (_) {} process.exit(2); });
