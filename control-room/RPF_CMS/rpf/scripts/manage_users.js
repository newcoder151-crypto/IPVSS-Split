/**
 * Manage RPF dashboard logins in the shared CMS `users` table.
 * Passwords are stored as bcrypt hashes, so they can be set or reset but never shown.
 * Run through the launcher:   bash scripts/start.sh users <command>
 *
 *   users list
 *   users add <username> [password]          another officer login for THIS dashboard's post
 *   users password <username> [new-password]     (omit the password to generate one)
 *   users bind "<post name or id>"            make this dashboard the dashboard of a post that already exists
 *                                              (e.g. created in the CMS console, or an install from before registration)
 *
 * Connects with the database credentials in .env (the owner role), because the
 * least-privilege rpf_app role is not allowed to write to users.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');

const RPF_ROLES = ['post_user']; // a dashboard serves one post; only post officers sign in
const MIN_PASSWORD = 8;

function fail(msg) { console.error(`error: ${msg}`); process.exitCode = 1; }

function generatePassword() {
  // 16 chars, unambiguous alphabet (no 0/O/1/l/I)
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function resolvePassword(given) {
  if (given == null || given === '') return { password: generatePassword(), generated: true };
  if (given.length < MIN_PASSWORD) throw new Error(`password must be at least ${MIN_PASSWORD} characters`);
  return { password: given, generated: false };
}

async function audit(action, entityId, details) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, details) VALUES (NULL, $1, 'users', $2, $3)`,
      [action, entityId, JSON.stringify({ ...details, via: 'scripts/manage_users.js' })]
    );
  } catch (_) { /* auditing must never block account management */ }
}

async function list() {
  const { rows } = await pool.query(
    `SELECT u.username, u.role, u.status, z.name AS zone, p.name AS post
       FROM users u
       LEFT JOIN zone z ON z.id = u.zone_id
       LEFT JOIN rpf_post p ON p.id = u.post_id
      WHERE u.username <> 'system'
      ORDER BY (u.role = 'post_user') DESC, u.role, u.username`
  );
  if (!rows.length) { console.log('no users found'); return; }
  const scopeOf = (r) => (r.post ? `${r.post}` : r.zone ? `${r.zone} (all posts)` : 'all zones');
  const dashOf = (r) => (RPF_ROLES.includes(r.role) ? (r.status === 'active' ? 'yes' : 'disabled') : 'no (CMS console)');
  const width = (head, vals) => Math.max(head.length, ...vals.map((v) => String(v).length));
  const cols = [
    ['username', width('username', rows.map((r) => r.username))],
    ['role', width('role', rows.map((r) => r.role))],
    ['status', width('status', rows.map((r) => r.status))],
    ['scope', width('scope', rows.map(scopeOf))],
    ['dashboard', width('dashboard', rows.map(dashOf))],
  ];
  const line = (cells) => cells.map((c, i) => String(c).padEnd(cols[i][1])).join('  ').trimEnd();
  console.log(line(cols.map((c) => c[0])));
  console.log(line(cols.map((c) => '-'.repeat(c[1]))));
  for (const r of rows) console.log(line([r.username, r.role, r.status, scopeOf(r), dashOf(r)]));
}

async function findPost(ref) {
  const byId = /^\d+$/.test(ref);
  const { rows } = await pool.query(
    byId ? 'SELECT id, zone_id, name FROM rpf_post WHERE id = $1'
         : 'SELECT id, zone_id, name FROM rpf_post WHERE lower(name) = lower($1)', [ref]);
  if (!rows.length) {
    const all = await pool.query('SELECT name FROM rpf_post ORDER BY name');
    throw new Error(`post '${ref}' not found. Posts: ${all.rows.map((r) => r.name).join(', ') || '(none)'}`);
  }
  if (rows.length > 1) throw new Error(`several posts are named '${ref}'; use the numeric id`);
  return rows[0];
}

async function add(argv) {
  const [username, passwordArg] = argv;
  if (!username) throw new Error('usage: users add <username> [password]   (an officer login for the post this dashboard is registered to)');
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw new Error('username must be 3-40 characters: letters, digits, dot, dash, underscore');
  const post = await require('../src/services/binding').boundPost();
  if (!post) throw new Error('this dashboard has no post registered yet - open it in the browser and fill in the registration form first');
  const role = 'post_user'; const postId = post.id; const zoneId = post.zone_id; const scopeText = `${post.name} - ${post.zone_name}`;
  const { password, generated } = await resolvePassword(passwordArg);
  const hash = await bcrypt.hash(password, 10);

  const { rows: dup } = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
  if (dup.length) throw new Error(`user '${username}' already exists (use: users password ${username})`);

  const { rows } = await pool.query(
    `INSERT INTO users (zone_id, post_id, role, username, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [zoneId, postId, role, username, hash]);
  await audit('user.create', rows[0].id, { username, role });
  console.log(`created ${username} (${role}, ${scopeText})`);
  console.log(`password: ${password}${generated ? '   <- generated; shown only now' : ''}`);
}

async function setPassword(argv) {
  const [username, given] = argv;
  if (!username) throw new Error('usage: users password <username> [new-password]');
  if (username === 'system') throw new Error("'system' owns auto-dispatched incidents and is not a login; it cannot be changed here");
  const { rows } = await pool.query('SELECT id, role FROM users WHERE username = $1', [username]);
  if (!rows.length) throw new Error(`user '${username}' not found (see: users list)`);
  const { password, generated } = await resolvePassword(given);
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [rows[0].id, await bcrypt.hash(password, 10)]);
  await audit('user.password', rows[0].id, { username });
  console.log(`password updated for ${username} (${rows[0].role})`);
  console.log(`password: ${password}${generated ? '   <- generated; shown only now' : ''}`);
  if (!RPF_ROLES.includes(rows[0].role)) console.log(`note: ${rows[0].role} accounts cannot sign in to the RPF dashboard`);
}

async function bind(argv) {
  if (!argv[0]) throw new Error('usage: users bind "<post name or id>"');
  const post = await findPost(argv[0]);
  require('../src/services/binding').bind(post.id);
  console.log(`this dashboard now belongs to ${post.name}. Sign in with one of its officer logins (users list).`);
}

(async () => {
  const [cmd, ...argv] = process.argv.slice(2);
  try {
    if (cmd === 'list' || cmd === undefined) await list();
    else if (cmd === 'add') await add(argv);
    else if (cmd === 'password') await setPassword(argv);
    else if (cmd === 'bind') await bind(argv);
    else fail(`unknown command '${cmd}'. Use: list | add | password | bind`);
  } catch (err) {
    fail(err.message);
  } finally {
    await pool.end();
  }
})();
