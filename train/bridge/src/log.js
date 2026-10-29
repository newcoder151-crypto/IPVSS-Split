const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 23);
const out = (lvl, tag, args) => console[lvl === 'ERR' ? 'error' : 'log'](`${stamp()} ${lvl} [${tag}]`, ...args);
module.exports = (tag) => ({
  info: (...a) => out('INF', tag, a),
  warn: (...a) => out('WRN', tag, a),
  error: (...a) => out('ERR', tag, a),
});
