#!/usr/bin/env node
/**
 * End-to-end test of the whole chain  M-NVR -> CMS -> RPF  against running servers (dev database only).
 *   CMS_URL=http://localhost:7080 RPF_URL=http://localhost:7090 DB_PASSWORD=... node test/flow.js
 * Needs: ffmpeg/ffprobe, fixtures applied (sql/fixtures.sql), RPF demo users (rpf: npm run seed-demo).
 * It starts the M-NVR simulator itself. It writes alerts, incidents, requests and flags.
 */
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const CMS = process.env.CMS_URL || 'http://localhost:7080'; const RPF = process.env.RPF_URL || 'http://localhost:7090';
const SIM = path.join(__dirname, '..', 'scripts', 'mnvr_sim.js');
const MEDIA = process.env.MEDIA_ROOT || path.join(__dirname, '..', 'media');
const LOCAL = process.env.LOCAL_EVIDENCE_DIR || path.join(__dirname, '..', '..', 'rpf', 'local-evidence');
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ok   -' : '  FAIL -'} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(base, p, { method = 'GET', token, body, headers = {}, raw } = {}) {
  const res = await fetch(base + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return res;
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const login = async (base, prefix, u, pw) => (await http(base, `${prefix}/auth/login`, { method: 'POST', body: { username: u, password: pw } })).data.token;
const nvrPost = (fp, p, body) => http(CMS, `/nvr/v1${p}`, { method: 'POST', body, headers: { 'X-NVR-Fingerprint': fp } });
async function until(fn, ms = 20000, step = 150) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return { v, ms: Date.now() - t0 }; if (Date.now() - t0 > ms) return { v: null, ms: Date.now() - t0 }; await sleep(step); } }

(async () => {
  const opTok = await login(CMS, '/console/api', 'cms-operator', 'cms-demo-123');
  const adminTok = await login(CMS, '/console/api', 'cms-zone1-admin', 'cms-demo-123');
  const offA = await login(RPF, '/api', 'post-a-officer', 'rpf-demo-123');
  const offB = await login(RPF, '/api', 'post-b-officer', 'rpf-demo-123');
  const supTok = await login(CMS, '/console/api', 'cms-super', 'cms-demo-123');
  const setLow = (mode) => http(CMS, '/console/api/settings', { method: 'PUT', token: supTok, body: { low_priority_mode: mode } });
  await setLow('operator_queue');   // the next sections test the "hold for an operator" mode; auto-delivery is tested separately
  ok(opTok && offA && offB && adminTok, 'operator, zone admin and two post officers can sign in');

  const op = (p, o = {}) => http(CMS, `/console/api${p}`, { token: opTok, ...o });
  const rA = (p, o = {}) => http(RPF, `/api${p}`, { token: offA, ...o });
  const tag = crypto.randomBytes(3).toString('hex');
  const cams = (await rA('/cameras')).data; const cam = cams.find((c) => c.nvr_name === 'nvr-1');
  ok(cam, `officer sees cameras of nvr-1 (${cams.length} in zone)`);

  // --- live latency: officer's SSE stream gets the event when the NVR posts an alert
  console.log('live stream');
  const tk = (await rA('/stream-ticket', { method: 'POST', body: {} })).data.ticket;
  const sse = await fetch(`${RPF}/api/stream?ticket=${tk}`); const reader = sse.body.getReader(); const events = []; let buf = '';
  (async () => { const dec = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) return; buf += dec.decode(value); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const m = blk.match(/^event: (\w+)\ndata: (.*)$/m); if (m && m[1] === 'change') events.push({ at: Date.now(), ...JSON.parse(m[2]) }); } } })().catch(() => {});
  await sleep(500);

  // --- 0. test lab: the console can act as the train's VMS
  console.log('test lab (send an alert as the NVR from the console)');
  const lab = (await op('/dev/state')).data;
  ok(lab.nvrs.length >= 1 && lab.posts.length >= 1, `lab lists ${lab.nvrs.length} unit(s) and ${lab.posts.length} post(s)`);
  const postA = lab.posts.find((p) => p.name === 'Post A');
  const labAlert = await op('/dev/alert', { method: 'POST', body: { nvr_id: cam.nvr_id, alert_type: 'panic button', priority: 9, near_post_id: postA.id } });
  ok(labAlert.status === 201 && labAlert.data.dispatched && labAlert.data.post_name === 'Post A' && labAlert.data.incidentId, `lab alert next to Post A: auto-dispatched to ${labAlert.data.post_name}, incident #${labAlert.data.incidentId}`);
  ok((await rA('/incidents')).data.some((i) => i.id === labAlert.data.incidentId), 'the officer at Post A sees that incident');
  ok((await op('/dev/alert', { method: 'POST', body: { nvr_id: cam.nvr_id, alert_type: 'x', priority: 11 } })).status === 400, 'lab rejects priority 11');

  // --- 1. high priority: auto-dispatch + incident
  console.log('high priority alert (auto)');
  const t0 = Date.now();
  const evTime = new Date().toISOString();
  const hiBody = { nvr_event_id: `t-${tag}-hi`, alert_type: 'intrusion', priority: 9, lat: 26.0, lon: 80.12, camera_id: cam.id, event_time: evTime };
  const hi = (await nvrPost('fp-demo-1', '/alerts', hiBody)).data;
  ok(hi.dispatched && hi.incidentId, `P9 auto-dispatched, incident #${hi.incidentId} created (no operator involved)`);
  const evt = await until(() => events.find((e) => e.t === 'alert_delivery' && e.at >= t0), 3000, 20);
  ok(evt.v && evt.v.at - t0 < 500, `post officer's browser stream was notified in ${evt.v ? evt.v.at - t0 : '>3000'} ms`);
  const alertsA = (await rA('/alerts?state=active')).data;
  const hiRow = alertsA.find((a) => a.incident_id === hi.incidentId);
  ok(hiRow && hiRow.incident_source === 'auto', 'RPF inbox shows the alert with its auto-created incident');
  const dup = (await nvrPost('fp-demo-1', '/alerts', hiBody)).data;
  ok(dup.duplicate === true && dup.alert.id === hi.alert.id, 'NVR retry of the same event is idempotent (same alert, no second incident)');
  const old = await nvrPost('fp-demo-1', '/alerts', { nvr_event_id: `t-${tag}-old`, alert_type: 'loitering', priority: 2, lat: 26.0, lon: 80.12, camera_id: cam.id, event_time: new Date(Date.now() - 200 * 86400000).toISOString() });
  ok(old.status === 201, 'an event from 200 days ago (unit was offline for ages) is still accepted');
  ok((await nvrPost('fp-demo-1', '/alerts', { nvr_event_id: `t-${tag}-fut`, alert_type: 'x', priority: 2, lat: 26, lon: 80, event_time: new Date(Date.now() + 86400000).toISOString() })).status === 400, 'an event dated in the future (bad clock) is rejected');

  // --- 2. low priority: CMS queue, operator forwards, officer raises incident
  console.log('low priority alert (operator queue -> forward -> officer raises incident)');
  const lo = (await nvrPost('fp-demo-1', '/alerts', { nvr_event_id: `t-${tag}-lo`, alert_type: 'loitering', priority: 3, lat: 26.0, lon: 80.12, camera_id: cam.id })).data;
  ok(!lo.dispatched && lo.alert.status === 'new', 'P3 is NOT dispatched - waits for an operator');
  ok(!(await rA('/alerts?state=all')).data.some((a) => a.alert_id === lo.alert.id), 'post cannot see it yet');
  const queue = (await op('/alerts?queue=1')).data.rows;
  ok(queue.some((a) => a.id === lo.alert.id), 'it is in the CMS operator queue');
  const detail = (await op(`/alerts/${lo.alert.id}`)).data;
  ok(detail.candidates.length >= 1, `operator sees candidate posts, nearest first (${detail.candidates.map((c) => c.name).join(', ')})`);
  const t1 = Date.now();
  const fw = await op(`/alerts/${lo.alert.id}/forward`, { method: 'POST', body: { post_id: detail.candidates[0].id } });
  ok(fw.status === 201 && !fw.data.incidentId, 'operator forwards to the nearest post (no incident)');
  const dupFw = await op(`/alerts/${lo.alert.id}/forward`, { method: 'POST', body: { post_id: detail.candidates[0].id } });
  ok(dupFw.status === 409, 'forwarding twice is refused (409)');
  const nearestOfficer = detail.candidates[0].name === 'Post A' ? offA : offB;
  const rN = (p, o = {}) => http(RPF, `/api${p}`, { token: nearestOfficer, ...o });
  const fwdRow = (await rN('/alerts?state=active')).data.find((a) => a.alert_id === lo.alert.id);
  ok(fwdRow && fwdRow.mode === 'operator' && !fwdRow.incident_id, 'post receives it as "forwarded by operator", no incident yet');
  const inc2 = await rN('/incidents', { method: 'POST', body: { delivery_id: fwdRow.delivery_id, title: 'Loiterer at platform 2' } });
  ok(inc2.status === 201, `officer raises incident #${inc2.data.id} from the forwarded alert`);
  ok((await rN('/incidents', { method: 'POST', body: { delivery_id: fwdRow.delivery_id } })).status === 409, 'a second incident for the same alert is refused');

  // --- 3. manual incident (no alert)
  console.log('manual incident');
  const bad = await rA('/incidents', { method: 'POST', body: { manual: true, title: 'x', camera_id: 99999 } });
  ok(bad.status === 400, 'manual incident with an unknown camera is rejected');
  const man = await rA('/incidents', { method: 'POST', body: { manual: true, title: 'Passenger reports bag theft', category: 'theft', camera_id: cam.id, occurred_at: new Date(Date.now() - 5 * 60000).toISOString(), priority: 4, description: 'Coach C1' } });
  ok(man.status === 201, `officer raises a manual incident #${man.data.id}`);
  const manDetail = (await rA(`/incidents/${man.data.id}`)).data;
  ok(manDetail.incident.source === 'manual' && manDetail.incident.camera_name, 'manual incident carries source=manual and its camera/train');
  ok((await op(`/incidents/${man.data.id}`)).status === 200, 'CMS operator sees the manual incident too');


  // --- 2b. the default: below-threshold alerts are delivered to the post automatically (no incident)
  console.log('low priority alert, default mode (auto-deliver)');
  await setLow('auto_deliver');
  const lo3 = (await nvrPost('fp-demo-1', '/alerts', { nvr_event_id: `t-${tag}-lo3`, alert_type: 'loitering', priority: 3, lat: 26.0, lon: 80.101, camera_id: cam.id })).data;
  ok(lo3.dispatched && !lo3.incidentId, 'a P3 alert is delivered to the nearest post at once, WITHOUT an incident');
  const lo3Row = (await rA('/alerts?state=active')).data.find((a) => a.alert_id === lo3.alert.id);
  ok(lo3Row && lo3Row.mode === 'auto' && !lo3Row.incident_id && lo3Row.priority === 3, "it shows in the officer's alerts as low priority, no incident yet");
  ok((await rA('/incidents', { method: 'POST', body: { delivery_id: lo3Row.delivery_id, title: 'Officer decides to raise one' } })).status === 201, 'the officer raises the incident manually when needed');
  ok(!(await op('/alerts?queue=1')).data.rows.some((a) => a.id === lo3.alert.id), 'it is not stuck in the CMS queue');
  const badMode = await http(CMS, '/console/api/settings', { method: 'PUT', token: supTok, body: { low_priority_mode: 'nonsense' } });
  ok(badMode.status === 400, 'an invalid routing mode is rejected');
  await setLow('operator_queue');

  // --- 2c. filters and sorting
  console.log('filters and sorting');
  const sorted = (await op('/alerts?sort=prio&limit=20')).data.rows;
  ok(sorted.every((r, i) => i === 0 || sorted[i - 1].priority >= r.priority), 'CMS alerts sort by priority (high first)');
  const hiOnly = (await op('/alerts?priority_min=7&limit=50')).data.rows;
  ok(hiOnly.length > 0 && hiOnly.every((r) => r.priority >= 7), 'CMS alerts filter: high priority only');
  const srch = (await op('/alerts?q=loitering&limit=50')).data.rows;
  ok(srch.length > 0 && srch.every((r) => r.alert_type.includes('loitering')), 'CMS alerts search finds by type');
  ok((await op('/alerts?when=today&limit=5')).status === 200 && (await op('/incidents?prio=high&sort=prio')).status === 200 && (await op('/requests?q=x&sort=old&when=7d')).status === 200, 'incident / request filters and sorts are accepted');
  ok((await op("/alerts?q=%27%3B--&sort=drop")).status === 200, 'odd search text and an unknown sort cannot break the query');

  // --- 3b. counters agree, dismiss, work-as-post, action notes
  console.log('counters / dismiss / work as a post / action notes');
  const adm = await login(RPF, '/api', 'zone1-admin', 'rpf-demo-123');
  const rAdm = (p, o = {}) => http(RPF, `/api${p}`, { token: adm, ...o });
  const { Client: PgClient } = require('pg'); const db0 = new PgClient({ host: 'localhost', user: 'cms', password: process.env.DB_PASSWORD || 'cms', database: process.env.DB_NAME || 'cms' }); await db0.connect();
  const escA = (await op('/dev/alert', { method: 'POST', body: { nvr_id: cam.nvr_id, alert_type: 'tamper', priority: 9, near_post_id: postA.id } })).data;
  await db0.query(`UPDATE alert_delivery SET sent_at = now() - interval '20 minutes' WHERE alert_id = $1`, [escA.alert.id]);
  await http(CMS, '/console/api/jobs/escalation/run', { method: 'POST', token: supTok, body: {} });
  const nDel = (await db0.query(`SELECT count(*)::int AS n FROM alert_delivery WHERE alert_id = $1`, [escA.alert.id])).rows[0].n;
  ok(nDel === 2, `an unanswered alert was escalated: it now sits at ${nDel} posts (so a delivery count would double-count it)`);
  const cntBefore = (await op('/counts')).data.unacked; const sumBefore = Number((await rAdm('/alerts/summary')).data.unacked); const listBefore = (await rAdm('/alerts?state=unacked')).data.length;
  ok(cntBefore === sumBefore && sumBefore === listBefore && cntBefore >= 1, `CMS badge = RPF tile = RPF list: ${cntBefore} = ${sumBefore} = ${listBefore} (counted per ALERT everywhere)`);
  const dis = await op(`/alerts/${escA.alert.id}/dismiss`, { method: 'POST', body: { reason: 'test: not real' } });
  ok(dis.status === 200, 'CMS can dismiss an escalated alert (it used to say "not found")');
  ok((await op('/counts')).data.unacked === cntBefore - 1 && Number((await rAdm('/alerts/summary')).data.unacked) === cntBefore - 1, 'dismissing lowers the count on both sides');
  ok((await rA('/notifications')).data.some((n) => /dismissed by the control room/.test(n.title)), 'the post is told the alert was dismissed');
  ok((await op(`/alerts/${escA.alert.id}/dismiss`, { method: 'POST', body: { reason: 'again' } })).status === 404, 'dismissing it twice is refused');

  const act = (p, o = {}) => http(RPF, `/api${p}`, { token: adm, headers: { 'X-Act-As-Post': String(postA.id) }, ...o });
  const mBody = { manual: true, title: 'Raised by admin on behalf of Post A', camera_id: cam.id, priority: 4 };
  ok((await rAdm('/incidents', { method: 'POST', body: mBody })).status === 403, 'a zone admin viewing all posts cannot raise incidents');
  const actInc = await act('/incidents', { method: 'POST', body: mBody });
  ok(actInc.status === 201, `the same admin, working AS Post A, can (incident #${actInc.data.id})`);
  ok((await rA(`/incidents/${actInc.data.id}`)).status === 200, 'it belongs to Post A (its officer sees it)');
  const postC = (await http(CMS, '/console/api/posts', { token: supTok })).data.find((p) => p.name === 'Post C');
  ok((await http(RPF, '/api/incidents', { method: 'POST', token: adm, headers: { 'X-Act-As-Post': String(postC.id) }, body: mBody })).status === 403, 'a zone admin cannot work as a post in another zone');
  const audit = (await db0.query(`SELECT details FROM audit_log WHERE action = 'incident.create' AND entity_id = $1`, [actInc.data.id])).rows[0];
  ok(audit && audit.details.acting_for_post === postA.id, 'the audit trail records who really did it (admin, acting for the post)');

  const lo2 = (await nvrPost('fp-demo-1', '/alerts', { nvr_event_id: `t-${tag}-note`, alert_type: 'crowding', priority: 4, lat: 26.0, lon: 80.12, camera_id: cam.id })).data;
  await op(`/alerts/${lo2.alert.id}/forward`, { method: 'POST', body: { post_id: postA.id } });
  const d2 = (await rA('/alerts?state=active')).data.find((x) => x.alert_id === lo2.alert.id);
  ok((await rA(`/alerts/${d2.delivery_id}/notes`, { method: 'POST', body: { text: 'Team dispatched to coach C2' } })).status === 201, 'officer records an action note on an alert');
  ok((await rA(`/alerts/${d2.delivery_id}/notes`, { method: 'POST', body: { text: '' } })).status === 400, 'an empty note is refused');
  ok((await op(`/alerts/${lo2.alert.id}`)).data.history.some((h) => /Action note: Team dispatched/.test(h.note || '')), 'CMS sees that note in the alert history');
  ok((await rA(`/alerts/${d2.delivery_id}/resolve`, { method: 'POST', body: { note: '' } })).status === 400, 'resolving needs a note saying what was done');
  ok((await rA(`/alerts/${d2.delivery_id}/resolve`, { method: 'POST', body: { note: 'Checked the coach, passengers dispersed' } })).status === 200, 'officer resolves an alert that needs no incident, with the action taken');
  ok(!(await rA('/alerts?state=active')).data.some((x) => x.alert_id === lo2.alert.id) && (await rA('/alerts?state=closed')).data.some((x) => x.alert_id === lo2.alert.id), 'a resolved alert leaves "Active" and shows under "Closed"');
  const tl = (await rA(`/incidents/${hi.incidentId}`)).data.timeline;
  ok(tl.some((x) => x.action === 'alert.routed'), 'an auto-created incident shows how it was dispatched in its timeline');
  await db0.end();

  // --- 4. footage: request -> approve -> NVR upload -> deliver
  console.log('footage request for the manual incident');
  const sim = spawn('node', [SIM, 'run', '--units', '1'], { env: { ...process.env, CODEC: process.env.CODEC || 'h264' }, stdio: 'ignore' });
  process.on('exit', () => sim.kill());
  await sleep(2500);
  const now = Date.now();
  const rq = await rA(`/incidents/${man.data.id}/requests`, { method: 'POST', body: { window_start: new Date(now - 5 * 60000).toISOString(), window_end: new Date(now - 2 * 60000).toISOString(), reason: 'bag theft' } });
  ok(rq.status === 201, `request #${rq.data.id} submitted for the incident`);
  const sub = (await op(`/requests?tab=decide`)).data.rows.find((r) => r.id === rq.data.id);
  ok(sub && sub.incident_id === man.data.id, 'it appears in the operator "needs decision" tab, linked to the incident');
  const tA = Date.now();
  const ap = await op(`/requests/${rq.data.id}/approve`, { method: 'POST', body: { note: 'approved' } });
  ok(ap.status === 200 && ['awaiting_upload', 'fulfilled'].includes(ap.data.status), `operator approves -> '${ap.data.status}' (footage is on the train, CMS commands the NVR)`);
  const done = await until(async () => (await rA(`/requests/${rq.data.id}`)).data.request.status === 'fulfilled', 60000, 200);
  ok(done.v, `NVR uploaded, CMS stitched and delivered in ${((Date.now() - tA) / 1000).toFixed(1)} s`);
  const rqD = (await rA(`/requests/${rq.data.id}`)).data; const f = rqD.footage[0];
  ok(f && f.duration_s > 170 && f.duration_s < 190, `delivered file is a single stitched clip, ${f && Math.round(f.duration_s)} s (asked for 180 s)`);
  const absf = path.join(MEDIA, 'zone-1', `req-${rq.data.id}.mp4`);
  ok(fs.existsSync(absf) && crypto.createHash('sha256').update(fs.readFileSync(absf)).digest('hex') === f.sha256, 'sha256 of the stored file matches the recorded hash');
  const notes = (await rA('/notifications')).data;
  ok(notes.some((n) => n.kind === 'footage' && n.ref_id === f.id), 'post got a "footage ready" notification');

  // --- 5. view, section download, flag section for life
  console.log('view / section download / flag');
  const view = (await rA(`/footage/${f.id}/access`, { method: 'POST', body: { purpose: 'view' } })).data;
  const rg = await fetch(RPF + view.url, { headers: { Range: 'bytes=0-1023' } });
  ok(rg.status === 206 && (await rg.arrayBuffer()).byteLength === 1024, 'playback link supports HTTP Range (seekable)');
  const dl = (await rA(`/footage/${f.id}/access`, { method: 'POST', body: { purpose: 'download', start_s: 40, end_s: 70 } })).data;
  const clipRes = await fetch(RPF + dl.url); const clipBuf = Buffer.from(await clipRes.arrayBuffer());
  fs.writeFileSync('/tmp/section.mp4', clipBuf);
  const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', '/tmp/section.mp4']).toString());
  ok(clipRes.status === 200 && /attachment/.test(clipRes.headers.get('content-disposition')) && dur > 28 && dur < 33, `"save section to PC" returns just that section: ${dur.toFixed(1)} s of a 180 s file`);
  ok((await rA(`/footage/${f.id}/access`, { method: 'POST', body: { purpose: 'download', start_s: 70, end_s: 40 } })).status === 400, 'inverted section is rejected');
  ok((await rA(`/footage/${f.id}/access`, { method: 'POST', body: { purpose: 'download', start_s: 10, end_s: 99999 } })).status === 400, 'section beyond the end of the footage is rejected');
  ok((await rA(`/footage/${f.id}/flag`, { method: 'POST', body: { justification: '', retention: 'permanent', start_s: 40, end_s: 70 } })).status === 400, 'flag without a justification is rejected');
  ok((await http(RPF, `/api/footage/${f.id}/flag`, { method: 'POST', token: offB, body: { justification: 'x', retention: 'permanent' } })).status === 404, "another post cannot flag this post's footage");
  const tF = Date.now();
  const fl = await rA(`/footage/${f.id}/flag`, { method: 'POST', body: { justification: 'Suspect visible 0:40-1:10', retention: 'permanent', start_s: 40, end_s: 70 } });
  ok(fl.status === 201 && fl.data.retention === 'permanent' && fl.data.retain_to === null, `section flagged FOR LIFE (flag #${fl.data.id})`);
  const arch = await until(async () => (await rA('/flags')).data.find((x) => x.id === fl.data.id && x.archive_status === 'archived'), 30000, 150);
  ok(arch.v, `CMS archived the section to permanent storage in ${((Date.now() - tF) / 1000).toFixed(1)} s`);
  const aflag = arch.v;
  const apath = path.join(MEDIA, 'archive', 'zone-1', `flag-${fl.data.id}.mp4`);
  const adur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', apath]).toString());
  ok(fs.existsSync(apath) && adur > 28 && adur < 33 && aflag.archive_sha256 === crypto.createHash('sha256').update(fs.readFileSync(apath)).digest('hex'), `archived clip is the 30 s section (${adur.toFixed(1)} s) with a verified hash`);
  ok(aflag.incident_id === man.data.id, 'the flag is linked to the incident');
  const fa = (await rA(`/flags/${fl.data.id}/access`, { method: 'POST', body: { purpose: 'download' } })).data;
  const fres = await fetch(RPF + fa.url);
  ok(fres.status === 200 && (await fres.arrayBuffer()).byteLength === aflag.archive_size_bytes, 'officer downloads the archived evidence clip to the PC');
  ok((await op(`/evidence/${fl.data.id}`)).data.custody.length >= 2, 'CMS shows the chain of custody (flag, archive, views)');

  // --- 5b. where to keep it: locally at the post, or both
  console.log('where to keep the recording (CMS / local / both)');
  const fl2 = await rA(`/footage/${f.id}/flag`, { method: 'POST', body: { justification: 'local copy test', retention: 'timed', retain_to: new Date(Date.now() + 7 * 86400000).toISOString(), storage: 'local', start_s: 100, end_s: 120 } });
  ok(fl2.status === 201 && fl2.data.storage === 'local' && fl2.data.archive_status === 'not_requested' && !fl2.data.local_error, `flag #${fl2.data.id}: stored LOCALLY at the post only (CMS archive: ${fl2.data.archive_status})`);
  const lf = (await rA('/flags')).data.find((x) => x.id === fl2.data.id);
  const lpath = path.join(LOCAL, lf.local_path || 'missing');
  const ldur = fs.existsSync(lpath) ? parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', lpath]).toString()) : 0;
  ok(lf.has_local && ldur > 18 && ldur < 23 && lf.local_sha256 === crypto.createHash('sha256').update(fs.readFileSync(lpath)).digest('hex'), `local copy saved in the post's own store: ${lf.local_path} (${ldur.toFixed(1)} s, hash verified)`);
  const side = JSON.parse(fs.readFileSync(lpath.replace(/\.mp4$/, '.json'), 'utf8'));
  ok(side.entered.storage === 'local' && side.entered.retain_until && side.section_start_s === 100 && side.section_end_s === 120 && side.entered.justification, 'a .json next to the file records what the officer entered (section, retention time, justification, who, when)');
  await sleep(2500);
  ok((await rA('/flags')).data.find((x) => x.id === fl2.data.id).archive_status === 'not_requested' && !fs.existsSync(path.join(MEDIA, 'archive', 'zone-1', `flag-${fl2.data.id}.mp4`)), 'CMS did NOT archive a local-only flag');
  ok((await rA(`/flags/${fl2.data.id}/access`, { method: 'POST', body: { purpose: 'view', source: 'cms' } })).status === 400, 'asking for the CMS copy of a local-only flag is refused');
  const la = (await rA(`/flags/${fl2.data.id}/access`, { method: 'POST', body: { purpose: 'download', source: 'local' } })).data;
  const lres = await fetch(RPF + la.url);
  ok(lres.status === 200 && (await lres.arrayBuffer()).byteLength === lf.local_size_bytes, 'officer plays / downloads the local copy through the dashboard');
  ok((await op(`/evidence/${fl2.data.id}`)).data.flag.storage === 'local', 'CMS shows the flag as locally stored (and holds no clip)');
  const fl3 = await rA(`/footage/${f.id}/flag`, { method: 'POST', body: { justification: 'both test', retention: 'permanent', storage: 'both', start_s: 130, end_s: 150 } });
  const both = await until(async () => (await rA('/flags')).data.find((x) => x.id === fl3.data.id && x.archive_status === 'archived' && x.has_local), 20000, 200);
  ok(both.v, 'storage "both": CMS archived it AND the post has a local copy');

  // --- 6. retention honours the flag
  console.log('retention');
  const { Client } = require('pg'); const db = new Client({ host: 'localhost', user: 'cms', password: process.env.DB_PASSWORD || 'cms', database: process.env.DB_NAME || 'cms' }); await db.connect();
  await db.query(`UPDATE video_segment SET start_time = start_time - interval '40 days', end_time = end_time - interval '40 days' WHERE camera_id = $1`, [cam.id]);
  // the section's absolute times are fixed on the flag; shift them too so the flag still overlaps its segments
  await db.query(`UPDATE evidence_flag SET section_from = section_from - interval '40 days', section_to = section_to - interval '40 days' WHERE id = $1`, [fl.data.id]);
  const preview = (await http(CMS, '/console/api/retention', { token: adminTok })).data;
  ok(preview.protected_count > 0 && preview.due_count > 0, `preview: ${preview.due_count} segment(s) due, ${preview.protected_count} protected by the flag`);
  const sup = await login(CMS, '/console/api', 'cms-super', 'cms-demo-123');
  const run = (await http(CMS, '/console/api/retention/run', { method: 'POST', token: sup, body: {} })).data;
  const left = (await db.query(`SELECT count(*)::int AS n FROM video_segment WHERE camera_id = $1`, [cam.id])).rows[0].n;
  ok(run.deleted > 0 && left > 0 && left <= preview.protected_count, `retention deleted ${run.deleted} old segment(s), kept ${left} under the evidence flag`);
  ok(fs.existsSync(apath) && fs.existsSync(absf), 'archived clip and delivered footage are untouched by retention');
  await db.end();

  // --- 7. admin: release the hold
  const rel = await http(CMS, `/console/api/evidence/${fl.data.id}/release`, { method: 'POST', token: adminTok, body: { note: 'case closed' } });
  ok(rel.status === 200, 'zone admin releases the hold (archive copy is kept)');
  ok((await rA('/flags')).data.find((x) => x.id === fl.data.id).status === 'released', 'post sees the flag as released');

  // --- 8. close incident
  ok((await rA(`/incidents/${man.data.id}/status`, { method: 'PATCH', body: { status: 'closed', note: 'resolved' } })).status === 200, 'officer closes the incident');
  ok((await rA(`/incidents/${man.data.id}/requests`, { method: 'POST', body: {} })).status === 409, 'no footage can be requested for a closed incident');
  ok((await op(`/incidents/${man.data.id}/reopen`, { method: 'POST', body: { reason: 'new evidence' } })).status === 200, 'CMS can reopen it');

  await setLow('auto_deliver');   // leave the default in place
  sim.kill(); reader.cancel().catch(() => {});
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(2); });
