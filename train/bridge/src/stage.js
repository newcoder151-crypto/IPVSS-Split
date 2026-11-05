/** Where the bridge is in its start-up and who it is, for the local status page (/health) and start.sh's "bridge says: ..." message. */
module.exports = {
  stage: "starting",
  error: null,
  train_no: null,
  unit_no: null,
  identity_problem: null,
};
