/**
 * End-to-end test of the RPF workflow against a real CMS database.
 *
 * DEV DATABASES ONLY: it inserts rows (zone, posts, users, alert, footage,
 * audit entries) under unique names and cannot remove them, because
 * delivered_footage and audit_log are append-only by design.
 *
 *   RPF_TEST=1 DB_USER=rpf_app DB_PASSWORD=... JWT_SECRET=<32+ chars> \
 *   TEST_OWNER_USER=cms TEST_OWNER_PASSWORD=... npm test
 *
 * DB_* is what the app under test connects as (use rpf_app to prove the
 * least-privilege grants are sufficient). TEST_OWNER_* is used only to
 * arrange data the way CMS would (alerts, deliveries, footage).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const enabled = process.env.RPF_TEST === '1' && process.env.JWT_SECRET;
const tmpMedia = fs.mkdtempSync(path.join(os.tmpdir(), 'rpf-media-'));
process.env.MEDIA_ROOT = tmpMedia;
process.env.POST_FILE = path.join(tmpMedia, 'post.json');
 // this dashboard's post binding, kept out of the real data/ folder

test('RPF post dashboard against the shared CMS database', { skip: !enabled && 'set RPF_TEST=1 and JWT_SECRET to run' }, async (t) => {
  const { Pool } = require('pg');
  const bcrypt = require('bcryptjs');
  const { buildApp } = require('../src/server');
  const { pool: appPool } = require('../src/db');
  const { signToken } = require('../src/middleware/auth');

  const owner = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'cms',
    user: process.env.TEST_OWNER_USER || process.env.DB_USER,
    password: process.env.TEST_OWNER_PASSWORD || process.env.DB_PASSWORD,
  });

  const sfx = Date.now().toString(36);
  const pw = 'pw-' + sfx;
  const hash = await bcrypt.hash(pw, 4);
  const q = async (sql, params) => (await owner.query(sql, params)).rows;

  // ---- arrange: one zone, two posts, one NVR + camera, four users ----------
  const [zone] = await q(`INSERT INTO zone (name) VALUES ($1) RETURNING id`, [`T-zone-${sfx}`]);
  const mkPost = async (n, lon) => (await q(
    `INSERT INTO rpf_post (zone_id, name, location) VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, 26), 4326)::geography) RETURNING id`,
    [zone.id, `T-post-${n}-${sfx}`, lon]))[0];
  const postA = await mkPost('A', 80.1);
  const postB = await mkPost('B', 81.5);
  const [nvr] = await q(`INSERT INTO nvr_unit (name, cert_fingerprint, current_zone_id) VALUES ($1, $2, $3) RETURNING id`, [`T-nvr-${sfx}`, `fp-${sfx}`, zone.id]);
  const [cam] = await q(`INSERT INTO camera (nvr_id, name) VALUES ($1, 'cam-1') RETURNING id`, [nvr.id]);
  const mkUser = async (name, role, postId) => (await q(
    `INSERT INTO users (zone_id, post_id, role, username, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [role === 'super_admin' ? null : zone.id, postId, role, `${name}-${sfx}`, hash]))[0];
  await mkUser('a', 'post_user', postA.id);
  const userB = await mkUser('b', 'post_user', postB.id);
  await mkUser('admin', 'zone_admin', null);
  await mkUser('super', 'super_admin', null);
  const op = await mkUser('op', 'operator', null);

  // CMS auto-dispatch, reproduced as data: alert -> delivery -> incident, for post A.
  const eventTime = new Date(Date.now() - 20 * 60000);
  const [alert] = await q(
    `INSERT INTO alert (nvr_id, nvr_event_id, camera_id, zone_id, alert_type, priority, event_time, location, status, routing_mode, assigned_post_id)
     VALUES ($1, $2, $3, $4, 'intrusion', 9, $5, ST_SetSRID(ST_MakePoint(80.1, 26), 4326)::geography, 'routed', 'auto', $6) RETURNING id`,
    [nvr.id, `evt-${sfx}`, cam.id, zone.id, eventTime, postA.id]);
  const [delivery] = await q(
    `INSERT INTO alert_delivery (alert_id, alert_event_time, post_id) VALUES ($1, $2, $3) RETURNING id`, [alert.id, eventTime, postA.id]);
  const [incident] = await q(
    `INSERT INTO incident (alert_delivery_id, post_id, alert_type, location, occurred_at, raised_by)
     VALUES ($1, $2, 'intrusion', ST_SetSRID(ST_MakePoint(80.1, 26), 4326)::geography, $3, $4) RETURNING id`,
    [delivery.id, postA.id, eventTime, op.id]);

  // Post B has an alert of its own: it must never show up on post A's dashboard.
  const [alertB] = await q(
    `INSERT INTO alert (nvr_id, nvr_event_id, camera_id, zone_id, alert_type, priority, event_time, location, status, routing_mode, assigned_post_id)
     VALUES ($1, $2, $3, $4, 'tamper', 8, $5, ST_SetSRID(ST_MakePoint(81.5, 26), 4326)::geography, 'routed', 'auto', $6) RETURNING id`,
    [nvr.id, `evtB-${sfx}`, cam.id, zone.id, eventTime, postB.id]);
  const [deliveryB] = await q(`INSERT INTO alert_delivery (alert_id, alert_event_time, post_id) VALUES ($1, $2, $3) RETURNING id`, [alertB.id, eventTime, postB.id]);
  const [incidentB] = await q(
    `INSERT INTO incident (alert_delivery_id, post_id, alert_type, location, occurred_at, raised_by) VALUES ($1, $2, 'tamper', ST_SetSRID(ST_MakePoint(81.5, 26), 4326)::geography, $3, $4) RETURNING id`,
    [deliveryB.id, postB.id, eventTime, op.id]);

  // Bait for the isolation checks: the other post's officer and the CMS routing note both sit on post A's alert history.
  await q(`INSERT INTO alert_history (alert_id, alert_event_time, changed_by, from_status, to_status, note) VALUES ($1, $2, $3, 'routed', 'acknowledged', 'acknowledged at RPF post')`, [alert.id, eventTime, userB.id]);
  await q(`INSERT INTO alert_history (alert_id, alert_event_time, changed_by, from_status, to_status, note) VALUES ($1, $2, NULL, 'routed', 'escalated', $3)`, [alert.id, eventTime, `escalated to T-post-B-${sfx}`]);
  await q(`INSERT INTO video_request (post_id, requested_by, camera_id, window_start, window_end, reason, incident_id) VALUES ($1, $2, $3, $4, $5, 'post B request on its own incident', $6)`,
    [postB.id, userB.id, cam.id, new Date(Date.now() - 50 * 60000), new Date(Date.now() - 45 * 60000), incidentB.id]);

  // ---- app under test -------------------------------------------------------
  const server = buildApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await appPool.end(); await owner.end(); fs.rmSync(tmpMedia, { recursive: true, force: true }); });

  const call = async (method, url, token, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const login = async (n) => (await call('POST', '/api/auth/login', null, { username: `${n}-${sfx}`, password: pw }));

  await t.test('registration: validated; needs a current officer to confirm; adopts an unclaimed post; cannot take over a post that has an officer', async () => {
    const s0 = await call('GET', '/api/setup');
    assert.equal(s0.body.registered, true, 'officers exist, so the screen asks for a confirmation');
    assert.equal(s0.body.post, undefined, 'nothing about any post is shown before sign-in');
    assert.ok(s0.body.zones.some((z) => z.id === zone.id));
    const auth = { authorizer_username: `A-${sfx}`.toUpperCase(), authorizer_password: pw };   // any current officer may confirm (name is not case-sensitive)
    const good = { post_name: `T-new-post-${sfx}`, zone_id: zone.id, latitude: 29.97, longitude: 77.55, username: `Reg Name ${sfx}`, password: 'longenough1' };
    for (const bad of [{ post_name: 'ab' }, { zone_id: 'x' }, { latitude: 120 }, { longitude: 'east' }, { username: 'A@B' }, { password: 'short' }, { zone_id: 999999999 }]) {
      assert.equal((await call('POST', '/api/setup/register', null, { ...good, ...auth, ...bad })).status, 400, `rejects ${JSON.stringify(bad)}`);
    }
    assert.equal((await call('POST', '/api/setup/register', null, good)).status, 403, 'nobody can add a post without an officer confirming');
    assert.equal((await call('POST', '/api/setup/register', null, { ...good, authorizer_username: `a-${sfx}`, authorizer_password: 'wrong-password' })).status, 403, 'wrong confirmation password');
    assert.equal((await call('POST', '/api/setup/register', null, { ...good, authorizer_username: `admin-${sfx}`, authorizer_password: pw })).status, 403, 'a CMS administrator is not an RPF officer');
    // a post the CMS admin already created and that already has an officer cannot be taken over
    assert.equal((await call('POST', '/api/setup/register', null, { ...good, ...auth, post_name: `T-post-A-${sfx}`, username: `x-${sfx}` })).status, 409);
    const ok = await call('POST', '/api/setup/register', null, { ...good, ...auth });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.username, `reg.name.${sfx}`, 'a typed name becomes a clean username');
    const me = await call('GET', '/api/auth/me', ok.body.token);
    assert.equal(me.body.post_name, good.post_name);
    const [row] = await q(`SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon, zone_id FROM rpf_post WHERE id = $1`, [me.body.post_id]);
    assert.ok(Math.abs(row.lat - 29.97) < 1e-6 && Math.abs(row.lon - 77.55) < 1e-6 && Number(row.zone_id) === Number(zone.id));
    assert.equal((await call('POST', '/api/setup/register', null, { ...good, username: `again-${sfx}`, authorizer_username: `reg.name.${sfx}`, authorizer_password: 'longenough1' })).status, 409, 'a post that already has an officer cannot be registered again');
    // an unclaimed post created by the CMS administrator is adopted by name
    const [un] = await q(`INSERT INTO rpf_post (zone_id, name, location) VALUES ($1, $2, ST_SetSRID(ST_MakePoint(78, 27), 4326)::geography) RETURNING id`, [zone.id, `T-unclaimed-${sfx}`]);
    const adopt = await call('POST', '/api/setup/register', null, { ...good, ...auth, post_name: `T-unclaimed-${sfx}`, username: `adopt-${sfx}` });
    assert.equal(adopt.status, 201);
    assert.equal((await call('GET', '/api/auth/me', adopt.body.token)).body.post_id, un.id);
    // THE point of one shared dashboard: officers of different posts can all sign in, each lands in their own post
    const la = await login('a'), lb = await login('b'), lr = await call('POST', '/api/auth/login', null, { username: `reg.name.${sfx}`, password: 'longenough1' });
    assert.deepEqual([la.status, lb.status, lr.status], [200, 200, 200]);
    assert.equal((await call('GET', '/api/auth/me', la.body.token)).body.post_id, postA.id);
    assert.equal((await call('GET', '/api/auth/me', lb.body.token)).body.post_id, postB.id);
    assert.equal((await call('GET', '/api/auth/me', lr.body.token)).body.post_id, me.body.post_id);
  });

  await t.test('login: every post\'s officers; admins, operators and bad passwords out', async () => {
    assert.equal((await login('a')).status, 200);
    assert.equal((await login('b')).status, 200, 'an officer of another post signs in on the same dashboard');
    assert.equal((await login('admin')).status, 403);
    assert.equal((await login('super')).status, 403);
    assert.equal((await login('op')).status, 403);
    assert.equal((await call('POST', '/api/auth/login', null, { username: `a-${sfx}`, password: 'wrong' })).status, 401);
    assert.equal((await call('GET', '/api/alerts')).status, 401);
  });
  await t.test('accounts: add an officer, change password, set a colleague\'s password, disable', async () => {
    const A0 = (await login('a')).body.token;
    const un = `ravi.kumar.${sfx}`;
    assert.equal((await call('POST', '/api/team', A0, { username: `Ravi Kumar ${sfx}`, password: 'short' })).status, 400, 'weak starting password refused');
    assert.equal((await call('POST', '/api/team', A0, { username: `Ravi Kumar ${sfx}`, password: 'starting-pass-1' })).status, 201);
    assert.equal((await call('POST', '/api/team', A0, { username: un, password: 'starting-pass-1' })).status, 409, 'username taken');
    const re = await call('POST', '/api/auth/login', null, { username: un, password: 'starting-pass-1' });
    assert.equal(re.status, 200); assert.equal((await call('GET', '/api/auth/me', re.body.token)).body.post_id, postA.id, 'the new officer belongs to this post');
    assert.equal((await call('POST', '/api/auth/password', re.body.token, { current_password: 'nope', new_password: 'another-pass-22' })).status, 401);
    assert.equal((await call('POST', '/api/auth/password', re.body.token, { current_password: 'starting-pass-1', new_password: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/auth/password', re.body.token, { current_password: 'starting-pass-1', new_password: 'another-pass-22' })).status, 200);
    assert.equal((await call('POST', '/api/auth/login', null, { username: un, password: 'starting-pass-1' })).status, 401, 'the old password no longer works');
    const t2 = await call('GET', '/api/team', A0); const other = t2.body.officers.find((o) => o.username === un);
    assert.equal((await call('POST', `/api/team/${t2.body.officers.find((o) => o.you).id}/reset-password`, A0, { password: 'whatever-123' })).status, 400, 'not yourself');
    assert.equal((await call('POST', `/api/team/${userB.id}/reset-password`, A0, { password: 'whatever-123' })).status, 404, 'not another post\'s officer');
    assert.equal((await call('POST', `/api/team/${other.id}/reset-password`, A0, { password: 'x' })).status, 400);
    assert.equal((await call('POST', `/api/team/${other.id}/reset-password`, A0, { password: 'colleague-new-1' })).status, 200);
    assert.equal((await call('POST', '/api/auth/login', null, { username: un, password: 'colleague-new-1' })).status, 200);
    assert.equal((await call('POST', `/api/team/${other.id}/status`, A0, { status: 'disabled' })).status, 200);
    assert.equal((await call('POST', '/api/auth/login', null, { username: un, password: 'colleague-new-1' })).status, 401, 'a disabled officer cannot sign in');
    // none of the removed e-mail / recovery endpoints exist any more
    for (const p of ['/api/auth/forgot', '/api/auth/reset', '/api/auth/email', '/api/auth/recovery-code']) assert.equal((await call('POST', p, A0, {})).status, 404, `${p} is gone`);
  });

  const A = (await login('a')).body.token;
  const B = signToken({ id: userB.id }); // post B's officer: signed in on the same dashboard, must see only post B's data

  await t.test('alert inbox is this post only', async () => {
    const a = await call('GET', '/api/alerts', A);
    assert.equal(a.body.length, 1);
    assert.equal(a.body[0].delivery_id, delivery.id);
    assert.equal(a.body[0].incident_id, incident.id);
    const ab = await call('GET', '/api/alerts', B);
    assert.equal(ab.status, 200, 'post B\'s officer is signed in on the same dashboard...');
    assert.deepEqual(ab.body.map((x) => x.delivery_id), [deliveryB.id], '...and sees ONLY post B\'s alert');
    assert.equal((await call('GET', `/api/alerts/${delivery.id}`, B)).status, 404, 'post A\'s alert is invisible to B');
    assert.equal((await call('GET', `/api/incidents/${incident.id}`, B)).status, 404);
    assert.equal((await call('GET', `/api/alerts/${deliveryB.id}`, A)).status, 404, 'post B\'s alert is invisible');
    assert.equal((await call('GET', `/api/incidents/${incidentB.id}`, A)).status, 404);
    assert.equal((await call('GET', '/api/incidents', A)).body.every((i) => i.id !== incidentB.id), true);
    assert.equal((await call('GET', `/api/alerts?post_id=${postB.id}`, A)).body.length, 1, 'a post_id parameter cannot widen the scope');
  });

  await t.test('another post\'s trail, incidents and requests never reach this post', async () => {
    const d = await call('GET', `/api/alerts/${delivery.id}`, A);
    assert.ok(!JSON.stringify(d.body.history).includes('T-post-B'), 'no routing note that names another post');
    assert.equal(d.body.history.some((h) => h.note === 'acknowledged at RPF post'), false, 'nothing another post\'s officer did');
    const i = await call('GET', `/api/incidents/${incident.id}`, A);
    assert.ok(!JSON.stringify(i.body.timeline).includes('T-post-B'), 'the incident timeline is scrubbed the same way');
    const soon = { camera_id: cam.id, window_start: new Date(Date.now() - 30 * 60000).toISOString(), window_end: new Date(Date.now() - 25 * 60000).toISOString(), reason: 'x' };
    assert.equal((await call('POST', '/api/requests', A, { ...soon, incident_id: incidentB.id })).status, 404, 'a request cannot be hung on another post\'s incident');
    assert.equal((await call('GET', `/api/incidents/${incident.id}`, A)).body.requests.every((r) => r.post_id === postA.id), true);
  });

  await t.test('acknowledge: once, only by the owning post, writes history', async () => {
    assert.equal((await call('POST', `/api/alerts/${deliveryB.id}/ack`, A, {})).status, 404, 'cannot acknowledge another post\'s alert');
    const inTab = async (state, id) => (await call('GET', `/api/alerts?state=${state}`, A)).body.some((x) => x.delivery_id === id);
    assert.equal(await inTab('unacked', delivery.id), true, 'waiting in the Unacknowledged tab');
    assert.equal(await inTab('acked', delivery.id), false);
    const before = (await call('GET', '/api/alerts/summary', A)).body;
    assert.equal((await call('POST', `/api/alerts/${delivery.id}/ack`, A, {})).status, 200);
    assert.equal(await inTab('unacked', delivery.id), false, 'acknowledged: gone from Unacknowledged');
    assert.equal(await inTab('acked', delivery.id), true, '...and now in Acknowledged');
    const after = (await call('GET', '/api/alerts/summary', A)).body;
    assert.equal(Number(after.unacked), Number(before.unacked) - 1);
    assert.equal(Number(after.acked), Number(before.acked) + 1);
    assert.equal(await inTab('acked', deliveryB.id), false, 'post B\'s alerts are in neither tab of post A');
    assert.equal((await call('POST', `/api/alerts/${delivery.id}/ack`, A, {})).status, 400);
    const d = await call('GET', `/api/alerts/${delivery.id}`, A);
    assert.equal(d.body.alert.alert_status, 'acknowledged');
    assert.deepEqual(d.body.history.map((h) => h.to_status), ['acknowledged']);
  });

  let requestId;
  await t.test('request footage: validation, duplicate guard, cancel', async () => {
    const win = { window_start: new Date(Date.now() - 25 * 60000).toISOString(), window_end: new Date(Date.now() - 15 * 60000).toISOString() };
    assert.equal((await call('POST', '/api/requests', A, { camera_id: cam.id, ...win })).status, 400, 'reason required');
    const hr = 3600000;
    assert.equal((await call('POST', '/api/requests', A, { camera_id: cam.id, window_start: new Date(Date.now() - 6 * hr).toISOString(), window_end: new Date(Date.now() - 1 * hr).toISOString(), reason: 'x' })).status, 400, 'window longer than MAX_REQUEST_WINDOW_MIN');
    assert.equal((await call('POST', '/api/requests', A, { camera_id: cam.id, window_start: new Date(Date.now() + hr).toISOString(), window_end: new Date(Date.now() + 2 * hr).toISOString(), reason: 'x' })).status, 400, 'window starting in the future');
    assert.equal((await call('POST', '/api/requests', A, { camera_id: cam.id, window_start: win.window_end, window_end: win.window_start, reason: 'x' })).status, 400, 'end before start');
    const [other] = await q(`SELECT c.id FROM camera c JOIN nvr_unit n ON n.id = c.nvr_id WHERE n.current_zone_id <> $1 LIMIT 1`, [zone.id]);
    if (other) assert.equal((await call('POST', '/api/requests', A, { camera_id: other.id, ...win, reason: 'x' })).status, 400, 'camera outside zone');

    const r = await call('POST', `/api/incidents/${incident.id}/requests`, A, { camera_id: cam.id, reason: 'intruder on platform' });
    assert.equal(r.status, 201);
    requestId = r.body.id;
    assert.equal((await call('POST', `/api/incidents/${incident.id}/requests`, A, { camera_id: cam.id, reason: 'again' })).status, 409);
    assert.equal((await call('POST', `/api/incidents/${incidentB.id}/requests`, A, { camera_id: cam.id, reason: 'x' })).status, 404);

    assert.equal((await call('POST', `/api/requests/${requestId}/cancel`, A)).status, 200);
    assert.equal((await call('POST', `/api/requests/${requestId}/cancel`, A)).status, 409);
    const again = await call('POST', `/api/incidents/${incident.id}/requests`, A, { camera_id: cam.id, reason: 'take two' });
    assert.equal(again.status, 201);
    requestId = again.body.id;
  });

  // CMS side: operator approves, ingest delivers one stitched file.
  const content = crypto.randomBytes(5000);
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  fs.writeFileSync(path.join(tmpMedia, `req-${requestId}.mp4`), content);
  await q(`UPDATE video_request SET status = 'approved', operator_id = $2, decided_at = now() WHERE id = $1`, [requestId, op.id]);
  const [footage] = await q(
    `INSERT INTO delivered_footage (video_request_id, storage_path, format, sha256, file_size_bytes) VALUES ($1, $2, 'MP4', $3, $4) RETURNING id`,
    [requestId, `req-${requestId}.mp4`, sha, content.length]);
  await q(`UPDATE video_request SET status = 'fulfilled' WHERE id = $1`, [requestId]);

  await t.test('footage: listed, gated by scope, served via short-lived link with range + integrity', async () => {
    const sum = await call('GET', '/api/alerts/summary', A);
    assert.equal(sum.body.last_footage_id, footage.id);
    assert.equal((await call('GET', '/api/footage', A)).body.length, 1);
    assert.equal((await call('POST', `/api/footage/${footage.id}/access`, B, { purpose: 'view' })).status, 404, 'another post\'s footage cannot be opened');
    assert.equal((await call('POST', `/api/footage/${footage.id}/access`, A, { purpose: 'bogus' })).status, 400);

    const view = await call('POST', `/api/footage/${footage.id}/access`, A, { purpose: 'view' });
    assert.equal(view.status, 200);
    const full = await call('GET', view.body.url);
    assert.equal(full.status, 200);
    assert.equal(crypto.createHash('sha256').update(full.body).digest('hex'), sha);
    assert.equal(full.headers.get('x-content-sha256'), sha);

    const part = await call('GET', view.body.url, null, null, { Range: 'bytes=10-19' });
    assert.equal(part.status, 206);
    assert.deepEqual(part.body, content.subarray(10, 20));
    assert.equal((await call('GET', view.body.url, null, null, { Range: 'bytes=999999-' })).status, 416);

    assert.equal((await call('GET', `/api/media/${footage.id}?token=${'a'.repeat(64)}`)).status, 401);
    assert.equal((await call('GET', `/api/media/${footage.id}`)).status, 401);

    const dl = await call('POST', `/api/footage/${footage.id}/access`, A, { purpose: 'download' });
    const file = await call('GET', dl.body.url);
    assert.match(file.headers.get('content-disposition'), /attachment/);

    // An expired grant stops working immediately.
    await q(`UPDATE video_access_grant SET expires_at = now() - interval '1 second' WHERE request_id = $1`, [requestId]);
    assert.equal((await call('GET', view.body.url)).status, 401);
  });

  await t.test('flag for retention: justification mandatory, own post only', async () => {
    const url = `/api/footage/${footage.id}/flag`;
    assert.equal((await call('POST', url, A, { justification: '  ' })).status, 400);
    assert.equal((await call('POST', url, B, { justification: 'x' })).status, 404, 'another post\'s footage cannot be flagged');
    const f = await call('POST', url, A, { justification: 'Needed for prosecution' });
    assert.equal(f.status, 201);
    assert.equal(f.body.status, 'active');
    assert.equal((await call('GET', '/api/flags', A)).body.length, 1);
    assert.equal((await call('GET', '/api/footage', A)).body[0].active_flags, 1);
  });

  await t.test('incident lifecycle is forward-only and closing resolves the alert', async () => {
    assert.equal((await call('PATCH', `/api/incidents/${incidentB.id}/status`, A, { status: 'closed' })).status, 404);
    assert.equal((await call('PATCH', `/api/incidents/${incident.id}/status`, A, { status: 'open' })).status, 400);
    assert.equal((await call('PATCH', `/api/incidents/${incident.id}/status`, A, { status: 'under_review' })).status, 200);
    const listIds = async (st) => (await call('GET', `/api/incidents?status=${st}`, A)).body.map((x) => x.id);
    assert.ok((await listIds('active')).includes(incident.id), 'open incident is in the Open tab');
    const sumBefore = (await call('GET', '/api/alerts/summary', A)).body;
    assert.equal((await call('PATCH', `/api/incidents/${incident.id}/status`, A, { status: 'closed', note: 'handed to GRP' })).status, 200);
    assert.ok(!(await listIds('active')).includes(incident.id), 'closed: gone from the Open tab');
    assert.ok((await listIds('closed')).includes(incident.id), '...and listed under Closed incidents');
    const sumAfter = (await call('GET', '/api/alerts/summary', A)).body;
    assert.equal(Number(sumAfter.open_incidents), Number(sumBefore.open_incidents) - 1);
    assert.equal(Number(sumAfter.closed_incidents), Number(sumBefore.closed_incidents) + 1);
    assert.equal((await call('PATCH', `/api/incidents/${incident.id}/status`, A, { status: 'under_review' })).status, 409);
    const d = await call('GET', `/api/alerts/${delivery.id}`, A);
    assert.equal(d.body.alert.alert_status, 'resolved');
    assert.equal((await call('GET', '/api/alerts?state=closed', A)).body.length, 1);
    assert.equal((await call('GET', '/api/alerts?state=active', A)).body.length, 0);
  });

  await t.test('activity log: this post\'s own chain of custody, covering every action', async () => {
    assert.equal((await call('GET', '/api/admin/audit', A)).status, 404, 'the admin API no longer exists');
    const audit = await call('GET', '/api/audit?limit=200', A);
    const actions = new Set(audit.body.map((a) => a.action));
    for (const a of ['auth.login', 'alert.ack', 'request.create', 'request.cancel', 'footage.view', 'footage.download',
      'footage.download.served', 'footage.flag', 'incident.status']) {
      assert.ok(actions.has(a), `audit log is missing ${a}`);
    }
    assert.ok((await call('GET', '/api/audit', B)).body.every((e) => e.username !== `a-${sfx}`), 'B\'s audit trail holds nothing of post A');
  });
});
