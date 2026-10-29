/**
 * DEV ONLY - stands in for the parts of CMS that are not built yet: the
 * operator who approves video requests and the ingest path that delivers the
 * stitched footage file. It writes the same rows CMS eventually will
 * (video_request status, delivered_footage), so RPF is exercised end to end.
 * RPF itself never does any of this.
 *
 *   node scripts/simulate_cms.js approve <request_id>
 *   node scripts/simulate_cms.js reject  <request_id> [note]
 *   node scripts/simulate_cms.js fulfill <request_id>   # approve if needed + deliver sample footage
 *   node scripts/simulate_cms.js watch                  # auto-approve + fulfil new requests
 *
 * Alerts come from CMS itself: POST /api/alerts on the CMS backend, or
 * CMS's scripts/seed_demo_data.sh.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../src/config');
const { pool, withTransaction } = require('../src/db');

if (process.env.NODE_ENV === 'production') {
  console.error('refusing to run the CMS simulator with NODE_ENV=production');
  process.exit(1);
}

// SAMPLE_FILE lets tests deliver a different clip (e.g. one a codec-limited browser can decode).
const SAMPLE = process.env.SAMPLE_FILE || path.join(__dirname, 'sample', 'sample.mp4');

async function operatorId(client) {
  const { rows } = await client.query(`SELECT id FROM users WHERE username IN ('sim-operator','system') ORDER BY (username = 'sim-operator') DESC LIMIT 1`);
  if (!rows.length) throw new Error("no 'sim-operator' or 'system' user - run npm run seed-demo");
  return rows[0].id;
}

async function decide(id, status, note) {
  return withTransaction(async (client) => {
    const op = await operatorId(client);
    const { rowCount } = await client.query(
      `UPDATE video_request SET status = $2, operator_id = $3, decided_at = now(), decision_note = $4
        WHERE id = $1 AND status = 'submitted'`,
      [id, status, op, note || null]
    );
    return rowCount > 0;
  });
}

async function fulfill(id) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT r.id, r.status, p.zone_id FROM video_request r JOIN rpf_post p ON p.id = r.post_id WHERE r.id = $1 FOR UPDATE OF r`, [id]);
    const r = rows[0];
    if (!r) throw new Error(`request ${id} not found`);
    if (!['approved', 'amended'].includes(r.status)) throw new Error(`request ${id} is '${r.status}', approve it first`);

    const rel = path.join(`zone-${r.zone_id}`, `req-${id}.mp4`);
    const dest = path.join(config.mediaRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(SAMPLE, dest);
    const buf = fs.readFileSync(dest);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');

    await client.query(
      `INSERT INTO delivered_footage (video_request_id, storage_path, format, sha256, file_size_bytes)
       VALUES ($1, $2, 'MP4', $3, $4)`, [id, rel, sha, buf.length]);
    await client.query(`UPDATE video_request SET status = 'fulfilled' WHERE id = $1`, [id]);
  });
}

async function watch() {
  console.log('watching for submitted requests (Ctrl-C to stop)...');
  for (;;) {
    const { rows } = await pool.query(`SELECT id FROM video_request WHERE status = 'submitted' ORDER BY id`);
    for (const { id } of rows) {
      if (await decide(id, 'approved', 'auto-approved by simulator')) {
        console.log(`approved #${id}`);
        setTimeout(() => fulfill(id).then(() => console.log(`delivered footage for #${id}`)).catch((e) => console.error(`#${id}:`, e.message)), 4000);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

(async () => {
  const [cmd, arg, note] = process.argv.slice(2);
  try {
    if (cmd === 'watch') return await watch();
    const id = Number(arg);
    if (!['approve', 'reject', 'fulfill'].includes(cmd) || !Number.isInteger(id)) {
      console.error('usage: simulate_cms.js approve|reject|fulfill <request_id> | watch');
      process.exitCode = 2;
    } else if (cmd === 'approve') {
      console.log((await decide(id, 'approved')) ? `approved #${id}` : `#${id} is not in 'submitted'`);
    } else if (cmd === 'reject') {
      console.log((await decide(id, 'rejected', note || 'rejected by simulator')) ? `rejected #${id}` : `#${id} is not in 'submitted'`);
    } else {
      await decide(id, 'approved'); // no-op if already approved
      await fulfill(id);
      console.log(`delivered footage for #${id}`);
    }
  } catch (err) {
    console.error('failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (cmd !== 'watch') await pool.end();
  }
})();
