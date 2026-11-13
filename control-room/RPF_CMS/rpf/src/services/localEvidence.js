/**
 * Local evidence store of this RPF server. When an officer chooses "keep a copy at this post", the flagged
 * section is cut from the delivered footage (stream copy, not re-encoded), hashed and saved here together with
 * a small .json file that records everything the officer entered (section times, retention time, justification).
 * Layout:  <LOCAL_EVIDENCE_DIR>/post-<id>/flag-<id>.mp4  +  flag-<id>.json
 * These files are the post's own; CMS never deletes them and nothing here is deleted automatically.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const { resolveFootageFile } = require("./storage");
const { clipFile, hasFfmpeg } = require("./clip");
const { HttpError } = require("../errors");
const { describeFsError } = require("./fsErrors");

const root = () => config.localEvidenceDir;
function localAbs(rel) {
  const p = path.resolve(root(), String(rel || ""));
  const r = path.relative(root(), p);
  if (!r || r.startsWith("..") || path.isAbsolute(r))
    throw new Error("path escapes the local evidence store");
  return p;
}
const exists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
};
const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")));
  });

/**
 * Step 1 (before the flag row exists): produce the copy in a temp file. Returns { tmp, wholeFile, why }. Throws HttpError with the REAL reason if it cannot.
 * If only cutting the section fails (ffmpeg refuses this file), the whole recording is saved instead - a bigger copy is better than no copy - and
 * `why` says so; a missing ffmpeg or an unwritable folder still fails loudly.
 */
async function prepare(footage, section) {
  const src = await resolveFootageFile(footage.storage_path, footage.sha256);
  if (!src)
    throw new HttpError(
      404,
      "the footage file is not reachable from the RPF server, so it cannot be saved locally",
    );
  const tmpDir = path.join(root(), ".tmp");
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.accessSync(tmpDir, fs.constants.W_OK);
  } catch (e) {
    throw new HttpError(
      500,
      describeFsError(e, "the local evidence folder", root()) ||
        `the local evidence folder cannot be used: ${e.message}`,
    );
  }
  const tmp = path.join(tmpDir, `pending-${crypto.randomUUID()}.mp4`);
  let wholeFile = false;
  let why = null;
  try {
    if (section) {
      if (!(await hasFfmpeg()))
        throw new HttpError(
          501,
          "saving just a section locally needs ffmpeg on the RPF server (install ffmpeg), or flag the whole file",
        );
      try {
        const clip = await clipFile(
          src.file,
          footage.id,
          section.start,
          section.end,
        );
        fs.copyFileSync(clip.file, tmp);
      } catch (e) {
        if (
          e instanceof HttpError ||
          !(e.cut || /ffmpeg|empty clip/i.test(String(e.message)))
        )
          throw e;
        fs.copyFileSync(src.file, tmp);
        wholeFile = true;
        why = `the section could not be cut (${String(e.message).slice(0, 160)}) - the whole recording was saved locally instead`;
      }
    } else fs.copyFileSync(src.file, tmp);
  } catch (e) {
    discard(tmp);
    if (e instanceof HttpError) throw e;
    throw new HttpError(
      500,
      describeFsError(e, "saving the local copy", root()) ||
        `saving the local copy failed: ${String(e.message).slice(0, 200)}`,
    );
  }
  return { tmp, wholeFile, why };
}
const discard = (tmp) => {
  try {
    fs.rmSync(tmp, { force: true });
  } catch (_) {
    /* gone */
  }
};

/** Step 2 (after the flag row exists): move into place, write the sidecar, return what to record in the database. */
async function finalize(tmp, flag, meta) {
  const rel = `post-${meta.post_id}/flag-${flag.id}.mp4`;
  const dst = localAbs(rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(tmp, dst);
  const sha256 = await sha256File(dst);
  const size = fs.statSync(dst).size;
  fs.writeFileSync(
    dst.replace(/\.mp4$/, ".json"),
    JSON.stringify(
      {
        flag_id: flag.id,
        saved_at: new Date().toISOString(),
        file: path.basename(dst),
        sha256,
        size_bytes: size,
        ...meta,
      },
      null,
      2,
    ),
  );
  return { rel, sha256, size };
}

module.exports = { prepare, finalize, discard, localAbs, exists };
