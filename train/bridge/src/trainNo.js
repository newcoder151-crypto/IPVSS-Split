/** The train this M-NVR rides on: the M-NVR's OWN setting (system_config.train_number) wins; TRAIN_NO in the bridge settings (start.sh --train-no) is only
 *  the fallback for an M-NVR that has none. A leftover TRAIN_NO must never hide the real number. */
const log = require("./log")("identity");
let warned = "";
module.exports = function trainNoOf(info) {
  const own = String((info && info.train_number) || "").trim();
  const env = String(process.env.TRAIN_NO || "").trim();
  if (own && env && own !== env && warned !== env + own) {
    warned = env + own;
    log.warn(
      `TRAIN_NO='${env}' in the bridge settings differs from the M-NVR's own train number '${own}' - using the M-NVR's. (Remove TRAIN_NO from the settings to silence this.)`,
    );
  }
  return own || env;
};
