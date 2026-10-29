const fs = require('fs');
const crypto = require('crypto');
const { pool, withTransaction } = require('../db');
const { badRequest, notFound, conflict, HttpError } = require('../errors');
const { absPath, ensureDir, sha256File } = require('./fsutil');
const { zoneAt } = require('./alertService');

const TOL_MS = 1500; // tolerated gap between neighbouring segments

const keyFor = (zone, nvr, cam, start) =>
  `segments/zone-${zone}/nvr-${nvr}/cam-${cam}/${new Date(start).toISOString().replace(/[:.]/g, '-')}.mp4`;

// One chunk at a time per segment (the NVR retries; two parallel appends would corrupt the file).
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}

/** Catalogue entry for a segment the NVR is about to upload. Idempotent on (camera, start). */
async function registerSegment(nvr, b) {
  const cameraId = Number(b.camera_id);
  const start = new Date(b.start_time); const end = new Date(b.end_time);
  if (!Number.isInteger(cameraId)) throw badRequest('camera_id is required');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw badRequest('start_time/end_time are invalid');
  const size = Number(b.size_bytes);
  if (!Number.isInteger(size) || size <= 0) throw badRequest('size_bytes must be a positive integer');
  if (!/^[0-9a-f]{64}$/.test(String(b.sha256 || ''))) throw badRequest('sha256 must be 64 hex characters');
  const { rows: cam } = await pool.query('SELECT id FROM camera WHERE id = $1 AND nvr_id = $2', [cameraId, nvr.id]);
  if (!cam.length) throw badRequest(`camera ${cameraId} does not belong to this NVR`);
  const zoneId = await zoneAt(nvr.id, start);

  return withTransaction(async (client) => {
    const { rows: ex } = await client.query(
      `SELECT s.id, s.upload_status, s.sha256, u.bytes_received, u.last_chunk_index
         FROM video_segment s LEFT JOIN upload_session u ON u.segment_id = s.id
        WHERE s.camera_id = $1 AND s.start_time = $2 FOR UPDATE OF s`, [cameraId, start]);
    if (ex.length) {
      const s = ex[0];
      if (s.upload_status === 'complete') return { id: s.id, upload_status: 'complete', bytes_received: s.bytes_received || size, last_chunk_index: s.last_chunk_index, duplicate: true };
      if (s.upload_status === 'failed' || s.sha256 !== b.sha256) { // re-upload from scratch
        await client.query(`UPDATE video_segment SET upload_status='pending', size_bytes=$2, sha256=$3, end_time=$4 WHERE id=$1`, [s.id, size, b.sha256, end]);
        await client.query(`UPDATE upload_session SET bytes_received=0, total_bytes=$2, last_chunk_index=-1, updated_at=now() WHERE segment_id=$1`, [s.id, size]);
        fs.rmSync(absPath(keyFor(zoneId, nvr.id, cameraId, start) + '.part'), { force: true });
        return { id: s.id, upload_status: 'pending', bytes_received: 0, last_chunk_index: -1 };
      }
      return { id: s.id, upload_status: s.upload_status, bytes_received: s.bytes_received || 0, last_chunk_index: s.last_chunk_index == null ? -1 : s.last_chunk_index };
    }
    const point = (lat, lon) => (lat != null && lon != null ? [Number(lon), Number(lat)] : null);
    const sp = point(b.start_lat, b.start_lon); const ep = point(b.end_lat, b.end_lon);
    const { rows } = await client.query(
      `INSERT INTO video_segment (nvr_id, camera_id, zone_id, start_time, end_time, storage_region, object_key, size_bytes, sha256, upload_status, start_location, end_location)
       VALUES ($1,$2,$3,$4,$5,'local',$6,$7,$8,'pending',
               CASE WHEN $9::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($9,$10),4326)::geography END,
               CASE WHEN $11::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($11,$12),4326)::geography END)
       RETURNING id`,
      [nvr.id, cameraId, zoneId, start, end, keyFor(zoneId, nvr.id, cameraId, start), size, b.sha256,
        sp && sp[0], sp && sp[1], ep && ep[0], ep && ep[1]]);
    await client.query(`INSERT INTO upload_session (segment_id, total_bytes, bytes_received, last_chunk_index) VALUES ($1,$2,0,-1)`, [rows[0].id, size]);
    return { id: rows[0].id, upload_status: 'pending', bytes_received: 0, last_chunk_index: -1 };
  });
}

async function loadOwned(nvr, id) {
  const { rows } = await pool.query(
    `SELECT s.id, s.nvr_id, s.camera_id, s.start_time, s.end_time, s.object_key, s.size_bytes, s.sha256, s.upload_status,
            u.bytes_received, u.last_chunk_index
       FROM video_segment s JOIN upload_session u ON u.segment_id = s.id WHERE s.id = $1 AND s.nvr_id = $2`, [id, nvr.id]);
  if (!rows.length) throw notFound('segment not found');
  return rows[0];
}

/** Chunks must arrive in order; re-sending the last stored chunk is harmless (resume after a drop). */
function uploadChunk(nvr, id, index, buf, chunkSha256) {
  return withLock(`seg-${id}`, async () => {
    const s = await loadOwned(nvr, id);
    if (s.upload_status === 'complete') return { upload_status: 'complete', bytes_received: s.bytes_received, last_chunk_index: s.last_chunk_index };
    if (!Number.isInteger(index) || index < 0) throw badRequest('chunk index must be a non-negative integer');
    if (!buf || !buf.length) throw badRequest('empty chunk');
    // End-to-end check of this chunk: the unit sends the SHA-256 of what it sent; anything damaged in transit is refused
    // here (422) and simply sent again, long before the whole segment is hashed.
    if (chunkSha256 && crypto.createHash('sha256').update(buf).digest('hex') !== String(chunkSha256).toLowerCase()) {
      throw new HttpError(422, `chunk ${index} was damaged in transit (checksum mismatch) - send it again`);
    }
    if (index === s.last_chunk_index) return { upload_status: s.upload_status, bytes_received: s.bytes_received, last_chunk_index: s.last_chunk_index, duplicate: true };
    if (index !== s.last_chunk_index + 1) throw new HttpError(409, `expected chunk ${s.last_chunk_index + 1}, got ${index} (bytes_received=${s.bytes_received})`);
    if (s.bytes_received + buf.length > s.size_bytes) throw badRequest('chunk exceeds the declared segment size');

    const part = absPath(s.object_key + '.part');
    ensureDir(part);
    // If the process died between append and DB update, the part file is longer than recorded: trim it back.
    if (fs.existsSync(part) && fs.statSync(part).size !== s.bytes_received) fs.truncateSync(part, s.bytes_received);
    fs.appendFileSync(part, buf);
    const { rows } = await pool.query(
      `UPDATE upload_session SET bytes_received = bytes_received + $2, last_chunk_index = $3, updated_at = now() WHERE segment_id = $1 RETURNING bytes_received, last_chunk_index`,
      [id, buf.length, index]);
    await pool.query(`UPDATE video_segment SET upload_status = 'partial' WHERE id = $1 AND upload_status = 'pending'`, [id]);
    return { upload_status: 'partial', ...rows[0] };
  });
}

/** All bytes in: verify size + SHA-256, move into place, mark complete, and wake any waiting requests. */
async function completeSegment(nvr, id) {
  const result = await withLock(`seg-${id}`, async () => {
    const s = await loadOwned(nvr, id);
    if (s.upload_status === 'complete') return { upload_status: 'complete', segment: s };
    const part = absPath(s.object_key + '.part');
    if (!fs.existsSync(part)) throw badRequest('nothing uploaded for this segment');
    const size = fs.statSync(part).size;
    if (size !== s.size_bytes) throw new HttpError(409, `incomplete: have ${size} of ${s.size_bytes} bytes`);
    const actual = await sha256File(part);
    if (actual !== s.sha256) {
      fs.rmSync(part, { force: true });
      await pool.query(`UPDATE video_segment SET upload_status = 'failed' WHERE id = $1`, [id]);
      await pool.query(`UPDATE upload_session SET bytes_received = 0, last_chunk_index = -1, updated_at = now() WHERE segment_id = $1`, [id]);
      throw new HttpError(422, 'SHA-256 mismatch - segment discarded, upload it again');
    }
    const final = absPath(s.object_key);
    fs.renameSync(part, final);
    await pool.query(`UPDATE video_segment SET upload_status = 'complete', uploaded_at = now() WHERE id = $1`, [id]);
    return { upload_status: 'complete', segment: s };
  });
  // wake requests waiting for this footage (lazy require: requestService depends on this module)
  require('./requestService').onSegmentComplete(result.segment.camera_id, result.segment.start_time, result.segment.end_time)
    .catch((e) => console.error('request wake-up failed:', e.message));
  return { upload_status: 'complete' };
}

/** What the catalogue holds for a camera over [from, to]: complete segments, pending ones, and the gaps. */
async function coverage(cameraId, from, to) {
  const { rows } = await pool.query(
    `SELECT id, start_time, end_time, size_bytes, sha256, object_key, upload_status
       FROM video_segment WHERE camera_id = $1 AND start_time < $3 AND end_time > $2 ORDER BY start_time`, [cameraId, from, to]);
  const done = rows.filter((r) => r.upload_status === 'complete');
  const gaps = [];
  let cursor = new Date(from).getTime();
  const end = new Date(to).getTime();
  for (const s of done) {
    const st = new Date(s.start_time).getTime();
    if (st - cursor > TOL_MS) gaps.push({ from: new Date(cursor), to: new Date(st) });
    cursor = Math.max(cursor, new Date(s.end_time).getTime());
  }
  if (end - cursor > TOL_MS) gaps.push({ from: new Date(cursor), to: new Date(end) });
  return { segments: done, pending: rows.filter((r) => r.upload_status !== 'complete'), gaps, covered: gaps.length === 0 && done.length > 0 };
}

module.exports = { registerSegment, uploadChunk, completeSegment, coverage, keyFor, loadOwned };
