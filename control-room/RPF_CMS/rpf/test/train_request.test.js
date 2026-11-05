/**
 * End-to-end: an RPF officer requests footage BY TRAIN NUMBER; CMS fans it out to every camera of every M-NVR unit of the
 * train; the M-NVR units upload; one file per camera comes back, named <TRAIN>_M<nn>_C<nn>_<start>_<end>.mp4.
 *
 * Needs a running CMS (backend) and two simulated M-NVR units of ONE train - the demo data has them:
 *   - CMS fixtures applied, then both units on the same train:  UPDATE nvr_unit SET train_no='12301 Rajdhani', unit_no=2 WHERE name='nvr-2';  (and unit_no=1 on nvr-1)
 *   - CMS running:                       (CMS)  node backend/src/server.js
 *   - two simulated M-NVRs connected:    (CMS)  node scripts/mnvr_sim.js run --units 1,2 --alerts 0
 *
 *   TRAIN_E2E=1 CMS_URL=<cms address from config/control-room.conf> CMS_OPERATOR=cms-operator CMS_OPERATOR_PASSWORD=cms-demo-123 \
 *   RPF_TEST=1 DB_USER=rpf_app DB_PASSWORD=... JWT_SECRET=<32+ chars> TEST_OWNER_USER=cms TEST_OWNER_PASSWORD=... \
 *   node --test test/train_request.test.js
 *
 * DEV DATABASES ONLY (it leaves train requests, footage and audit rows behind: those tables are append-only).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const enabled = process.env.TRAIN_E2E === '1' && process.env.RPF_TEST === '1' && process.env.JWT_SECRET;
const tmpMedia = fs.mkdtempSync(path.join(os.tmpdir(), 'rpf-train-'));
process.env.MEDIA_ROOT = tmpMedia;
process.env.POST_FILE = path.join(tmpMedia, 'post.json');

// The CMS address is not defaulted here: pass CMS_URL (the address in config/control-room.conf: LOOPBACK_HOST and CMS_PORT).
const CMS = process.env.CMS_URL;
if (enabled && !CMS) throw new Error('set CMS_URL (the CMS address, see the header)');
if (enabled) { const u = new URL(CMS); process.env.CMS_HOST = process.env.CMS_HOST || u.hostname; process.env.CMS_PORT = process.env.CMS_PORT || u.port; }   // RPF asks the CMS where its footage folder is
const TRAIN = process.env.TRAIN_NO || '12301 Rajdhani';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('request footage by train number: RPF -> CMS -> every M-NVR -> every camera', { skip: !enabled && 'set TRAIN_E2E=1, RPF_TEST=1 and JWT_SECRET (see the header)' }, async (t) => {
  const { Pool } = require('pg');
  const bcrypt = require('bcryptjs');
  const { buildApp } = require('../src/server');
  const { pool: appPool } = require('../src/db');
  const binding = require('../src/services/binding');

  const owner = new Pool({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 5432, database: process.env.DB_NAME || 'cms',
    user: process.env.TEST_OWNER_USER || process.env.DB_USER, password: process.env.TEST_OWNER_PASSWORD || process.env.DB_PASSWORD });
  const q = async (sql, params) => (await owner.query(sql, params)).rows;

  // the units of the train and the post that serves their zone
  const units = await q(`SELECT n.id, n.name, COALESCE(n.unit_no, n.id) AS unit_no, n.current_zone_id AS zone_id FROM nvr_unit n WHERE lower(btrim(n.train_no)) = lower($1) ORDER BY 3`, [TRAIN]);
  assert.ok(units.length >= 2, `train ${TRAIN} needs at least two M-NVR units in the CMS (found ${units.length}) - see the header`);
  const cams = await q(`SELECT c.id, COALESCE(c.mnvr_camera_id, c.id) AS camera_no, COALESCE(n.unit_no, n.id) AS unit_no FROM camera c JOIN nvr_unit n ON n.id = c.nvr_id WHERE lower(btrim(n.train_no)) = lower($1) AND c.active`, [TRAIN]);
  const [post] = await q(`SELECT id, zone_id FROM rpf_post WHERE zone_id = $1 AND active ORDER BY id LIMIT 1`, [units[0].zone_id]);
  const sfx = Date.now().toString(36);
  const pw = 'pw-' + sfx;
  await q(`INSERT INTO users (zone_id, post_id, role, username, password_hash) VALUES ($1,$2,'post_user',$3,$4)`, [post.zone_id, post.id, `train-officer-${sfx}`, await bcrypt.hash(pw, 4)]);
  binding.bind(post.id);

  const server = buildApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await appPool.end(); await owner.end(); fs.rmSync(tmpMedia, { recursive: true, force: true }); });
  const call = async (method, url, token, body) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : null };
  };
  const cmsCall = async (method, url, token, body) => {
    const res = await fetch(CMS + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const token = (await call('POST', '/api/auth/login', null, { username: `train-officer-${sfx}`, password: pw })).body.token;
  assert.ok(token, 'officer can sign in');
  const op = (await cmsCall('POST', '/console/api/auth/login', null, { username: process.env.CMS_OPERATOR || 'cms-operator', password: process.env.CMS_OPERATOR_PASSWORD || 'cms-demo-123' })).body.token;
  assert.ok(op, 'CMS operator can sign in');

  const win = (fromMin, toMin) => ({ window_start: new Date(Date.now() - fromMin * 60000).toISOString(), window_end: new Date(Date.now() - toMin * 60000).toISOString() });

  await t.test('the officer sees the train, its M-NVR units and cameras - not camera names to pick from', async () => {
    const r = await call('GET', '/api/trains', token);
    assert.equal(r.status, 200);
    const tr = r.body.find((x) => x.train_no.toLowerCase() === TRAIN.toLowerCase());
    assert.ok(tr, 'train listed');
    assert.equal(tr.units_total, units.length);
    assert.equal(tr.cameras_total, cams.length);
    assert.deepEqual(tr.units.map((u) => u.unit_no), units.map((u) => u.unit_no));
  });

  await t.test('validation: train number required and known, window limits, reason', async () => {
    const ok = { train_no: TRAIN, reason: 'validation', ...win(20, 15) };
    for (const bad of [{ train_no: undefined }, { train_no: '99999 nowhere' }, { reason: '' }, { window_start: new Date(Date.now() + 3600e3).toISOString(), window_end: new Date(Date.now() + 7200e3).toISOString() },
      { window_start: new Date(Date.now() - 86400e3 * 2).toISOString(), window_end: new Date(Date.now() - 60e3).toISOString() }, { camera_id: 1, train_no: undefined }]) {
      assert.equal((await call('POST', '/api/train-requests', token, { ...ok, ...bad })).status, 400, `rejects ${JSON.stringify(bad).slice(0, 80)}`);
    }
    assert.equal((await call('POST', '/api/train-requests', null, ok)).status, 401);
  });

  let id;
  await t.test('RPF files ONE request for the train number; CMS approves; it fans out to every camera of every unit', async () => {
    const c = await call('POST', '/api/train-requests', token, { train_no: TRAIN.toUpperCase(), reason: 'e2e train request', ...win(20, 15) });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    id = c.body.id;
    assert.equal((await call('POST', '/api/train-requests', token, { train_no: TRAIN, reason: 'again', ...win(19, 16) })).status, 409, 'same train + overlapping window while open');
    const before = await call('GET', `/api/train-requests/${id}`, token);
    assert.equal(before.body.request.status, 'submitted');
    assert.equal(before.body.cameras.length, 0, 'nothing is fanned out until CMS approves');
    const dec = await cmsCall('POST', `/console/api/requests/${id}/approve`, op, {});
    assert.equal(dec.status, 200, JSON.stringify(dec.body));
    assert.equal(dec.body.cameras_total, cams.length);
    assert.equal(dec.body.units_total, units.length);
    const after = await call('GET', `/api/train-requests/${id}`, token);
    assert.deepEqual(after.body.cameras.map((c) => `${c.unit_no}/${c.camera_no}`).sort(), cams.map((c) => `${c.unit_no}/${c.camera_no}`).sort());
    // (whether upload commands are needed depends on what CMS already stores from earlier requests; the next test checks the result)
  });

  await t.test('requests exist only per train: no single-camera route, one entry per train request', async () => {
    assert.equal((await call('GET', '/api/requests', token)).status, 404, 'the single-camera list is gone');
    assert.equal((await call('POST', '/api/requests', token, { camera_id: cams[0].id, reason: 'x', ...win(20, 15) })).status, 404, 'so is single-camera creation');
    const mine = await call('GET', '/api/train-requests?status=open', token);
    assert.ok(mine.body.some((r) => r.id === id) || (await call('GET', `/api/train-requests/${id}`, token)).body.request.status === 'fulfilled');
    assert.equal(mine.body.filter((r) => r.id === id).length <= 1, true);
  });

  await t.test('every unit uploads; every camera comes back as <TRAIN>_M<nn>_C<nn>_<start>_<end>.mp4, visible to RPF', async () => {
    const deadline = Date.now() + 200000;
    let d;
    do { await sleep(3000); d = (await call('GET', `/api/train-requests/${id}`, token)).body; } while (!['fulfilled', 'partial', 'failed', 'expired'].includes(d.request.status) && Date.now() < deadline);
    assert.equal(d.request.status, 'fulfilled', `status ${d.request.status}: ${d.request.failure_reason || ''}`);
    assert.equal(d.request.cameras_fulfilled, cams.length);
    assert.equal(d.footage.length, cams.length, 'one file per camera');
    const re = /^12301-RAJDHANI_M(\d{2})_C(\d{2})_\d{8}T\d{6}Z_\d{8}T\d{6}Z\.mp4$/;
    for (const f of d.footage) {
      assert.match(f.file_name, re);
      const [, m, c] = f.file_name.match(re);
      assert.equal(Number(m), f.unit_no); assert.equal(Number(c), f.camera_no);
      assert.equal(f.train_request_id, id);
      assert.ok(f.sha256 && f.file_size_bytes > 0);
    }
    assert.equal(new Set(d.footage.map((f) => f.file_name)).size, cams.length, 'no two cameras share a file name');
    assert.equal(new Set(d.footage.map((f) => f.unit_no)).size, units.length, 'footage from every M-NVR unit');
    // the same files are on the CMS side too, under the same names
    const cmsView = await cmsCall('GET', `/console/api/requests/${id}`, op);
    assert.deepEqual(cmsView.body.cameras.map((c) => c.file_name).sort(), d.footage.map((f) => f.file_name).sort());
    // and playable by the officer
    const link = await call('POST', `/api/footage/${d.footage[0].id}/access`, token, { purpose: 'view' });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    const notes = await call('GET', '/api/notifications', token);
    const mineN = (notes.body.rows || notes.body).filter((n) => n.ref_entity === 'train_request' && n.ref_id === id);
    assert.ok(mineN.length >= 1 && mineN.length <= 2, `one notice for the whole train, not one per camera (got ${mineN.length})`);
  });

  await t.test('the delivered files cover exactly the requested window, not the whole stored segments', async () => {
    const start = new Date(Date.now() - 17.4 * 60000); start.setMilliseconds(0);
    const end = new Date(start.getTime() + 4.7 * 60000);              // 282 s, boundaries inside the M-NVR's segments
    const c = await call('POST', '/api/train-requests', token, { train_no: TRAIN, reason: 'exact window', window_start: start.toISOString(), window_end: end.toISOString() });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal((await cmsCall('POST', `/console/api/requests/${c.body.id}/approve`, op, {})).status, 200);
    let d; const deadline = Date.now() + 150000;
    do { await sleep(3000); d = (await call('GET', `/api/train-requests/${c.body.id}`, token)).body; } while (!['fulfilled', 'partial', 'failed'].includes(d.request.status) && Date.now() < deadline);
    assert.equal(d.request.status, 'fulfilled', `status ${d.request.status}: ${d.request.failure_reason || ''}`);
    for (const f of d.footage) {
      assert.equal(new Date(f.start_time).getTime(), start.getTime(), `${f.file_name} starts at the requested start`);
      // the end is the requested end, or where the unit's recording stops if that is earlier (never later than asked)
      assert.ok(new Date(f.end_time) <= end && end - new Date(f.end_time) <= 12000, `${f.file_name} ends at ${f.end_time}, requested ${end.toISOString()}`);
      const want = (new Date(f.end_time) - start) / 1000;
      assert.ok(Math.abs(Number(f.duration_s) - want) <= 4, `${f.file_name} lasts ${f.duration_s} s, expected about ${want} s (the requested window), not the whole stored segments`);
      assert.ok(f.file_name.includes(start.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')), 'the file name carries the requested start');
    }
  });

  await t.test('cancelling a train request withdraws what is still open', async () => {
    const c = await call('POST', '/api/train-requests', token, { train_no: TRAIN, reason: 'to be cancelled', ...win(300, 295) });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    await cmsCall('POST', `/console/api/requests/${c.body.id}/approve`, op, {});
    const x = await call('POST', `/api/train-requests/${c.body.id}/cancel`, token);
    assert.equal(x.status, 200);
    assert.ok(['cancelled', 'partial'].includes(x.body.status));
    const kids = await q(`SELECT status FROM video_request WHERE train_request_id = $1`, [c.body.id]);
    assert.ok(kids.every((k) => ['cancelled', 'fulfilled', 'failed', 'expired'].includes(k.status)), JSON.stringify(kids));   // none is left open (a camera with no recording in that window may already have failed on its own)
    assert.equal((await call('POST', `/api/train-requests/${c.body.id}/cancel`, token)).status, 409, 'cannot cancel twice');
  });
});
