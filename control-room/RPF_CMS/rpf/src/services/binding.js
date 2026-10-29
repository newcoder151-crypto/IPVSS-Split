/**
 * Which post this dashboard belongs to. Stored in a small file next to the app (data/post.json) - the
 * database is not changed. RPF_POST_ID in .env overrides it. Until a post is bound, only the registration
 * form is available.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { pool } = require('../db');

let cached; // undefined = not read yet; null = not bound

function readFile() {
  try { return Number(JSON.parse(fs.readFileSync(config.postFile, 'utf8')).post_id) || null; } catch (_) { return null; }
}
function boundId() {
  if (config.postIdFromEnv) return config.postIdFromEnv;
  if (cached === undefined) cached = readFile();
  return cached;
}

/** The bound post (id, name, zone) if it exists and is active, else null. */
async function boundPost() {
  const id = boundId();
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.zone_id, z.name AS zone_name,
            ST_Y(p.location::geometry) AS latitude, ST_X(p.location::geometry) AS longitude
       FROM rpf_post p JOIN zone z ON z.id = p.zone_id WHERE p.id = $1 AND p.active`, [id]);
  return rows[0] || null;
}

function bind(postId) {
  fs.mkdirSync(path.dirname(config.postFile), { recursive: true });
  fs.writeFileSync(config.postFile + '.tmp', JSON.stringify({ post_id: Number(postId), bound_at: new Date().toISOString() }));
  fs.renameSync(config.postFile + '.tmp', config.postFile);
  cached = Number(postId);
}

/** Forget the binding (used by tests and by an administrator who wants to re-register the dashboard). */
function unbind() { try { fs.rmSync(config.postFile, { force: true }); } catch (_) { /* nothing to remove */ } cached = null; }

module.exports = { boundId, boundPost, bind, unbind };
