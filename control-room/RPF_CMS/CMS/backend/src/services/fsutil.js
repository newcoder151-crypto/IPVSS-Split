const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");

/** Resolve a path relative to MEDIA_ROOT; anything that escapes the root is refused. */
function absPath(rel) {
  const root = config.mediaRoot;
  const p = path.resolve(root, String(rel || "").replace(/^file:\/\//, ""));
  const r = path.relative(root, p);
  if (!r || r.startsWith("..") || path.isAbsolute(r))
    throw new Error("path escapes MEDIA_ROOT");
  return p;
}
const ensureDir = (file) =>
  fs.mkdirSync(path.dirname(file), { recursive: true });
const exists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
};

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")));
  });
}
const mimeFor = (format) =>
  ({ mp4: "video/mp4", avi: "video/x-msvideo", mkv: "video/x-matroska" })[
    String(format || "").toLowerCase()
  ] || "application/octet-stream";

const os = require("os");
const whoami = () => {
  try {
    return os.userInfo().username;
  } catch (_) {
    return String(process.getuid ? process.getuid() : "?");
  }
};
const FS_CODES = {
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  ENOSPC: "the disk is full",
  EDQUOT: "disk quota exceeded",
  EROFS: "the disk is read-only",
  ENOENT: "folder or file missing",
  ENOTDIR: "a file is in the way of a folder",
  EEXIST: "a file is in the way of a folder",
  EISDIR: "a folder is in the way of a file",
  EMFILE: "too many open files",
  EIO: "disk I/O error",
};
/** A file-system failure in words ("footage store: EACCES permission denied (segments/train-X/...)"), or null when err is not one. */
function describeFsError(err) {
  if (!err || !FS_CODES[err.code] || !err.syscall) return null;
  let where = "";
  if (err.path) {
    const rel = path.relative(config.mediaRoot, String(err.path));
    where = ` (${rel && !rel.startsWith("..") ? rel : "outside the footage folder"})`;
  }
  const fix = ["EACCES", "EPERM", "EROFS"].includes(err.code)
    ? `. Fix on the control-room PC:  sudo chown -R ${whoami()} ${config.mediaRoot}`
    : "";
  return `footage store: ${err.code} ${FS_CODES[err.code]} while ${err.syscall}${where}${fix}`;
}
/** Folders (and half-written .part files) under the footage tree this process may not write to. Items it OWNS but with a wrong mode are repaired
 *  on the spot; the rest (made by another user, e.g. an earlier run with sudo) can only be fixed by the administrator - they are returned. */
function unwritable(root, limit = 20000) {
  const bad = [];
  let seen = 0;
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code !== "ENOENT") bad.push(dir);
      return;
    } // a folder that does not exist yet is simply created when needed
    for (const e of ents) {
      if (++seen > limit) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!canWrite(p, true)) {
          bad.push(p);
          continue;
        }
        walk(p);
      } else if (e.isFile() && e.name.endsWith(".part") && !canWrite(p, false))
        bad.push(p);
    }
  };
  const canWrite = (p, isDir) => {
    const ok = () => {
      try {
        fs.accessSync(p, fs.constants.W_OK | (isDir ? fs.constants.X_OK : 0));
        return true;
      } catch (_) {
        return false;
      }
    };
    if (ok()) return true;
    try {
      fs.chmodSync(p, fs.statSync(p).mode | (isDir ? 0o700 : 0o600));
    } catch (_) {
      /* not ours */
    }
    return ok();
  };
  walk(root);
  return bad;
}

/** Can the CMS store footage? Writes and removes a probe file in MEDIA_ROOT, checks every folder under it and reads the free space. */
let memo = { at: 0, v: null };
function storeStatus(maxAgeMs = 20000) {
  if (memo.v && Date.now() - memo.at < maxAgeMs) return memo.v;
  const root = config.mediaRoot;
  const out = { ok: true, error: null, free_mb: null };
  try {
    fs.mkdirSync(root, { recursive: true });
    const probe = path.join(root, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, "x");
    fs.rmSync(probe, { force: true });
    const bad = unwritable(root);
    if (bad.length) {
      out.ok = false;
      out.error = `footage store: ${bad.length} folder(s)/file(s) are not writable by '${whoami()}', e.g. ${path.relative(root, bad[0])}. Fix on the control-room PC:  sudo chown -R ${whoami()} ${root}`;
    }
  } catch (e) {
    out.ok = false;
    out.error = describeFsError(e) || `footage store: ${e.message}`;
  }
  try {
    if (fs.statfsSync) {
      const s = fs.statfsSync(root);
      out.free_mb = Math.round((s.bavail * s.bsize) / 1048576);
      if (out.ok && out.free_mb < 500) {
        out.ok = false;
        out.error = `footage store: only ${out.free_mb} MB free in ${root}`;
      }
    }
  } catch (_) {
    /* older Node: no free-space figure */
  }
  memo = { at: Date.now(), v: out };
  return out;
}

module.exports = {
  absPath,
  ensureDir,
  exists,
  sha256File,
  mimeFor,
  describeFsError,
  storeStatus,
};
