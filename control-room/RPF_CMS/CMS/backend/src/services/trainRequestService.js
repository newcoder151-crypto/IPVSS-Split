/**
 * Footage requests BY TRAIN NUMBER.
 *
 *   RPF officer  --(train_no + window + reason)-->  train_request            status: submitted
 *   CMS operator / auto-approve                     decide()                 approve | amend | reject
 *   CMS fan-out                                     expand()                 one video_request per ACTIVE camera of EVERY
 *                                                                            M-NVR unit of the train (train_request_id set)
 *   existing per-camera machinery (requestService)  upload_now command per camera, queued until that unit's bridge
 *                                                   connects; resumable, SHA-256 verified upload; stitched MP4 delivered as
 *                                                   <TRAIN>_M<nn>_C<nn>_<start>_<end>.mp4  (naming.js)
 *   refresh()                                       train_request.status / counters follow its children
 *
 * Units connect independently (one tunnel at a time), so a train request is "awaiting_upload" until the last unit has
 * delivered and "partial" if some camera's footage could not be delivered. Footage of the cameras that did arrive is
 * available to CMS and RPF at once - the officer does not wait for the slowest unit.
 */
const { pool, withTransaction } = require('../db');
const { badRequest, notFound, conflict } = require('../errors');
const settings = require('./settings');
const notify = require('./notify');
const { audit } = require('./audit');
const { canSeeZone } = require('../middleware/auth');
const { getSystemUserId } = require('./alertService');
const requests = require('./requestService');

const OPEN_TR = ['approved', 'awaiting_upload'];
const OPEN_CHILD = ['approved', 'amended', 'awaiting_upload'];

const TR_SELECT = `
  SELECT t.*, p.name AS post_name, ur.username AS requested_by_username, uo.username AS operator_username
    FROM train_request t
    JOIN rpf_post p ON p.id = t.post_id
    JOIN users ur ON ur.id = t.requested_by
    LEFT JOIN users uo ON uo.id = t.operator_id`;

async function load(client, id, { lock = false } = {}) {
  const { rows } = await (client || pool).query(`${TR_SELECT} WHERE t.id = $1 ${lock ? 'FOR UPDATE OF t' : ''}`, [id]);
  return rows[0] || null;
}

/** Per camera: its request, state, M-NVR unit (and whether it is connected), upload command and delivered file. */
async function cameraRows(id) {
  const { rows } = await pool.query(
    `SELECT r.id AS request_id, r.status, r.failure_reason, r.camera_id, COALESCE(c.mnvr_camera_id, c.id) AS camera_no, c.name AS camera_name, c.mount_position,
            n.id AS nvr_id, COALESCE(n.unit_no, n.id) AS unit_no, n.name AS nvr_name, n.last_seen,
            (n.last_seen > now() - make_interval(secs => 60)) AS unit_online,
            (SELECT m.status FROM nvr_command m WHERE m.request_id = r.id ORDER BY m.id DESC LIMIT 1) AS command_status,
            f.id AS footage_id, f.file_name, f.file_size_bytes, f.duration_s, f.start_time AS footage_start, f.end_time AS footage_end,
            f.sha256, f.delivered_at
       FROM video_request r
       JOIN camera c ON c.id = r.camera_id
       JOIN nvr_unit n ON n.id = c.nvr_id
       LEFT JOIN LATERAL (SELECT * FROM delivered_footage d WHERE d.video_request_id = r.id ORDER BY d.id DESC LIMIT 1) f ON TRUE
      WHERE r.train_request_id = $1
      ORDER BY COALESCE(n.unit_no, n.id), COALESCE(c.mnvr_camera_id, c.id)`, [id]);
  return rows;
}

/** Units of a train (the M-NVRs that report this train number) with their cameras - read straight from the units' own rows. */
async function trainOverview(trainNo) {
  const { rows: units } = await pool.query(
    `SELECT n.id AS nvr_id, n.name, COALESCE(n.unit_no, n.id) AS unit_no, n.status, n.last_seen, n.current_zone_id AS zone_id,
            (n.last_seen > now() - make_interval(secs => 60)) AS online
       FROM nvr_unit n WHERE lower(btrim(n.train_no)) = lower(btrim($1)) ORDER BY 3`, [trainNo]);
  const { rows: cams } = await pool.query(
    `SELECT c.id, c.nvr_id, COALESCE(c.mnvr_camera_id, c.id) AS camera_no, c.name, c.mount_position, c.active
       FROM camera c JOIN nvr_unit n ON n.id = c.nvr_id WHERE lower(btrim(n.train_no)) = lower(btrim($1)) ORDER BY 3`, [trainNo]);
  return units.map((u) => ({ ...u, cameras: cams.filter((c) => c.nvr_id === u.nvr_id) }));
}

// ---------------------------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------------------------

/** Creates the per-camera requests (status 'approved') inside the caller's transaction. Returns { ids, skipped, units }. */
async function expand(client, tr, { operatorId, note, orig }) {
  const { rows: cams } = await client.query(
    `SELECT c.id AS camera_id, COALESCE(c.mnvr_camera_id, c.id) AS camera_no, c.active, n.id AS nvr_id, COALESCE(n.unit_no, n.id) AS unit_no, n.name AS nvr_name, n.status AS nvr_status
       FROM camera c JOIN nvr_unit n ON n.id = c.nvr_id
      WHERE lower(btrim(n.train_no)) = lower(btrim($1)) ORDER BY 5, 2`, [tr.train_no]);
  const eligible = cams.filter((c) => c.active && c.nvr_status === 'active');
  const skipped = cams.filter((c) => !(c.active && c.nvr_status === 'active'))
    .map((c) => ({ unit_no: c.unit_no, nvr: c.nvr_name, camera_no: c.camera_no, reason: c.nvr_status !== 'active' ? `M-NVR is ${c.nvr_status}` : 'camera is inactive' }));
  const ids = [];
  for (const c of eligible) {
    const { rows } = await client.query(
      `INSERT INTO video_request (post_id, requested_by, alert_id, alert_event_time, camera_id, window_start, window_end, reason, incident_id,
                                  status, operator_id, decided_at, decision_note, train_request_id, orig_window_start, orig_window_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'approved',$10,now(),$11,$12,$13,$14)
       ON CONFLICT (train_request_id, camera_id) WHERE train_request_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [tr.post_id, tr.requested_by, tr.alert_id, tr.alert_event_time, c.camera_id, tr.window_start, tr.window_end, tr.reason, tr.incident_id,
        operatorId, note || `part of train request #${tr.id}`, tr.id, orig ? orig.start : null, orig ? orig.end : null]);
    if (rows.length) ids.push(rows[0].id);
  }
  return { ids, skipped, units: new Set(eligible.map((c) => c.nvr_id)).size, cameras: eligible.length };
}

// ---------------------------------------------------------------------------------------------
// Operator decisions
// ---------------------------------------------------------------------------------------------

/** action: 'approve' | 'amend' | 'reject'. Only a 'submitted' train request can be decided. */
async function decide(user, id, action, { note, window_start, window_end } = {}) {
  const maxWin = await settings.get('request_max_window_min');
  let childIds = [];
  await withTransaction(async (client) => {
    const tr = await load(client, id, { lock: true });
    if (!tr || !canSeeZone(user, tr.zone_id)) throw notFound('train request not found');
    if (tr.status !== 'submitted') throw conflict(`train request #${id} is '${tr.status}', not waiting for a decision`);
    const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 1000) : null;

    if (action === 'reject') {
      if (!cleanNote) throw badRequest('a note is required when rejecting a request');
      await client.query(`UPDATE train_request SET status='rejected', operator_id=$2, decided_at=now(), decision_note=$3, updated_at=now() WHERE id=$1`, [id, user.id, cleanNote]);
      await notify.send(client, { zone_id: tr.zone_id, post_id: tr.post_id, kind: 'request', ref_entity: 'train_request', ref_id: id,
        title: `Footage request #${id} for train ${tr.train_no} was rejected`, body: cleanNote });
    } else if (action === 'approve' || action === 'amend') {
      let orig = null; let ws = tr.window_start; let we = tr.window_end;
      if (action === 'amend') {
        ws = new Date(window_start); we = new Date(window_end);
        if (Number.isNaN(ws.getTime()) || Number.isNaN(we.getTime()) || we <= ws) throw badRequest('a valid window_start and a later window_end are required');
        if ((we - ws) / 60000 > maxWin) throw badRequest(`the window may not exceed ${maxWin} minutes`);
        if (ws > new Date()) throw badRequest('window_start is in the future');
        orig = { start: tr.window_start, end: tr.window_end };
      }
      const fan = await expand(client, { ...tr, window_start: ws, window_end: we }, { operatorId: user.id, note: cleanNote, orig });
      childIds = fan.ids;
      if (!fan.cameras) {
        await client.query(`UPDATE train_request SET status='failed', operator_id=$2, decided_at=now(), decision_note=$3, failure_reason=$4, skipped=$5, updated_at=now() WHERE id=$1`,
          [id, user.id, cleanNote, 'the train has no active camera on an active M-NVR unit', JSON.stringify(fan.skipped)]);
        await notify.send(client, { zone_id: tr.zone_id, post_id: tr.post_id, kind: 'request', ref_entity: 'train_request', ref_id: id,
          title: `Footage request #${id} for train ${tr.train_no} failed`, body: 'The train has no active camera on an active M-NVR unit.' });
      } else {
        await client.query(
          `UPDATE train_request SET status='approved', operator_id=$2, decided_at=now(), decision_note=$3, expanded_at=now(), window_start=$4, window_end=$5,
                  orig_window_start=$6, orig_window_end=$7, units_total=$8, cameras_total=$9, cameras_open=$9, skipped=$10, updated_at=now() WHERE id=$1`,
          [id, user.id, cleanNote || (action === 'amend' ? 'window amended by operator' : null), ws, we, orig && orig.start, orig && orig.end, fan.units, fan.cameras, JSON.stringify(fan.skipped)]);
      }
    } else throw badRequest("action must be 'approve', 'amend' or 'reject'");
    await audit(client, { user, action: `train_request.${action}`, entity: 'train_request', entityId: id, zoneId: tr.zone_id,
      details: { train_no: tr.train_no, note: cleanNote, window_start, window_end, requests_created: childIds.length } });
  });
  // Outside the transaction: each camera's request is processed (delivered at once if CMS already holds the footage,
  // else an upload command waits for that unit's bridge).
  for (const cid of childIds) await requests.processRequest(cid).catch((e) => console.error(`request #${cid}:`, e.message));
  if (childIds.length) await refresh(id);
  return load(null, id);
}

// ---------------------------------------------------------------------------------------------
// Progress: the train request follows its children
// ---------------------------------------------------------------------------------------------

async function refresh(id) {
  await withTransaction(async (client) => {
    const tr = await load(client, id, { lock: true });
    if (!tr || !OPEN_TR.includes(tr.status)) return;
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE r.status = 'fulfilled')::int AS ful,
              COUNT(*) FILTER (WHERE r.status = ANY($2))::int AS open,
              COUNT(*) FILTER (WHERE r.status IN ('failed','expired'))::int AS bad,
              COUNT(*) FILTER (WHERE r.status = 'expired')::int AS expired,
              COUNT(*) FILTER (WHERE r.status IN ('cancelled','rejected'))::int AS cancelled,
              COUNT(*) FILTER (WHERE r.status = 'awaiting_upload')::int AS waiting,
              COUNT(DISTINCT c.nvr_id)::int AS units,
              COUNT(DISTINCT c.nvr_id) FILTER (WHERE r.status = 'fulfilled')::int AS units_ful,
              (SELECT string_agg(DISTINCT x.failure_reason, ' | ') FROM video_request x WHERE x.train_request_id = $1 AND x.failure_reason IS NOT NULL AND x.status IN ('failed','expired')) AS reasons
         FROM video_request r JOIN camera c ON c.id = r.camera_id WHERE r.train_request_id = $1`, [id, OPEN_CHILD]);
    const s = rows[0];
    if (!s.total) return;

    let status;
    if (s.open > 0) status = s.waiting > 0 ? 'awaiting_upload' : 'approved';
    else if (s.ful === s.total) status = 'fulfilled';
    else if (s.ful > 0) status = 'partial';
    else if (s.cancelled === s.total) status = 'cancelled';
    else if (s.expired > 0 && s.expired === s.bad && s.ful === 0 && s.cancelled === 0) status = 'expired';
    else status = 'failed';
    const done = !['approved', 'awaiting_upload'].includes(status);
    const reason = s.reasons ? String(s.reasons).slice(0, 600) : null;

    await client.query(
      `UPDATE train_request SET status=$2, units_total=$3, cameras_total=$4, cameras_fulfilled=$5, cameras_open=$6, cameras_failed=$7,
              failure_reason=$8, fulfilled_at = CASE WHEN $9 AND $5 > 0 THEN now() ELSE fulfilled_at END, updated_at = now()
        WHERE id=$1 AND (status IS DISTINCT FROM $2 OR cameras_fulfilled IS DISTINCT FROM $5 OR cameras_open IS DISTINCT FROM $6 OR cameras_failed IS DISTINCT FROM $7)`,
      [id, status, s.units, s.total, s.ful, s.open, s.bad + s.cancelled, reason, done]);

    if (status === tr.status) return;
    const where = { zone_id: tr.zone_id, post_id: tr.post_id, ref_entity: 'train_request', ref_id: id };
    if (status === 'awaiting_upload' || status === 'approved') {
      // progress only: no pop-up - the officer sees it on the request, and gets ONE notice when the request ends
    } else if (status === 'fulfilled') {
      await notify.send(client, { ...where, kind: 'footage',
        title: `Footage ready: train ${tr.train_no} (request #${id})`, body: `${s.ful} camera(s) from ${s.units} M-NVR unit(s).` });
    } else if (status === 'partial') {
      await notify.send(client, { ...where, kind: 'footage',
        title: `Footage partly ready: train ${tr.train_no} (request #${id})`, body: `${s.ful} of ${s.total} camera(s) delivered. ${reason || ''}`.trim() });
    } else if (['failed', 'expired'].includes(status)) {
      await notify.send(client, { ...where, kind: 'request',
        title: `Request #${id} for train ${tr.train_no} ${status}`, body: reason });
    }
    await audit(client, { user: null, action: `train_request.${status}`, entity: 'train_request', entityId: id, zoneId: tr.zone_id,
      details: { cameras_total: s.total, cameras_fulfilled: s.ful, cameras_failed: s.bad, cameras_open: s.open } });
  });
}

// ---------------------------------------------------------------------------------------------
// Operator actions on the whole train request
// ---------------------------------------------------------------------------------------------

async function operatorCancel(user, id, note) {
  await withTransaction(async (client) => {
    const tr = await load(client, id, { lock: true });
    if (!tr || !canSeeZone(user, tr.zone_id)) throw notFound('train request not found');
    if (!['submitted', ...OPEN_TR].includes(tr.status)) throw conflict(`train request is '${tr.status}'`);
    await cancelAll(client, tr, `cancelled by operator${note ? ': ' + note : ''}`);
    await audit(client, { user, action: 'train_request.cancel', entity: 'train_request', entityId: id, zoneId: tr.zone_id, details: { note } });
    await notify.send(client, { zone_id: tr.zone_id, post_id: tr.post_id, kind: 'request', ref_entity: 'train_request', ref_id: id,
      title: `Request #${id} for train ${tr.train_no} was cancelled by CMS`, body: note || null });
  });
  return load(null, id);
}

/** Cancels the parent and every camera request still open (their upload commands too). Not-yet-delivered footage only. */
async function cancelAll(client, tr, note) {
  await client.query(
    `UPDATE video_request SET status='cancelled', decision_note = concat_ws(' | ', decision_note, $2::text)
      WHERE train_request_id = $1 AND status = ANY($3)`, [tr.id, note, OPEN_CHILD]);
  await client.query(`UPDATE nvr_command SET status='cancelled', completed_at=now() WHERE train_request_id=$1 AND status IN ('queued','sent','acked')`, [tr.id]);
  const { rows } = await client.query(`SELECT COUNT(*) FILTER (WHERE status = 'fulfilled')::int AS ful, COUNT(*)::int AS total FROM video_request WHERE train_request_id = $1`, [tr.id]);
  const keep = rows[0].ful > 0;        // some cameras were already delivered: the request is then 'partial', not 'cancelled'
  await client.query(`UPDATE train_request SET status=$2, decision_note = concat_ws(' | ', decision_note, $3::text), cameras_open=0, cameras_fulfilled=$4, updated_at=now() WHERE id=$1`,
    [tr.id, keep ? 'partial' : 'cancelled', note, rows[0].ful]);
}

/** Re-send the upload command of every camera that is still open or failed. */
async function retryUpload(user, id) {
  const tr = await load(null, id);
  if (!tr || !canSeeZone(user, tr.zone_id)) throw notFound('train request not found');
  if (!['approved', 'awaiting_upload', 'partial', 'failed'].includes(tr.status)) throw conflict(`train request is '${tr.status}'`);
  const { rows } = await pool.query(`SELECT id FROM video_request WHERE train_request_id = $1 AND status IN ('approved','amended','awaiting_upload','failed') ORDER BY id`, [id]);
  let n = 0;
  for (const { id: rid } of rows) { try { await requests.reissueUpload(user, rid); n++; } catch (e) { console.warn(`retry #${rid}:`, e.message); } }
  if (tr.status === 'partial' || tr.status === 'failed') await pool.query(`UPDATE train_request SET status='awaiting_upload', failure_reason=NULL, updated_at=now() WHERE id=$1 AND status IN ('partial','failed')`, [id]);
  await refresh(id);
  await audit(null, { user, action: 'train_request.retry_upload', entity: 'train_request', entityId: id, zoneId: tr.zone_id, details: { requests: n } });
  return load(null, id);
}

/** Deliver what CMS holds for every camera that has any footage uploaded (operator "deliver what we have"). */
async function deliverPartial(user, id) {
  const tr = await load(null, id);
  if (!tr || !canSeeZone(user, tr.zone_id)) throw notFound('train request not found');
  const { rows } = await pool.query(`SELECT id FROM video_request WHERE train_request_id = $1 AND status IN ('approved','amended','awaiting_upload','failed') ORDER BY id`, [id]);
  let delivered = 0; const none = [];
  for (const { id: rid } of rows) { try { await requests.forceDeliver(user, rid); delivered++; } catch (e) { none.push(rid); } }
  if (!delivered) throw badRequest('no footage for this train has been uploaded yet');
  await refresh(id);
  await audit(null, { user, action: 'train_request.deliver_partial', entity: 'train_request', entityId: id, zoneId: tr.zone_id, details: { delivered, without_footage: none } });
  return load(null, id);
}

/**
 * A unit reported its cameras (the bridge reads them straight from the M-NVR when it connects). A camera that is new since a
 * train request was approved gets its own request too, so the footage of every camera of the train is always asked for.
 */
async function addCamerasToOpen(nvrId) {
  const { rows } = await pool.query(
    `SELECT t.id FROM train_request t JOIN nvr_unit n ON lower(btrim(n.train_no)) = lower(btrim(t.train_no))
      WHERE n.id = $1 AND t.status = ANY($2)`, [nvrId, OPEN_TR]);
  let added = 0;
  for (const { id } of rows) {
    const ids = await withTransaction(async (client) => {
      const tr = await load(client, id, { lock: true });
      if (!tr || !OPEN_TR.includes(tr.status)) return [];
      const fan = await expand(client, tr, { operatorId: tr.operator_id, note: `camera added to train ${tr.train_no} after approval` });
      if (fan.ids.length) await client.query(`UPDATE train_request SET cameras_total = cameras_total + $2, cameras_open = cameras_open + $2, updated_at = now() WHERE id = $1`, [id, fan.ids.length]);
      return fan.ids;
    });
    for (const cid of ids) await requests.processRequest(cid).catch((e) => console.error(`request #${cid}:`, e.message));
    if (ids.length) { added += ids.length; await refresh(id); }
  }
  return added;
}

// ---------------------------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------------------------
async function processOpen() {
  let n = 0;
  if (await settings.get('auto_approve_requests')) {
    const sys = { id: await getSystemUserId(), zone_id: null, role: 'super_admin' };
    const { rows } = await pool.query(`SELECT id FROM train_request WHERE status = 'submitted' AND created_at < now() - interval '3 seconds' ORDER BY id`);
    for (const { id } of rows) { try { await decide(sys, id, 'approve', { note: 'auto-approved (CMS setting)' }); n++; } catch (e) { console.warn(`auto-approve train request #${id}:`, e.message); } }
  }
  const { rows } = await pool.query(`SELECT id FROM train_request WHERE status = ANY($1) ORDER BY id`, [OPEN_TR]);
  for (const { id } of rows) { try { await refresh(id); n++; } catch (e) { console.error(`train request #${id}:`, e.message); } }
  return n;
}

module.exports = { TR_SELECT, OPEN_TR, load, cameraRows, trainOverview, addCamerasToOpen, decide, refresh, operatorCancel, retryUpload, deliverPartial, processOpen };
