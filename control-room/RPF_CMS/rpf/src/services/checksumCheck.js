'use strict';
/**
 * What the checksums of ONE evidence flag mean (identical in the CMS and the RPF server).
 *
 *   - Retained the WHOLE recording: the CMS archive copy and the post's local copy are byte-for-byte copies of the delivered file,
 *     so every SHA-256 must be the same.
 *   - Retained a SECTION: that is a new, shorter file cut out of the delivered recording, so its SHA-256 can never equal the
 *     SHA-256 of the whole delivered file - that is expected, not an error. What must match is the CMS copy of the section
 *     and the post's copy of the same section.
 *
 * Returns { state: 'ok' | 'mismatch' | 'pending', whole, lines: [{ ok: true|false|null, text }] }
 */
module.exports = function checksumCheck(f) {
  const whole = f.section_start_s == null || f.copy_kind === 'whole'; // a whole-file copy is byte-identical to the delivered file even when a section is flagged
  const del = f.footage_sha256; const arc = f.archive_sha256; const loc = f.local_sha256;
  const lines = [];
  if (whole) {
    if (arc) lines.push({ ok: arc === del, text: arc === del ? 'The CMS copy is identical to the delivered file' : 'The CMS copy DIFFERS from the delivered file' });
    if (loc) lines.push({ ok: loc === del, text: loc === del ? "The post's copy is identical to the delivered file" : "The post's copy DIFFERS from the delivered file" });
  } else {
    lines.push({ ok: null, text: 'A section is a new file cut from the delivered recording, so its SHA-256 is different from the whole file - this is expected' });
    if (arc && loc) lines.push({ ok: arc === loc, text: arc === loc ? "The CMS copy and the post's copy of the section are identical" : "The CMS copy and the post's copy of the section DIFFER - use Verify to repair the post's copy" });
  }
  const bad = lines.some((l) => l.ok === false);
  const good = lines.some((l) => l.ok === true);
  return { state: bad ? 'mismatch' : good ? 'ok' : 'pending', whole, lines };
};
