/**
 * Footage upload: M-NVR recorded segment -> CMS (catalogue entry, resumable chunks, SHA-256 verified).
 * One M-NVR segment file == one CMS segment; CMS stitches them into one MP4 without re-encoding.
 */
const fs = require("fs");
const cms = require("./cmsClient");
const mnvr = require("./mnvrDb");
const cameras = require("./cameraMap");
const config = require("./config");
const crypto = require("crypto");
const { retryOnLinkLoss } = require("./resilient");
const log = require("./log")("upload");
const { sleep, iso, sha256File, gaps, KeyedMutex } = require("./util");

const mutex = new KeyedMutex();
const stop = (p) => {
  const c = p && p.isCancelled && p.isCancelled();
  if (c)
    throw Object.assign(new Error(`stopped: ${c.why || "cancelled"}`), {
      cancelled: true,
      permanent: true,
    });
};
const stats = { segments_uploaded: 0, bytes_uploaded: 0, last_upload_at: null };

async function throttle(bytes, startedAt) {
  if (!config.uploadMaxKbps) return;
  const minMs = ((bytes * 8) / (config.uploadMaxKbps * 1000)) * 1000;
  const spent = Date.now() - startedAt;
  if (spent < minMs) await sleep(minMs - spent);
}

/**
 * Send one segment. Returns 'uploaded' | 'already'.
 * Fault tolerant: whenever a request fails and it is not certain whether CMS stored the chunk (the reply may be what
 * was lost), CMS is asked how many bytes it holds and the transfer continues from exactly there - never from zero,
 * never with a gap or a repeat. Each chunk carries its own SHA-256 (CMS refuses damaged ones, we resend), and the
 * whole segment is verified again by SHA-256 when complete.
 */
async function uploadSegment(cmsCameraId, seg, progress) {
  return mutex.run(`${cmsCameraId}|${seg.start}`, async () => {
    const label = seg.file_name;
    const link = (fn) => retryOnLinkLoss(label, progress, fn);
    for (let attempt = 1; attempt <= 3; attempt++) {
      let st;
      try {
        st = fs.statSync(seg.file_path);
      } catch (e) {
        throw Object.assign(
          new Error(`segment file missing on the M-NVR: ${seg.file_name}`),
          { permanent: true },
        );
      }
      if (!st.size)
        throw Object.assign(
          new Error(`segment file is empty: ${seg.file_name}`),
          { permanent: true },
        );
      const sha = await sha256File(seg.file_path, st);

      const reg = await link(() =>
        cms.call("POST", "/segments", {
          json: {
            camera_id: cmsCameraId,
            start_time: iso(seg.start),
            end_time: iso(seg.end),
            size_bytes: st.size,
            sha256: sha,
            // who this recording belongs to (train no., M-NVR no., camera no.) and where it came from on this unit: CMS checks the
            // identity against its registry and files the segment as <TRAIN>_M<nn>_C<nn>_<start>.mp4
            ...cameras.identityOf(cmsCameraId),
            source_file_name: seg.file_name,
            mnvr_recording_id: seg.recording_id,
            ...(seg.gps_latitude != null && seg.gps_longitude != null
              ? { start_lat: seg.gps_latitude, start_lon: seg.gps_longitude }
              : {}),
          },
        }),
      );
      if (reg.upload_status === "complete") {
        progress && progress.add(st.size);
        return "already";
      }

      let offset = reg.bytes_received || 0;
      let index =
        (reg.last_chunk_index == null ? -1 : reg.last_chunk_index) + 1;
      let sentHere = offset;
      progress && progress.add(offset); // a resumed segment counts what CMS already holds
      const resync = async () => {
        // authoritative position from CMS
        const s = await link(() => cms.call("GET", `/segments/${reg.id}`));
        const was = offset;
        offset =
          s.upload_status === "complete" ? st.size : s.bytes_received || 0;
        index = (s.last_chunk_index == null ? -1 : s.last_chunk_index) + 1;
        progress && progress.add(offset - was);
        sentHere += offset - was;
      };

      const fd = fs.openSync(seg.file_path, "r");
      try {
        let damaged = 0;
        let refused = 0;
        while (offset < st.size) {
          stop(progress);
          const len = Math.min(config.chunkBytes, st.size - offset);
          const buf = Buffer.allocUnsafe(len);
          fs.readSync(fd, buf, 0, len, offset);
          const chunkSha = crypto
            .createHash("sha256")
            .update(buf)
            .digest("hex");
          const t0 = Date.now();
          try {
            await cms.call("PUT", `/segments/${reg.id}/chunks/${index}`, {
              raw: buf,
              headers: { "X-Chunk-SHA256": chunkSha },
              timeoutMs: 60000,
            });
            refused = 0;
            offset += len;
            index++;
            stats.bytes_uploaded += len;
            sentHere += len;
            progress && progress.add(len);
            await throttle(len, t0);
          } catch (e) {
            if (
              e.status === 422 &&
              /damaged in transit/.test(e.message) &&
              ++damaged <= 8
            )
              continue; // resend the same chunk
            if (e.status === 409 || cms.isTransient(e)) {
              // unsure whether it landed: ask CMS
              stop(progress);
              if (!e.network) {
                // CMS answered and still refuses: do not spin forever
                if (++refused > 8)
                  throw Object.assign(
                    new Error(
                      `CMS keeps refusing chunk ${index} of ${seg.file_name}: ${e.message}`,
                    ),
                    { permanent: true },
                  );
                await sleep(Math.min(15000, 500 * 2 ** refused));
              }
              await resync();
              continue;
            }
            throw e;
          }
        }
      } finally {
        fs.closeSync(fd);
      }

      try {
        await link(() => cms.call("POST", `/segments/${reg.id}/complete`));
      } catch (e) {
        if (e.status === 409) continue; // CMS says bytes are still missing: register again and continue from its position
        if (e.status === 422 && attempt === 1) {
          log.warn(
            `${seg.file_name}: CMS reports a checksum mismatch - sending it again from the start`,
          );
          progress && progress.add(-sentHere);
          continue;
        }
        throw e;
      }
      stats.segments_uploaded++;
      stats.last_upload_at = new Date().toISOString();
      return "uploaded";
    }
    throw new Error(
      `could not upload ${seg.file_name}: it kept failing verification`,
    );
  });
}

/**
 * Wait (bounded) for the segment that is being recorded right now, so a window that reaches "now" includes
 * everything up to the last finished segment instead of stopping short.
 */
async function waitForOpenSegment(mnvrCam, target, label, progress) {
  const segLen = await mnvr.segmentLengthS();
  const deadline = Date.now() + (segLen + config.openSegmentExtraWaitS) * 1000;
  let waited = false;
  for (;;) {
    const last = await mnvr.latestSegmentEnd(mnvrCam);
    if (last == null) return; // never recorded: nothing to wait for
    if (last >= target - 1500) return; // everything up to the target is finished
    if (Date.now() - last > (segLen * 2 + 90) * 1000) return; // camera is not recording right now: do not wait
    if (Date.now() > deadline) {
      log.warn(
        `${label}: the segment being recorded did not finish in time; sending what is finished`,
      );
      return;
    }
    if (!waited) {
      progress &&
        progress.set({
          status: "waiting_for_recording",
          message:
            "window reaches the segment still being recorded - waiting for it to finish",
        });
      log.info(
        `${label}: window reaches the segment still being recorded - waiting for it to finish (up to ${segLen + config.openSegmentExtraWaitS}s)`,
      );
      waited = true;
    }
    stop(progress);
    await sleep(3000);
  }
}

/**
 * Upload everything the M-NVR has for [from, to] (ms) on one camera.
 * Returns { uploaded, already, missing:[{from,to}] }.
 */
async function uploadWindow(cmsCameraId, from, to, label, progress) {
  const mnvrCam = cameras.toMnvr(cmsCameraId);
  if (mnvrCam == null)
    throw Object.assign(
      new Error(`CMS camera ${cmsCameraId} is not mapped to any M-NVR camera`),
      { permanent: true },
    );
  await mnvr.calibrate().catch(() => {}); // the recorder's clock vs this PC's (usually identical)
  await waitForOpenSegment(mnvrCam, Math.min(to, Date.now()), label, progress);
  progress &&
    progress.set({
      status: "preparing",
      message: "finding the recorded segments",
    });
  let segs = await mnvr.segmentsFor(mnvrCam, from, to);
  if (!segs.length) {
    const before = mnvr.clockDelta();
    if ((await mnvr.calibrate(true).catch(() => before)) !== before)
      segs = await mnvr.segmentsFor(mnvrCam, from, to);
  } // maybe only the clock was off
  // files in the camera's folder that the M-NVR's database does not list yet (its indexer lags, stopped, or restarted)
  const disk = await mnvr
    .diskSegments(mnvrCam, from, Math.min(to, Date.now()))
    .catch(() => ({ files: [], newest: null, dir: null }));
  const known = new Set(segs.map((s) => s.file_path));
  const extra = disk.files.filter((f) => !known.has(f.file_path));
  for (const f of extra) {
    try {
      const g = await mnvr.gpsNear(f.start, 120);
      if (g) {
        f.gps_latitude = g.latitude;
        f.gps_longitude = g.longitude;
      }
    } catch (_) {
      /* no location */
    }
  }
  segs = segs.concat(extra).sort((a, b) => a.start - b.start);
  const present = segs.filter((s) => fs.existsSync(s.file_path));
  const absent = segs.filter((s) => !fs.existsSync(s.file_path));
  // every time in a note is shown in Indian Standard Time (config.displayTzMin), whatever zone the PCs run in
  const L = (t) =>
    new Date(t + config.displayTzMin * 60000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19) + (config.displayTzMin === 330 ? " IST" : "");
  let note = null;
  if (absent.length && !present.length)
    throw Object.assign(
      new Error(
        `the M-NVR lists ${absent.length} recording(s) for this window, but their files are not on this PC (for example ${absent[0].file_path}) - is the recordings folder moved or on another drive?`,
      ),
      { permanent: true },
    );
  if (absent.length)
    note = `${absent.length} of ${segs.length} recording file(s) for this window are missing on the M-NVR's disk`;
  if (extra.length) {
    note = `${extra.length} recording file(s) were in the recordings folder but not yet in the M-NVR's recording index - sent anyway${note ? `; ${note}` : ""}`;
    log.warn(`${label}: ${note}`);
  }
  if (!segs.length) {
    // say WHY there is nothing, so nobody has to guess
    try {
      const x = await mnvr.explain(mnvrCam, from, Math.min(to, Date.now()));
      const other = x.inWindow.filter(
        (w) => !["COMPLETED", "EXPORTED", "ARCHIVED"].includes(w.status),
      );
      if (!x.total)
        note =
          "the M-NVR has no recordings at all for this camera (is recording switched on for it?)";
      else if (other.length)
        note = `the M-NVR has ${other.map((w) => `${w.n} recording(s) marked ${w.status}`).join(", ")} in this window, but only finished (COMPLETED) recordings can be sent`;
      else {
        const gap =
          x.prev && x.next
            ? `there is no recording between ${L(x.prev)} and ${L(x.next)}`
            : x.prev
              ? `nothing was recorded after ${L(x.prev)}`
              : x.next
                ? `nothing was recorded before ${L(x.next)}`
                : `its recordings are ${L(x.first)} to ${L(x.last)}`;
        note = `no recording for this camera between ${L(from)} and ${L(Math.min(to, Date.now()))}: ${gap}. The M-NVR was not recording then (switched off, recorder stopped, or the camera offline)`;
      }
      if (!x.total || !other.length)
        note += disk.newest
          ? `. The newest file in its recordings folder starts ${L(disk.newest.start)} (${disk.newest.file_name})`
          : disk.dir
            ? `. Its recordings folder (${disk.dir}) holds no usable segment file`
            : "";
    } catch (_) {
      note = "the M-NVR has no recording for this camera in that window";
    }
    log.warn(`${label}: ${note}`);
  }
  const total = present.reduce((n, s) => {
    try {
      return n + fs.statSync(s.file_path).size;
    } catch (_) {
      return n;
    }
  }, 0);
  progress &&
    progress.set({
      status: "uploading",
      message: null,
      segments_total: present.length,
      segments_done: 0,
      bytes_total: total,
    });
  let uploaded = 0;
  let already = 0;
  for (const s of present) {
    stop(progress);
    progress && progress.set({ current_file: s.file_name });
    const r = await uploadSegment(cmsCameraId, s, progress);
    if (r === "uploaded") uploaded++;
    else already++;
    progress && progress.set({ segments_done: uploaded + already });
  }
  const missing = gaps(
    present.map((s) => [s.start, s.end]),
    from,
    Math.min(to, Date.now()),
  ).map(([a, b]) => ({ from: iso(a), to: iso(b) }));
  log.info(
    `${label}: ${present.length} segment(s) in window (${uploaded} sent, ${already} already at CMS)${missing.length ? `, ${missing.length} gap(s)` : ""}`,
  );
  return { uploaded, already, missing, note };
}

module.exports = { uploadWindow, uploadSegment, stats };
