/**
 * HTTP client for the CMS M-NVR interface (/nvr/v1). The unit identifies itself with its certificate
 * fingerprint header (in production mTLS terminates in front of CMS and forwards the verified fingerprint).
 */
const config = require('./config');

class CmsError extends Error {
  constructor(message, { status = 0, network = false } = {}) { super(message); this.status = status; this.network = network; }
}

async function call(method, p, { json, raw, headers: extra, timeoutMs = 30000 } = {}) {
  const headers = { 'X-NVR-Fingerprint': config.fingerprint, ...(extra || {}) };
  let body;
  if (raw) { headers['Content-Type'] = 'application/octet-stream'; body = raw; }
  else if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  let res;
  try {
    res = await fetch(`${config.cmsUrl}/nvr/v1${p}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new CmsError(`cannot reach CMS (${e.cause && e.cause.code ? e.cause.code : e.message})`, { network: true });
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) throw new CmsError((data && data.error) || `HTTP ${res.status}`, { status: res.status });
  return data;
}

// A 5xx / gateway error is as transient as a dropped link; a 4xx is the CMS telling us the request is wrong.
const isTransient = (e) => e instanceof CmsError ? (e.network || e.status >= 500 || e.status === 429 || e.status === 408) : false;

module.exports = { call, CmsError, isTransient };
