/**
 * Browser-level test of the pop-up notices and tab counters: the real dashboard page (public/app.js) runs in jsdom against the
 * real RPF server and database. Skipped unless RPF_TEST=1, JWT_SECRET and the `jsdom` package (npm i -D jsdom) are present.
 * DEV DATABASES ONLY (it inserts rows, like workflow.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let JSDOM = null; try { ({ JSDOM } = require('jsdom')); } catch (_) { /* optional */ }
const enabled = process.env.RPF_TEST === '1' && process.env.JWT_SECRET && JSDOM;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpf-ui-'));
process.env.MEDIA_ROOT = tmp; process.env.POST_FILE = path.join(tmp, 'post.json');

test('pop-up notices and tab counters, page + server + database', { skip: !enabled && 'needs RPF_TEST=1, JWT_SECRET and jsdom' }, async (t) => {
  const { Pool } = require('pg'); const bcrypt = require('bcryptjs');
  const { buildApp } = require('../src/server'); const { pool: appPool } = require('../src/db');
  const owner = new Pool({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 5432, database: process.env.DB_NAME || 'cms',
    user: process.env.TEST_OWNER_USER || process.env.DB_USER, password: process.env.TEST_OWNER_PASSWORD || process.env.DB_PASSWORD });
  const q = async (s, p) => (await owner.query(s, p)).rows;
  const sfx = Date.now().toString(36); const pw = 'pw-' + sfx;
  const [zone] = await q(`INSERT INTO zone (name) VALUES ($1) RETURNING id`, [`U-zone-${sfx}`]);
  const [post] = await q(`INSERT INTO rpf_post (zone_id, name, location) VALUES ($1, $2, ST_SetSRID(ST_MakePoint(80.1, 26), 4326)::geography) RETURNING id`, [zone.id, `U-post-${sfx}`]);
  const [other] = await q(`INSERT INTO rpf_post (zone_id, name, location) VALUES ($1, $2, ST_SetSRID(ST_MakePoint(81.5, 26), 4326)::geography) RETURNING id`, [zone.id, `U-other-${sfx}`]);
  await q(`INSERT INTO users (zone_id, post_id, role, username, password_hash) VALUES ($1, $2, 'post_user', $3, $4)`, [zone.id, post.id, `u-${sfx}`, await bcrypt.hash(pw, 4)]);
  const [op] = await q(`INSERT INTO users (zone_id, role, username, password_hash) VALUES ($1, 'operator', $2, 'x') RETURNING id`, [zone.id, `uop-${sfx}`]);
  const [nvr] = await q(`INSERT INTO nvr_unit (name, cert_fingerprint, current_zone_id) VALUES ($1, $2, $3) RETURNING id`, [`U-nvr-${sfx}`, `ufp-${sfx}`, zone.id]);
  const [cam] = await q(`INSERT INTO camera (nvr_id, name) VALUES ($1, 'cam-1') RETURNING id`, [nvr.id]);

  const server = buildApp().listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await appPool.end(); await owner.end(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const call = async (method, url, token, body) => {
    const r = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
  };
  const token = (await call('POST', '/api/auth/login', null, { username: `u-${sfx}`, password: pw })).body.token;

  // ---- the page ----
  const dom = new JSDOM('<body><div id="app"></div></body>', { runScripts: 'outside-only', url: base + '/', pretendToBeVisual: true });
  const w = dom.window; w.sessionStorage.setItem('rpf_token', token);
  w.fetch = (u, o) => fetch(base + u, o); w.__theme = { get: () => 'dark', toggle() {}, set() {} };
  w.EventSource = function () { this.close = () => {}; this.addEventListener = () => {}; };   // no live stream here: the test drives the polling itself
  let tick = null; w.setInterval = (f) => { tick = f; return 1; };
  w.localStorage.setItem('rpf_sound', 'off');
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };   // jsdom has no <dialog> methods
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const doc = w.document;
  const pill = (id) => { const e = doc.getElementById(id); return e && !e.classList.contains('hidden') ? e.textContent : ''; };
  const toasts = () => [...doc.querySelectorAll('.ntoast')].map((e) => e.textContent);
  const settle = async () => { await tick(); await wait(500); };
  await wait(800); await tick(); await wait(400);   // the page has loaded and remembered its starting state

  await t.test('nothing pops up for what already existed; counters start empty', async () => {
    assert.deepEqual(toasts(), []);
    assert.equal(pill('footage-pill') + pill('flags-pill') + pill('requests-pill'), '');
  });

  // ---- CMS delivers footage for a request, the way requestService.deliver does: row + notice ----
  const t0 = new Date(Date.now() - 600000);
  const [r1] = await q(`INSERT INTO video_request (post_id, requested_by, camera_id, window_start, window_end, reason, status) VALUES ($1, $2, $3, $4, $5, 'ui test', 'approved') RETURNING id`, [post.id, op.id, cam.id, t0, new Date(t0.getTime() + 300000)]);
  await q(`INSERT INTO notification (zone_id, post_id, kind, title, body, ref_entity, ref_id) VALUES ($1, $2, 'request', $3, 'on its way', 'video_request', $4)`, [zone.id, post.id, `Request #${r1.id} approved - waiting for the train's NVR`, r1.id]);
  await settle();
  await t.test('a request step announced by CMS pops up and the open-requests counter shows it', async () => {
    assert.ok(toasts().some((x) => x.includes(`Request #${r1.id} approved`)), JSON.stringify(toasts()));
    assert.equal(pill('requests-pill'), '1');
  });

  const [f1] = await q(`INSERT INTO delivered_footage (video_request_id, storage_path, format, sha256, file_size_bytes, start_time, end_time, duration_s, segment_count) VALUES ($1, $2, 'MP4', $3, 10, $4, $5, 300, 1) RETURNING id`, [r1.id, `zone-${zone.id}/req-${r1.id}.mp4`, 'ab'.repeat(32), t0, new Date(t0.getTime() + 300000)]);
  await q(`UPDATE video_request SET status = 'fulfilled', fulfilled_at = now() WHERE id = $1`, [r1.id]);
  await q(`INSERT INTO notification (zone_id, post_id, kind, title, body, ref_entity, ref_id) VALUES ($1, $2, 'footage', $3, 'cam-1 / nvr', 'delivered_footage', $4)`, [zone.id, post.id, `Footage ready for request #${r1.id}`, f1.id]);
  await settle();
  await t.test('footage delivered: pop-up, bell and Footage counter', async () => {
    assert.ok(toasts().some((x) => x.includes(`Footage ready for request #${r1.id}`)), JSON.stringify(toasts()));
    assert.equal(pill('footage-pill'), '1');
    assert.equal(pill('bell-pill'), '2');
    assert.equal(pill('requests-pill'), '', 'the request is no longer open');
  });

  // evidence: CMS archives a flagged clip
  const [officer] = await q(`SELECT id FROM users WHERE username = $1`, [`u-${sfx}`]);
  const [fl] = await q(`INSERT INTO evidence_flag (footage_id, flagged_by, retention, retain_from, justification, storage) VALUES ($1, $2, 'permanent', now(), 'ui test', 'cms') RETURNING id`, [f1.id, officer.id]);
  await q(`INSERT INTO notification (zone_id, post_id, kind, title, body, ref_entity, ref_id) VALUES ($1, $2, 'evidence', $3, NULL, 'evidence_flag', $4)`, [zone.id, post.id, `Evidence #${fl.id} archived on CMS`, fl.id]);
  await settle();
  await t.test('evidence notice: pop-up and Evidence counter; opening the tab clears it', async () => {
    assert.ok(toasts().some((x) => x.includes(`Evidence #${fl.id} archived`)), JSON.stringify(toasts()));
    assert.equal(pill('flags-pill'), '1');
    doc.querySelector('[data-tab="flags"]').click(); await wait(700);
    assert.equal(pill('flags-pill'), '');
    assert.equal(Number((await call('GET', '/api/alerts/summary', token)).body.unread_evidence), 0);
  });

  await t.test('playing the footage clears its counter and the NEW mark', async () => {
    assert.equal((await call('GET', '/api/footage', token)).body[0].is_new, true);
    assert.equal((await call('POST', `/api/footage/${f1.id}/access`, token, { purpose: 'view' })).status, 404, 'no file on disk in this test, so no link is issued');
    // the file exists -> a view is logged -> not new any more
    fs.mkdirSync(path.join(tmp, `zone-${zone.id}`), { recursive: true }); fs.writeFileSync(path.join(tmp, `zone-${zone.id}`, `req-${r1.id}.mp4`), 'x');
    assert.equal((await call('POST', `/api/footage/${f1.id}/access`, token, { purpose: 'view' })).status, 200);
    await settle();
    assert.equal((await call('GET', '/api/footage', token)).body[0].is_new, false);
    assert.equal(pill('footage-pill'), '');
  });

  await t.test('alerts and incidents: Unacknowledged/Acknowledged and Open/Closed tabs, driven through the page', async () => {
    const t1 = new Date(Date.now() - 120000);
    const [al] = await q(`INSERT INTO alert (nvr_id, nvr_event_id, camera_id, zone_id, alert_type, priority, event_time, location, status, routing_mode, assigned_post_id) VALUES ($1, $2, $3, $4, 'intrusion', 8, $5, ST_SetSRID(ST_MakePoint(80.1, 26), 4326)::geography, 'routed', 'auto', $6) RETURNING id`, [nvr.id, `ui-${sfx}`, cam.id, zone.id, t1, post.id]);
    const [dl] = await q(`INSERT INTO alert_delivery (alert_id, alert_event_time, post_id) VALUES ($1, $2, $3) RETURNING id`, [al.id, t1, post.id]);
    const [inc] = await q(`INSERT INTO incident (alert_delivery_id, post_id, alert_type, location, occurred_at, raised_by, title) VALUES ($1, $2, 'intrusion', ST_SetSRID(ST_MakePoint(80.1, 26), 4326)::geography, $3, $4, 'tab test') RETURNING id`, [dl.id, post.id, t1, op.id]);
    const tab = (label) => [...doc.querySelectorAll('.subtab')].find((b) => b.textContent.startsWith(label));
    const count = (label) => tab(label).querySelector('.pill').textContent;
    const cards = () => doc.querySelectorAll('.acard').length;
    doc.querySelector('[data-tab="alerts"]').click(); await wait(700);
    assert.equal(tab('Unacknowledged').classList.contains('on'), true, 'opens on the Unacknowledged tab');
    assert.equal(count('Unacknowledged'), '1'); assert.equal(count('Acknowledged'), '0'); assert.equal(cards(), 1);
    [...doc.querySelectorAll('.acard-act button')].find((b) => /Acknowledge/.test(b.textContent)).click(); await wait(900);
    assert.equal(count('Unacknowledged'), '0', 'acknowledged alert left the Unacknowledged tab');
    assert.equal(count('Acknowledged'), '1');
    assert.equal(cards(), 0, 'nothing left waiting');
    tab('Acknowledged').click(); await wait(700);
    assert.equal(cards(), 1, 'it is now listed under Acknowledged');
    doc.querySelector('[data-tab="incidents"]').click(); await wait(700);
    assert.equal(count('Open incidents'), '1'); assert.equal(count('Closed incidents'), '0');
    assert.equal(doc.querySelectorAll('.icard').length, 1);
    assert.equal((await call('PATCH', `/api/incidents/${inc.id}/status`, token, { status: 'closed', note: 'done' })).status, 200);
    await settle(); doc.querySelector('[data-tab="incidents"]').click(); await wait(700);
    assert.equal(count('Open incidents'), '0'); assert.equal(count('Closed incidents'), '1');
    assert.equal(doc.querySelectorAll('.icard').length, 0, 'closed incident left the Open tab');
    tab('Closed incidents').click(); await wait(700);
    assert.equal(doc.querySelectorAll('.icard').length, 1, 'it is listed under Closed incidents');
  });

  await t.test('raising an incident from an alert: Incidents counter + pop-up, and the alert moves to Acknowledged', async () => {
    const t2 = new Date(Date.now() - 90000);
    const [al] = await q(`INSERT INTO alert (nvr_id, nvr_event_id, camera_id, zone_id, alert_type, priority, event_time, location, status, routing_mode, assigned_post_id) VALUES ($1, $2, $3, $4, 'fire_smoke', 9, $5, ST_SetSRID(ST_MakePoint(80.1, 26), 4326)::geography, 'routed', 'auto', $6) RETURNING id`, [nvr.id, `ui2-${sfx}`, cam.id, zone.id, t2, post.id]);
    const [dl] = await q(`INSERT INTO alert_delivery (alert_id, alert_event_time, post_id) VALUES ($1, $2, $3) RETURNING id`, [al.id, t2, post.id]);
    await settle();
    assert.equal(pill('unacked-pill'), '1', 'the new alert is waiting');
    assert.equal(pill('incidents-pill'), '', 'no open incident yet');
    const made = await call('POST', '/api/incidents', token, { delivery_id: dl.id, title: 'Smoke in coach B2' });
    assert.equal(made.status, 201);
    await settle();
    assert.equal(pill('incidents-pill'), '1', 'the Incidents tab shows the new incident');
    assert.equal(pill('unacked-pill'), '', 'the alert is no longer waiting');
    assert.ok(toasts().some((x) => x.includes(`Incident #${made.body.id} raised`) && x.includes('Smoke in coach B2')), JSON.stringify(toasts()));
    const acked = (await call('GET', '/api/alerts?state=acked', token)).body.map((x) => x.delivery_id);
    const unacked = (await call('GET', '/api/alerts?state=unacked', token)).body.map((x) => x.delivery_id);
    assert.ok(acked.includes(dl.id) && !unacked.includes(dl.id), 'raising the incident acknowledged the alert: it is in Acknowledged only');
  });

  await t.test('detail panel: header, progress, tabs and action bar (and acknowledging from it)', async () => {
    const t3 = new Date(Date.now() - 60000);
    const [al] = await q(`INSERT INTO alert (nvr_id, nvr_event_id, camera_id, zone_id, alert_type, priority, event_time, location, status, routing_mode, assigned_post_id) VALUES ($1, $2, $3, $4, 'intrusion', 8, $5, ST_SetSRID(ST_MakePoint(80.1, 26), 4326)::geography, 'routed', 'auto', $6) RETURNING id`, [nvr.id, `ui3-${sfx}`, cam.id, zone.id, t3, post.id]);
    const [dl] = await q(`INSERT INTO alert_delivery (alert_id, alert_event_time, post_id) VALUES ($1, $2, $3) RETURNING id`, [al.id, t3, post.id]);
    doc.querySelector('[data-tab="alerts"]').click(); await wait(700);
    [...doc.querySelectorAll('.subtab')].find((b) => b.textContent.startsWith('Unacknowledged')).click(); await wait(500);
    doc.querySelector('.acard-main').click(); await wait(700);
    const d = doc.querySelector('.drawer.v2');
    assert.ok(d, 'the redesigned panel opened');
    assert.ok(d.querySelector('.dh.crit'), 'priority 8 is shown as critical');
    assert.equal(d.querySelector('.ring b').textContent, 'P8');
    assert.equal(d.querySelectorAll('.step').length, 5, 'five progress steps');
    assert.equal(d.querySelector('.step.done b').textContent, 'Received');
    assert.deepEqual([...d.querySelectorAll('.dtab')].map((b) => b.textContent.replace(/\d+$/, '')), ['Overview', 'Footage', 'Activity']);
    assert.ok(d.querySelector('.facts .fact'), 'overview shows fact cards, not a log');
    assert.ok(d.querySelector('.banner.red'), 'a banner says nobody has acknowledged it');
    d.querySelector('.dtab[data-id="activity"]').click(); await wait(200);
    assert.ok(d.querySelector('.feed .fe'), 'the history lives in the Activity tab');
    d.querySelector('.dtab[data-id="footage"]').click(); await wait(200);
    assert.ok(d.querySelector('.empty2'), 'footage tab explains that nothing was requested yet');
    [...d.querySelectorAll('.dfoot button')].find((b) => b.textContent === 'Acknowledge').click(); await wait(900);
    const after = (await call('GET', `/api/alerts/${dl.id}`, token)).body.alert;
    assert.ok(after.ack_at, 'acknowledged from the action bar');
    assert.ok(!doc.querySelector('.drawer.v2 .banner.red'), 'the panel refreshed: the warning banner is gone');
  });

  await t.test('incident detail panel: progress, tabs, close moves it to Closed', async () => {
    const t4 = new Date(Date.now() - 30000);
    const made = (await call('POST', '/api/incidents', token, { manual: true, title: 'Bag left on platform', category: 'unattended_bag', camera_id: cam.id, occurred_at: t4.toISOString(), priority: 6 })).body;
    await settle();
    doc.querySelector('[data-tab="incidents"]').click(); await wait(700);
    [...doc.querySelectorAll('.subtab')].find((b) => b.textContent.startsWith('Open incidents')).click(); await wait(500);
    const card = [...doc.querySelectorAll('.icard')].find((c) => c.textContent.includes('Bag left on platform'));
    card.click(); await wait(700);
    const d = doc.querySelector('.drawer.v2');
    assert.ok(d && d.querySelector('.dh.med'), 'priority 6 is medium');
    assert.equal(d.querySelectorAll('.step').length, 4);
    assert.ok([...d.querySelectorAll('.dfoot button')].some((b) => b.textContent === 'Close incident'));
    assert.equal((await call('PATCH', `/api/incidents/${made.id}/status`, token, { status: 'closed', note: 'checked, nothing found' })).status, 200);
    d.querySelector('.dh-btns button').click(); await wait(700);   // reload the panel
    const d2 = doc.querySelector('.drawer.v2');
    assert.ok(d2.querySelector('.dh.done'), 'a closed incident turns green');
    assert.ok(d2.querySelector('.banner') && d2.textContent.includes('checked, nothing found'), 'the closing note is shown in a banner');
  });

  await t.test('footage tab of a detail panel lists the requests as cards with working Play / Save buttons', async () => {
    const t5 = new Date(Date.now() - 300000);
    const [al] = await q(`INSERT INTO alert (nvr_id, nvr_event_id, camera_id, zone_id, alert_type, priority, event_time, location, status, routing_mode, assigned_post_id) VALUES ($1, $2, $3, $4, 'intrusion', 9, $5, ST_SetSRID(ST_MakePoint(80.1, 26), 4326)::geography, 'routed', 'auto', $6) RETURNING id`, [nvr.id, `ui5-${sfx}`, cam.id, zone.id, t5, post.id]);
    const [dl] = await q(`INSERT INTO alert_delivery (alert_id, alert_event_time, post_id) VALUES ($1, $2, $3) RETURNING id`, [al.id, t5, post.id]);
    const mkReq = async (n) => {
      const [r] = await q(`INSERT INTO video_request (post_id, requested_by, camera_id, window_start, window_end, reason, alert_id, alert_event_time, status, fulfilled_at) VALUES ($1, $2, $3, $4, $5, 'footage tab test', $6, $7, 'fulfilled', now()) RETURNING id`, [post.id, officer.id, cam.id, new Date(t5.getTime() - 600000 * n), new Date(t5.getTime() - 600000 * n + 120000), al.id, t5]);
      const rel = `zone-${zone.id}/req-${r.id}.mp4`;
      fs.mkdirSync(path.join(tmp, `zone-${zone.id}`), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), 'not really a video');
      await q(`INSERT INTO delivered_footage (video_request_id, storage_path, format, sha256, file_size_bytes, start_time, end_time, duration_s, segment_count) VALUES ($1, $2, 'MP4', $3, 18, now(), now(), 120, 1)`, [r.id, rel, 'cd'.repeat(32)]);
      return r.id;
    };
    const [ra, rb] = [await mkReq(1), await mkReq(2)];
    await settle();
    doc.querySelector('[data-tab="alerts"]').click(); await wait(700);
    [...doc.querySelectorAll('.subtab')].find((b) => b.textContent.startsWith('Unacknowledged')).click(); await wait(500);
    [...doc.querySelectorAll('.acard-main')].find((c) => /intrusion/i.test((c.closest('.acard') || c).textContent)).click(); await wait(800);
    const d = doc.querySelector('.drawer.v2');
    d.querySelector('.dtab[data-id="footage"]').click(); await wait(300);
    assert.ok(!d.textContent.includes('[object HTML'), 'the cards are drawn, not printed as "[object HTMLDivElement]"');
    assert.equal(d.querySelectorAll('.rq').length, 2, 'both requests are shown as cards');
    const names = [...d.querySelectorAll('.rq button')].map((b) => b.textContent);
    assert.ok(names.includes('Review / flag') && names.includes('Save to PC'), JSON.stringify(names));
    // the play button asks the server for a view link of the delivered file
    const seen = []; const realFetch = w.fetch; w.fetch = (u, o) => { seen.push(`${(o && o.method) || 'GET'} ${u}`); return realFetch(u, o); };
    [...d.querySelectorAll('.rq button')].find((b) => b.textContent === 'Review / flag').click(); await wait(900);
    assert.ok(seen.some((x) => /POST \/api\/footage\/\d+\/access/.test(x)), JSON.stringify(seen));
    assert.ok(doc.querySelector('video, .reviewer, dialog, .modal'), 'the footage viewer opened');
    w.fetch = realFetch;
  });

  await t.test('another post\'s notices never reach this post', async () => {
    await settle();
    const before = pill('footage-pill');
    await q(`INSERT INTO notification (zone_id, post_id, kind, title, ref_entity, ref_id) VALUES ($1, $2, 'footage', 'FOR THE OTHER POST', 'delivered_footage', $3)`, [zone.id, other.id, f1.id]);
    await settle();
    assert.ok(!toasts().some((x) => x.includes('OTHER POST')));
    assert.equal(pill('footage-pill'), before, 'the other post\'s notice changed nothing here');
  });
});
