/**
 * The naming convention for everything recorded on a train - ONE place, used for segment storage, delivered footage and
 * what the M-NVR bridge is told, so a file name always says where it came from.
 *
 *   <TRAIN>_M<nn>_C<nn>_<start>[_<end>].mp4
 *
 *   TRAIN  train number, upper-case, anything but A-Z 0-9 turned into '-'      12301 Rajdhani -> 12301-RAJDHANI
 *   M<nn>  M-NVR unit number inside the train (nvr_unit.unit_no), >= 2 digits  M02
 *   C<nn>  camera number inside that unit (camera.camera_no), >= 2 digits      C03
 *   start  UTC, yyyymmddThhmmssZ   (end likewise, delivered files only)
 *
 *   one stored segment    segments/train-<TRAIN>/mnvr-<nn>/cam-<nn>/<TRAIN>_M<nn>_C<nn>_<start>.mp4
 *   one delivered file    zone-<zone>/train-<TRAIN>/TR<train request id>/<TRAIN>_M<nn>_C<nn>_<start>_<end>.mp4
 *
 * A unit that has no train number yet is named NVR<id> instead of the train token, so nothing is ever unnamed.
 */
const pad = (n, w = 2) => String(Math.max(0, Number(n) || 0)).padStart(w, '0');

function trainToken(trainNo, nvrId) {
  const t = String(trainNo || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return t || `NVR${nvrId == null ? 'X' : nvrId}`;
}

/** 2026-10-29T10:15:00.000Z -> 20261029T101500Z */
const stamp = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');

/** id = { trainNo, unitNo, cameraNo, nvrId } */
function base(id) { return `${trainToken(id.trainNo, id.nvrId)}_M${pad(id.unitNo)}_C${pad(id.cameraNo)}`; }

const segmentFile = (id, start) => `${base(id)}_${stamp(start)}.mp4`;
const footageFile = (id, start, end) => `${base(id)}_${stamp(start)}_${stamp(end)}.mp4`;

const segmentKey = (id, start) =>
  `segments/train-${trainToken(id.trainNo, id.nvrId)}/mnvr-${pad(id.unitNo)}/cam-${pad(id.cameraNo)}/${segmentFile(id, start)}`;

// tag = 'TR<train request id>' for footage of a train request, 'REQ<request id>' for a single-camera request
const footagePath = (zoneId, tag, id, start, end) =>
  `zone-${zoneId}/train-${trainToken(id.trainNo, id.nvrId)}/${tag}/${footageFile(id, start, end)}`;

module.exports = { pad, trainToken, stamp, base, segmentFile, footageFile, segmentKey, footagePath };
