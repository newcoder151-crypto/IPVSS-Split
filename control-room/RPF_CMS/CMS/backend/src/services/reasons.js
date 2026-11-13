/**
 * Failure reasons in a few words - for notices and summaries. The full text stays in the request (and as a tooltip); this is what a person reads at a glance.
 * Keep in step with shortReason() in rpf/public/app.js (the same wording is shown on the request card).
 */
function shortReason(r) {
  const s = String(r || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "unknown reason";
  if (/no recording/i.test(s)) return "No recording for this window";
  if (/permission denied|footage store|EACCES|disk is full|ENOSPC/i.test(s))
    return "CMS storage problem";
  if (/files? .*(not on this PC|missing)/i.test(s))
    return "Recording files missing on the M-NVR";
  if (/removed from the fleet/i.test(s)) return "M-NVR removed from the fleet";
  if (/integrity/i.test(s)) return "Footage integrity check failure";
  if (/upload failed|keeps refusing|keeps answering/i.test(s))
    return "M-NVR upload failure";
  const first = s.split(/[:.;|]/)[0].trim() || s;
  return first.length > 70 ? `${first.slice(0, 67)}...` : first;
}

const lower = (t) =>
  /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t; // 'No recording...' -> 'no recording...', but 'CMS ...' / 'M-NVR ...' keep their capitals

/**
 * "4 of 8 cameras delivered, 2 failed due to no recording for this window"
 * reasons = [{ reason, n }] (raw failure texts with how many cameras each); several different causes are listed with their counts.
 */
function deliverySummary({
  delivered,
  total,
  failed,
  cancelled = 0,
  reasons = [],
}) {
  const byShort = new Map();
  for (const x of reasons) {
    const k = lower(shortReason(x.reason));
    byShort.set(k, (byShort.get(k) || 0) + Number(x.n || 1));
  }
  const list = [...byShort.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => (byShort.size > 1 ? `${k} (${n})` : k))
    .join(", ");
  let out = `${delivered} of ${total} cameras delivered`;
  if (failed) out += `, ${failed} failed${list ? ` due to ${list}` : ""}`;
  if (cancelled) out += `, ${cancelled} cancelled`;
  return out;
}
module.exports = { shortReason, deliverySummary };
