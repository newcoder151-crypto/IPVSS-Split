/**
 * Which CMS camera is which M-NVR camera.  Order of precedence:
 *   1. CAMERA_MAP in the settings ("mnvrId:cmsId,...")
 *   2. the CMS camera's mnvr_camera_id = the M-NVR's camera id (set from the M-NVR itself when the bridge connects)
 *   3. same name (case/space/-/_ insensitive)  - provision.js registers CMS cameras under the M-NVR names
 * Cameras that cannot be matched are reported at start-up; alerts for them are sent without a camera,
 * and footage requests for them fail with a clear message.
 */
const config = require('./config');
const log = require('./log')('cameras');

const norm = (s) => String(s || '').toLowerCase().replace(/[\s_\-]+/g, '');
let toCmsMap = new Map(); let toMnvrMap = new Map(); let cmsNames = new Map(); let cmsNos = new Map(); let unit = { train_no: null, unit_no: null };

function build(cmsCams, mnvrCams, me) {
  if (me) unit = { train_no: me.train_no || null, unit_no: me.unit_no == null ? null : Number(me.unit_no) };
  cmsNos = new Map(cmsCams.map((c) => [Number(c.id), c.camera_no == null ? null : Number(c.camera_no)]));
  const t = new Map(); const r = new Map();
  const cmsById = new Map(cmsCams.map((c) => [Number(c.id), c]));
  for (const m of mnvrCams) {
    let cms = null;
    if (config.cameraMap.has(m.camera_id)) cms = cmsById.get(config.cameraMap.get(m.camera_id)) || null;
    if (!cms) cms = cmsCams.find((c) => c.mnvr_camera_id != null && Number(c.mnvr_camera_id) === Number(m.camera_id)) || null;   // the CMS row carries the M-NVR's own camera id
    if (!cms) cms = cmsCams.find((c) => norm(c.name) === norm(m.camera_name)) || null;
    if (cms && !r.has(Number(cms.id))) { t.set(m.camera_id, Number(cms.id)); r.set(Number(cms.id), m.camera_id); }
  }
  const un = mnvrCams.filter((m) => !t.has(m.camera_id)).map((m) => `${m.camera_id}:${m.camera_name}`);
  const unCms = cmsCams.filter((c) => !r.has(Number(c.id))).map((c) => `${c.id}:${c.name}`);
  if (JSON.stringify([...t]) !== JSON.stringify([...toCmsMap])) {
    log.info(`camera mapping (mNVR -> CMS): ${[...t].map(([a, b]) => `${a}->${b}`).join(', ') || 'none'}`);
    if (un.length) log.warn(`M-NVR cameras with no CMS camera (register them in CMS or set CAMERA_MAP): ${un.join(', ')}`);
    if (unCms.length) log.warn(`CMS cameras with no M-NVR camera: ${unCms.join(', ')}`);
  }
  toCmsMap = t; toMnvrMap = r; cmsNames = new Map(cmsCams.map((c) => [Number(c.id), c.name]));
}

module.exports = {
  build,
  toCms: (mnvrId) => (mnvrId == null ? null : toCmsMap.get(Number(mnvrId)) ?? null),
  toMnvr: (cmsId) => (cmsId == null ? null : toMnvrMap.get(Number(cmsId)) ?? null),
  nameOfCms: (cmsId) => cmsNames.get(Number(cmsId)) || `camera ${cmsId}`,
  /** Who a CMS camera is in the naming convention: { train_no, unit_no (M-NVR no.), camera_no }. Sent with every segment so CMS can cross-check it. */
  identityOf: (cmsId) => ({ train_no: unit.train_no, unit_no: unit.unit_no, camera_no: cmsNos.get(Number(cmsId)) ?? null }),
  unit: () => ({ ...unit }),
  snapshot: () => ({ mnvr_to_cms: Object.fromEntries(toCmsMap) }),
};
