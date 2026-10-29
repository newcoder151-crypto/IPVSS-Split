/**
 * DEV ONLY. Inserts demo login accounts into the shared CMS `users` table
 * (data only - no schema change). Requires CMS's sql/fixtures.sql (zones and
 * posts) to have been applied first.
 *
 *   node scripts/seed_demo.js            # password defaults to rpf-demo-123
 *   DEMO_PASSWORD=... node scripts/seed_demo.js
 */
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');

if (process.env.NODE_ENV === 'production') {
  console.error('refusing to seed demo users with NODE_ENV=production');
  process.exit(1);
}

const PASSWORD = process.env.DEMO_PASSWORD || 'rpf-demo-123';

// A dashboard serves one post: the demo binds this dashboard to Post A.
const ACCOUNTS = [
  { username: 'post-a-officer', role: 'post_user', zone: 'Zone 1', post: 'Post A', bind: true },
  // Used only by scripts/simulate_cms.js to stand in for a CMS operator. Not an RPF login.
  { username: 'sim-operator', role: 'operator', zone: 'Zone 1', post: null },
];

(async () => {
  try {
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const a of ACCOUNTS) {
      const { rows: z } = await pool.query('SELECT id FROM zone WHERE name = $1', [a.zone]);
      if (!z.length) throw new Error(`zone '${a.zone}' not found - apply CMS sql/fixtures.sql first`);
      let postId = null;
      if (a.post) {
        const { rows: p } = await pool.query('SELECT id FROM rpf_post WHERE zone_id = $1 AND name = $2', [z[0].id, a.post]);
        if (!p.length) throw new Error(`post '${a.post}' not found - apply CMS sql/fixtures.sql first`);
        postId = p[0].id;
      }
      const { rowCount } = await pool.query(
        `INSERT INTO users (zone_id, post_id, role, username, password_hash) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (username) DO NOTHING`,
        [z[0].id, postId, a.role, a.username, hash]
      );
      console.log(`${rowCount ? 'created' : 'exists '}  ${a.username} (${a.role})`);
      if (a.bind) { require('../src/services/binding').bind(postId); console.log(`bound this dashboard to ${a.post}`); }
    }
    console.log(`\ndemo password: ${PASSWORD}`);
  } catch (err) {
    console.error('seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
