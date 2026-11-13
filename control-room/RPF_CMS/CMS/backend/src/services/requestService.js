const { pool, withTransaction } = require("../db");
const { badRequest, notFound, conflict, forbidden } = require("../errors");
const settings = require("./settings");
const notify = require("./notify");
const { audit } = require("./audit");
const { coverage } = require("./segmentService");
const { stitch, probeDuration, cutClip } = require("./footageService");
const { absPath, sha256File, exists } = require("./fsutil");
const { canSeeZone } = require("../middleware/auth");
const { getSystemUserId } = require("./alertService");
const naming = require("./naming");
const fs = require("fs");

// A request that belongs to a train request (one camera of it) does not notify the post on its own: the train request
// sends ONE notice for the whole train. (Lazy require: trainRequestService depends on this module.)
const trainSvc = () => require("./trainRequestService");
const refreshParent = (r) =>
  r && r.train_request_id
    ? trainSvc()
        .refresh(r.train_request_id)
        .catch((e) =>
          console.error(`train request #${r.train_request_id}:`, e.message),
        )
    : null;

const OPEN = ["approved", "amended", "awaiting_upload"];

const REQUEST_SELECT = `
  SELECT r.*, p.zone_id, p.name AS post_name, c.name AS camera_name, COALESCE(c.mnvr_camera_id, c.id) AS camera_no, c.nvr_id, n.name AS nvr_name, n.train_no, COALESCE(n.unit_no, n.id) AS unit_no,
         ur.username AS requested_by_username, uo.username AS operator_username,
         n.last_seen AS nvr_last_seen,
         (SELECT COUNT(*) FROM delivered_footage f WHERE f.video_request_id = r.id) AS footage_count
    FROM video_request r
    JOIN rpf_post p ON p.id = r.post_id
    JOIN camera c ON c.id = r.camera_id
    JOIN nvr_unit n ON n.id = c.nvr_id
    JOIN users ur ON ur.id = r.requested_by
    LEFT JOIN users uo ON uo.id = r.operator_id`;

async function loadRequest(client, id, { lock = false } = {}) {
  const { rows } = await (client || pool).query(
    `${REQUEST_SELECT} WHERE r.id = $1 ${lock ? "FOR UPDATE OF r" : ""}`,
    [id],
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------------------------
// Operator decisions
// ---------------------------------------------------------------------------------------------

/**
 * action: 'approve' | 'amend' | 'reject'. Only a 'submitted' request can be decided.
 * After approval CMS checks whether the footage is already in the catalogue: if so it is stitched and
 * delivered at once; if not, an upload-now command waits for the NVR (request -> awaiting_upload).
 */
async function decide(
  user,
  id,
  action,
  { note, window_start, window_end } = {},
) {
  const maxWin = await settings.get("request_max_window_min");
  await withTransaction(async (client) => {
    const r = await loadRequest(client, id, { lock: true });
    if (!r || !canSeeZone(user, r.zone_id)) throw notFound("request not found");
    if (r.status !== "submitted")
      throw conflict(
        `request #${id} is '${r.status}', not waiting for a decision`,
      );
    const cleanNote =
      typeof note === "string" && note.trim()
        ? note.trim().slice(0, 1000)
        : null;

    if (action === "reject") {
      if (!cleanNote)
        throw badRequest("a note is required when rejecting a request");
      await client.query(
        `UPDATE video_request SET status='rejected', operator_id=$2, decided_at=now(), decision_note=$3 WHERE id=$1`,
        [id, user.id, cleanNote],
      );
      await notify.send(client, {
        zone_id: r.zone_id,
        post_id: r.post_id,
        kind: "request",
        ref_entity: "video_request",
        ref_id: id,
        title: `Footage request #${id} was rejected`,
        body: cleanNote,
      });
    } else if (action === "approve") {
      await client.query(
        `UPDATE video_request SET status='approved', operator_id=$2, decided_at=now(), decision_note=$3 WHERE id=$1`,
        [id, user.id, cleanNote],
      );
    } else if (action === "amend") {
      const ws = new Date(window_start);
      const we = new Date(window_end);
      if (Number.isNaN(ws.getTime()) || Number.isNaN(we.getTime()) || we <= ws)
        throw badRequest(
          "a valid window_start and a later window_end are required",
        );
      if ((we - ws) / 60000 > maxWin)
        throw badRequest(`the window may not exceed ${maxWin} minutes`);
      if (ws > new Date()) throw badRequest("window_start is in the future");
      await client.query(
        `UPDATE video_request SET status='amended', operator_id=$2, decided_at=now(), decision_note=$3,
                orig_window_start=window_start, orig_window_end=window_end, window_start=$4, window_end=$5 WHERE id=$1`,
        [id, user.id, cleanNote || "window amended by operator", ws, we],
      );
    } else throw badRequest("action must be 'approve', 'amend' or 'reject'");
    await audit(client, {
      user,
      action: `request.${action}`,
      entity: "video_request",
      entityId: id,
      zoneId: r.zone_id,
      details: { note: cleanNote, window_start, window_end },
    });
  });
  if (action !== "reject")
    await processRequest(id).catch((e) =>
      console.error(`request #${id}:`, e.message),
    );
  return loadRequest(null, id);
}

// ---------------------------------------------------------------------------------------------
// Commands to the NVR
// ---------------------------------------------------------------------------------------------

async function issueUploadCommand(
  client,
  {
    nvrId,
    cameraId,
    from,
    to,
    requestId = null,
    userId = null,
    trainRequestId = null,
  },
) {
  const q = client || pool;
  const { rows: open } = await q.query(
    `SELECT id FROM nvr_command WHERE nvr_id = $1 AND kind = 'upload_now' AND camera_id = $2 AND status IN ('queued','sent','acked')
        AND window_start <= $3 AND window_end >= $4 AND request_id IS NOT DISTINCT FROM $5 LIMIT 1`,
    [nvrId, cameraId, from, to, requestId],
  );
  if (open.length) return open[0].id;
  const { rows } = await q.query(
    `INSERT INTO nvr_command (nvr_id, kind, camera_id, window_start, window_end, request_id, created_by, train_request_id)
     VALUES ($1,'upload_now',$2,$3,$4,$5,$6,$7) RETURNING id`,
    [nvrId, cameraId, from, to, requestId, userId, trainRequestId],
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------------------------
// Processing: approved -> (deliver | awaiting_upload) -> fulfilled | failed | expired
// ---------------------------------------------------------------------------------------------

const processing = new Set();
async function processRequest(id) {
  if (processing.has(id)) return;
  processing.add(id);
  try {
    const r = await loadRequest(null, id);
    if (!r || !OPEN.includes(r.status)) return;
    const cov = await coverage(r.camera_id, r.window_start, r.window_end);
    if (cov.covered) return await deliver(r, cov, false);

    const { rows: cmds } = await pool.query(
      `SELECT id, status, result FROM nvr_command WHERE request_id = $1 ORDER BY id DESC LIMIT 1`,
      [id],
    );
    const cmd = cmds[0];

    if (cmd && cmd.status === "done") {
      // the NVR says it uploaded everything it has
      if (cov.segments.length) return await deliver(r, cov, true);
      return await fail(
        r,
        "failed",
        `the NVR reports it has no recording for this window${cmd.result && cmd.result.note ? `: ${cmd.result.note}` : ""}`,
      );
    }
    if (cmd && cmd.status === "failed")
      return await fail(
        r,
        "failed",
        `NVR upload failed: ${(cmd.result && cmd.result.error) || "unknown error"}`,
      );

    const waitedSince = r.upload_requested_at || r.decided_at || r.created_at;
    const expiryDays = await settings.get("request_expiry_days");
    if (
      expiryDays > 0 &&
      Date.now() - new Date(waitedSince).getTime() > expiryDays * 86400000
    ) {
      // 0 = never: wait for the unit however long it takes
      return await fail(
        r,
        "expired",
        `the NVR did not come online and upload the footage within ${expiryDays} days (30-day FIFO)`,
      );
    }

    if (r.status !== "awaiting_upload") {
      await withTransaction(async (client) => {
        await issueUploadCommand(client, {
          nvrId: r.nvr_id,
          cameraId: r.camera_id,
          from: r.window_start,
          to: r.window_end,
          requestId: id,
          userId: r.operator_id,
          trainRequestId: r.train_request_id,
        });
        await client.query(
          `UPDATE video_request SET status='awaiting_upload', upload_requested_at=now() WHERE id=$1 AND status = ANY($2)`,
          [id, ["approved", "amended"]],
        );
        await audit(client, {
          user: null,
          action: "request.awaiting_upload",
          entity: "video_request",
          entityId: id,
          zoneId: r.zone_id,
          details: { missing: cov.gaps },
        });
        if (!r.train_request_id)
          await notify.send(client, {
            zone_id: r.zone_id,
            post_id: r.post_id,
            kind: "request",
            ref_entity: "video_request",
            ref_id: id,
            title: `Request #${id} approved - waiting for the train's NVR`,
            body: "The footage is on the train. CMS has told the NVR to upload it; it will arrive when the train is back in coverage.",
          });
      });
      await refreshParent(r);
    } else if (!cmd || ["cancelled"].includes(cmd.status)) {
      await issueUploadCommand(null, {
        nvrId: r.nvr_id,
        cameraId: r.camera_id,
        from: r.window_start,
        to: r.window_end,
        requestId: id,
        trainRequestId: r.train_request_id,
      });
    }
  } finally {
    processing.delete(id);
  }
}

async function deliver(r, cov, partial) {
  // <TRAIN>_M<nn>_C<nn>_<start>_<end>.mp4 under zone-<z>/train-<TRAIN>/TR<n>|REQ<n>/  (naming.js)
  const ident = {
    trainNo: r.train_no,
    unitNo: r.unit_no,
    cameraNo: r.camera_no,
    nvrId: r.nvr_id,
  };
  // The file covers EXACTLY what was asked for: the M-NVR stores whole segments, so the stitched segments usually begin a little before the
  // requested start (and end after the requested end); that surplus is cut off below. from/to = the request clipped to what the unit recorded.
  const segFirst = cov.segments.length
    ? new Date(cov.segments[0].start_time)
    : new Date(r.window_start);
  const segLast = cov.segments.length
    ? new Date(cov.segments[cov.segments.length - 1].end_time)
    : new Date(r.window_end);
  const from = new Date(
    Math.max(new Date(r.window_start).getTime(), segFirst.getTime()),
  );
  const to = new Date(
    Math.min(new Date(r.window_end).getTime(), segLast.getTime()),
  );
  const first = from;
  const last = to;
  const rel = naming.footagePath(
    r.zone_id,
    r.train_request_id ? `TR${r.train_request_id}` : `REQ${r.id}`,
    ident,
    first,
    last,
  );
  const fileName = naming.footageFile(ident, first, last);
  const out = absPath(rel);
  const files = cov.segments.map((s) => absPath(s.object_key));
  const missing = files.filter((f) => !exists(f));
  if (missing.length)
    return fail(
      r,
      "failed",
      "segment files are missing from the footage store",
    );
  // Nothing is delivered on trust: every segment is re-verified against the SHA-256 the unit declared for it, then the
  // stitched file must be as long as the segments it was built from.
  for (const s of cov.segments) {
    const f = absPath(s.object_key);
    if (
      fs.statSync(f).size !== Number(s.size_bytes) ||
      (s.sha256 && (await sha256File(f)) !== s.sha256)
    ) {
      // discard the damaged copy so the unit uploads it again next time
      fs.rmSync(f, { force: true });
      await pool.query(
        `UPDATE video_segment SET upload_status = 'failed' WHERE id = $1`,
        [s.id],
      );
      await pool.query(
        `UPDATE upload_session SET bytes_received = 0, last_chunk_index = -1, updated_at = now() WHERE segment_id = $1`,
        [s.id],
      );
      return fail(
        r,
        "failed",
        `integrity check failed for a stored segment (${s.object_key}) - the damaged copy was discarded; request the footage again and the unit will send it afresh`,
      );
    }
  }

  const full = `${out}.full`;
  await stitch(files, full);
  const fullDuration = await probeDuration(full);
  const expected = cov.segments.reduce(
    (n, s) => n + (new Date(s.end_time) - new Date(s.start_time)) / 1000,
    0,
  );
  if (fullDuration != null && expected > 0 && fullDuration < expected * 0.95) {
    fs.rmSync(full, { force: true });
    return fail(
      r,
      "failed",
      `delivered file is shorter than its segments (${Math.round(fullDuration)} s of ${Math.round(expected)} s) - integrity check failed`,
    );
  }
  // Trim to the requested window without re-encoding (the recorded watermark/metadata stays intact). A stream copy starts at the nearest earlier
  // keyframe, so the first frame can precede the requested start by at most one keyframe interval (seconds, not minutes).
  const headTrim = (from.getTime() - segFirst.getTime()) / 1000;
  const tailTrim = (segLast.getTime() - to.getTime()) / 1000;
  if (
    cov.segments.length &&
    fullDuration != null &&
    (headTrim > 0.5 || tailTrim > 0.5)
  ) {
    try {
      await cutClip(
        full,
        out,
        headTrim,
        Math.max(headTrim + 0.5, fullDuration - tailTrim),
      );
      fs.rmSync(full, { force: true });
    } catch (e) {
      console.warn(
        `request #${r.id}: could not trim to the requested window (${e.message}); delivering the whole segments`,
      );
      fs.renameSync(full, out);
    }
  } else fs.renameSync(full, out);
  const sha = await sha256File(out);
  const size = fs.statSync(out).size;
  const duration = await probeDuration(out);
  const start = from;
  const end = to;

  await withTransaction(async (client) => {
    const cur = await loadRequest(client, r.id, { lock: true });
    if (!cur || !OPEN.includes(cur.status)) return; // cancelled / delivered meanwhile
    const { rows } = await client.query(
      `INSERT INTO delivered_footage (video_request_id, storage_path, format, sha256, file_size_bytes, start_time, end_time, duration_s, segment_count,
                                      train_request_id, train_no, nvr_id, unit_no, camera_id, camera_no, file_name)
       VALUES ($1,$2,'MP4',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
        r.id,
        rel,
        sha,
        size,
        start,
        end,
        duration,
        files.length,
        r.train_request_id || null,
        r.train_no || null,
        r.nvr_id,
        r.unit_no || null,
        r.camera_id,
        r.camera_no || null,
        fileName,
      ],
    );
    const gapNote =
      partial && cov.gaps.length
        ? `partial delivery - the NVR has no recording for ${cov.gaps.length} part(s) of the window`
        : null;
    await client.query(
      `UPDATE video_request SET status='fulfilled', fulfilled_at=now(), decision_note = CASE WHEN $2::text IS NULL THEN decision_note ELSE concat_ws(' | ', decision_note, $2::text) END WHERE id=$1`,
      [r.id, gapNote],
    );
    await client.query(
      `UPDATE nvr_command SET status='cancelled', completed_at=now() WHERE request_id=$1 AND status IN ('queued','sent','acked')`,
      [r.id],
    );
    await audit(client, {
      user: null,
      action: "request.fulfil",
      entity: "video_request",
      entityId: r.id,
      zoneId: r.zone_id,
      details: {
        footage_id: rows[0].id,
        file_name: fileName,
        segments: files.length,
        size,
        sha256: sha,
        partial,
        train_request_id: r.train_request_id || undefined,
      },
    });
    if (!r.train_request_id)
      await notify.send(client, {
        zone_id: r.zone_id,
        post_id: r.post_id,
        kind: "footage",
        ref_entity: "delivered_footage",
        ref_id: rows[0].id,
        title: `Footage ready for request #${r.id}`,
        body: `${r.camera_name} / ${r.nvr_name}${gapNote ? " - " + gapNote : ""}`,
      });
  });
  await refreshParent(r);
}

async function fail(r, status, reason) {
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE video_request SET status=$2, failure_reason=$3 WHERE id=$1 AND status = ANY($4)`,
      [r.id, status, reason, OPEN],
    );
    if (!rowCount) return;
    await client.query(
      `UPDATE nvr_command SET status='cancelled', completed_at=now() WHERE request_id=$1 AND status IN ('queued','sent','acked')`,
      [r.id],
    );
    await audit(client, {
      user: null,
      action: `request.${status}`,
      entity: "video_request",
      entityId: r.id,
      zoneId: r.zone_id,
      details: { reason },
    });
    if (!r.train_request_id)
      await notify.send(client, {
        zone_id: r.zone_id,
        post_id: r.post_id,
        kind: "request",
        ref_entity: "video_request",
        ref_id: r.id,
        title: `Request #${r.id} ${status === "expired" ? "expired" : "failed"}`,
        body: reason,
      });
  });
  await refreshParent(r);
}

/** A segment landed: any request waiting on this camera/time may now be complete. */
async function onSegmentComplete(cameraId, start, end) {
  const { rows } = await pool.query(
    `SELECT id FROM video_request WHERE camera_id = $1 AND status = 'awaiting_upload' AND window_start < $3 AND window_end > $2`,
    [cameraId, start, end],
  );
  for (const { id } of rows) await processRequest(id);
}

/** Operator pressed "deliver what we have" / "retry". */
async function forceDeliver(user, id) {
  const r = await loadRequest(null, id);
  if (!r || !canSeeZone(user, r.zone_id)) throw notFound("request not found");
  if (!OPEN.includes(r.status) && r.status !== "failed")
    throw conflict(`request is '${r.status}'`);
  const cov = await coverage(r.camera_id, r.window_start, r.window_end);
  if (!cov.segments.length)
    throw badRequest("no footage for this window has been uploaded yet");
  if (r.status === "failed")
    await pool.query(
      `UPDATE video_request SET status='awaiting_upload', failure_reason=NULL WHERE id=$1`,
      [id],
    );
  await audit(null, {
    user,
    action: "request.force_deliver",
    entity: "video_request",
    entityId: id,
    zoneId: r.zone_id,
    details: { gaps: cov.gaps.length },
  });
  await deliver({ ...r, status: "awaiting_upload" }, cov, !cov.covered);
  return loadRequest(null, id);
}

/** Re-issue (or issue) the upload-now command for a waiting request. */
async function reissueUpload(user, id) {
  const r = await loadRequest(null, id);
  if (!r || !canSeeZone(user, r.zone_id)) throw notFound("request not found");
  if (!["awaiting_upload", "approved", "amended", "failed"].includes(r.status))
    throw conflict(`request is '${r.status}'`);
  await pool.query(
    `UPDATE nvr_command SET status='cancelled', completed_at=now() WHERE request_id=$1 AND status IN ('queued','sent','acked')`,
    [id],
  );
  await pool.query(
    `UPDATE video_request SET status = CASE WHEN status='failed' THEN 'approved'::request_status ELSE status END, failure_reason=NULL WHERE id=$1`,
    [id],
  );
  await audit(null, {
    user,
    action: "request.reissue_upload",
    entity: "video_request",
    entityId: id,
    zoneId: r.zone_id,
  });
  await processRequest(id);
  return loadRequest(null, id);
}

/** Operator withdraws an open request (e.g. duplicate). */
async function operatorCancel(user, id, note) {
  await withTransaction(async (client) => {
    const r = await loadRequest(client, id, { lock: true });
    if (!r || !canSeeZone(user, r.zone_id)) throw notFound("request not found");
    if (!["submitted", ...OPEN].includes(r.status))
      throw conflict(`request is '${r.status}'`);
    await client.query(
      `UPDATE video_request SET status='cancelled', decision_note = concat_ws(' | ', decision_note, $2::text) WHERE id=$1`,
      [id, `cancelled by operator${note ? ": " + note : ""}`],
    );
    await client.query(
      `UPDATE nvr_command SET status='cancelled', completed_at=now() WHERE request_id=$1 AND status IN ('queued','sent','acked')`,
      [id],
    );
    await audit(client, {
      user,
      action: "request.cancel",
      entity: "video_request",
      entityId: id,
      zoneId: r.zone_id,
      details: { note },
    });
    if (!r.train_request_id)
      await notify.send(client, {
        zone_id: r.zone_id,
        post_id: r.post_id,
        kind: "request",
        ref_entity: "video_request",
        ref_id: id,
        title: `Request #${id} was cancelled by CMS`,
        body: note || null,
      });
  });
  await refreshParent(await loadRequest(null, id));
  return loadRequest(null, id);
}

/** Worker tick: auto-approve (if enabled), retry open requests, drop orphaned commands. */
async function processOpen() {
  let n = 0;
  if (await settings.get("auto_approve_requests")) {
    const sys = {
      id: await getSystemUserId(),
      zone_id: null,
      role: "super_admin",
    };
    const { rows } = await pool.query(
      `SELECT id FROM video_request WHERE status = 'submitted' AND created_at < now() - interval '3 seconds' ORDER BY id`,
    );
    for (const { id } of rows) {
      try {
        await decide(sys, id, "approve", {
          note: "auto-approved (CMS setting)",
        });
        n++;
      } catch (e) {
        console.warn(`auto-approve #${id}:`, e.message);
      }
    }
  }
  const { rows } = await pool.query(
    `SELECT id FROM video_request WHERE status = ANY($1) ORDER BY id`,
    [OPEN],
  );
  for (const { id } of rows) {
    try {
      await processRequest(id);
      n++;
    } catch (e) {
      console.error(`request #${id}:`, e.message);
    }
  }
  n += await trainSvc().processOpen();
  await pool.query(
    `UPDATE nvr_command c SET status='cancelled', completed_at=now()
      WHERE c.status IN ('queued','sent','acked') AND c.request_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM video_request r WHERE r.id = c.request_id AND r.status NOT IN ('approved','amended','awaiting_upload','submitted'))`,
  );
  return `${n} request(s) processed`;
}

module.exports = {
  REQUEST_SELECT,
  OPEN,
  loadRequest,
  decide,
  processRequest,
  processOpen,
  onSegmentComplete,
  forceDeliver,
  reissueUpload,
  operatorCancel,
  issueUploadCommand,
};
