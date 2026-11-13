/** File-system failures in words (with the command that fixes a permission problem), for the officer and the logs - instead of "internal server error". */
const os = require("os");
const CODES = {
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
  EXDEV: "cannot move between disks",
};
const who = () => {
  try {
    return os.userInfo().username;
  } catch (_) {
    return "the RPF user";
  }
};
/** root = the folder the RPF is allowed to write (named in the fix command); null when err is not a file-system error. */
function describeFsError(err, what, root) {
  if (!err || !CODES[err.code] || !err.syscall) return null;
  const fix =
    ["EACCES", "EPERM", "EROFS"].includes(err.code) && root
      ? `. Fix on the RPF PC:  sudo chown -R ${who()} ${root}`
      : "";
  return `${what}: ${err.code} ${CODES[err.code]} while ${err.syscall}${err.path ? ` (${err.path})` : ""}${fix}`;
}
/** null when the folder (and the folders inside it) can be written, else the reason in words. */
function checkWritable(root) {
  const fs = require("fs");
  const path = require("path");
  try {
    fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
    for (const d of [
      root,
      path.join(root, ".tmp"),
      ...fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith("post-"))
        .map((e) => path.join(root, e.name)),
    ])
      fs.accessSync(d, fs.constants.W_OK | fs.constants.X_OK);
    return null;
  } catch (e) {
    return (
      describeFsError(e, "the local evidence folder", root) ||
      `the local evidence folder cannot be used: ${e.message}`
    );
  }
}
module.exports = { describeFsError, who, checkWritable };
