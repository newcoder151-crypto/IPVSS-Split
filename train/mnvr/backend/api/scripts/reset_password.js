#!/usr/bin/env node
/**
 * Reset passwords from the unit itself (physical/SSH access is the proof of authority). Also unlocks the account.
 *   node scripts/reset_password.js <username> [new-password]   one user (without a password: a temporary one, change forced)
 *   node scripts/reset_password.js --all <new-password>        every user at once (service accounts, role API_CLIENT, are left alone)
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, queryOne, pool } = require('../src/db');

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--all') {
    const pw = args[1];
    if (!pw) { console.error('usage: node scripts/reset_password.js --all <new-password>'); process.exit(2); }
    const r = await query(
      `UPDATE users SET password_hash=$1, must_change_password=0, failed_login_attempts=0, is_locked=0, updated_at=NOW()
        WHERE role <> 'API_CLIENT'`, [await bcrypt.hash(pw, 12)]);
    console.log(`  M-NVR accounts updated: ${r.rowCount}`);
    await pool.end(); return;
  }
  const [username, given] = args;
  if (!username) { console.error('usage: node scripts/reset_password.js <username> [new-password]  |  --all <new-password>'); process.exit(2); }
  const user = await queryOne('SELECT user_id, username FROM users WHERE lower(username)=lower($1)', [username]);
  if (!user) { console.error(`no such user: ${username}`); process.exit(1); }
  const temp = given || `${crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, 'x')}-Ab1`;
  await query('UPDATE users SET password_hash=$1, must_change_password=$2, failed_login_attempts=0, is_locked=0, is_active=1, updated_at=NOW() WHERE user_id=$3',
    [await bcrypt.hash(temp, 12), given ? 0 : 1, user.user_id]);
  console.log(`password for '${user.username}' reset and the account unlocked.`);
  if (!given) console.log(`temporary password: ${temp}   (must be changed at the next sign-in)`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
