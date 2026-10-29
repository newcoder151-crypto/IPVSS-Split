#!/usr/bin/env node
/**
 * Create (or reset) a non-interactive SERVICE account straight in the database.
 *
 *   node create-service-user.js <username> <password> [--role API_CLIENT] [--reset]
 *
 * Why this exists
 *   POST /api/users needs an ADMIN token, but the seeded admin is blocked by
 *   must_change_password=1 until its password is changed from the command line
 *   (docs/QUICK_START.md#first-login). A service account must not depend on
 *   that, and must never reuse the admin login: five wrong password attempts
 *   permanently lock an account (auth.js), and a retrying service with a stale
 *   password reaches that in about 25 seconds.
 *
 * Behaviour
 *   - new user:      role API_CLIENT (default), must_change_password=0, bcrypt cost 12
 *   - existing user: refused unless --reset, which sets the new password AND
 *                    clears is_locked / failed_login_attempts (also the way to
 *                    unlock a service account that got locked).
 *   - same username / password rules as POST /api/users.
 * Run from backend/api (uses ./.env like seed.js).
 */
require("dotenv").config({ path: __dirname + "/.env" });
const bcrypt = require("bcryptjs");
const { pool, queryOne, query } = require("./src/db");
const { VALID_ROLES, validatePasswordStrength, validateUsername } = require("./src/config/security");

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const ri = args.indexOf("--role");
  const role = String(ri >= 0 ? args[ri + 1] : "API_CLIENT").toUpperCase();
  const pos = args.filter((a, i) => !a.startsWith("--") && !(ri >= 0 && i === ri + 1));
  const [username, password] = pos;

  if (!username || !password) {
    console.error("usage: node create-service-user.js <username> <password> [--role API_CLIENT] [--reset]");
    return 2;
  }
  if (!validateUsername(username)) { console.error("username must be 3-32 chars: letters, numbers, . _ -"); return 2; }
  const pwErr = validatePasswordStrength(password);
  if (pwErr) { console.error(pwErr); return 2; }
  if (!VALID_ROLES.includes(role)) { console.error(`role must be one of: ${VALID_ROLES.join(", ")}`); return 2; }

  const hash = await bcrypt.hash(password, 12);
  const existing = await queryOne("SELECT user_id, role FROM users WHERE username=$1", [username]);

  if (existing) {
    if (!reset) {
      console.error(`user '${username}' already exists — pass --reset to set a new password and clear any lockout`);
      return 1;
    }
    await query(
      `UPDATE users SET password_hash=$1, must_change_password=0, is_locked=0, failed_login_attempts=0,
              is_active=1, updated_at=NOW() WHERE user_id=$2`, [hash, existing.user_id]);
    console.log(`reset '${username}' (role ${existing.role} unchanged): password set, lockout cleared`);
    return 0;
  }

  const u = await queryOne(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, must_change_password, created_by)
     VALUES ($1,$2,$3,$4,1,0,'create-service-user') RETURNING user_id, username, role`,
    [username, hash, `Service account (${username})`, role]);
  console.log(`created ${u.role} account '${u.username}' (id ${u.user_id})`);
  return 0;
}

main().then((c) => pool.end().then(() => process.exit(c)))
      .catch((e) => { console.error("failed:", e.message); pool.end().finally(() => process.exit(1)); });
