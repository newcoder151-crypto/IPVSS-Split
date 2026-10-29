#!/usr/bin/env node
// Why can't RPF open delivered footage?   cd RPF_CMS/rpf && node scripts/diagnose_media.js
// Reads .env, lists every delivered clip and says, per footage folder, whether RPF can reach it.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { pool } = require('../src/db');
const config = require('../src/config');
const storage = require('../src/services/storage');
(async () => {
  console.log('running from      :', path.join(__dirname, '..'));
  console.log('MEDIA_ROOT (RPF)  :', config.mediaRoot);
  console.log('also checked      :', config.mediaRootsExtra.join(', '));
  console.log('running as user   :', process.env.USER || process.getuid());
  const { rows } = await pool.query('SELECT id, storage_path FROM delivered_footage ORDER BY id DESC LIMIT 10');
  if (!rows.length) console.log('no delivered footage in the database this RPF is connected to');
  for (const r of rows) {
    const hit = await storage.resolveFootageFile(r.storage_path);
    console.log(`#${r.id} ${r.storage_path}  ->  ${hit ? 'OK ' + hit.file : 'NOT REACHABLE'}`);
    if (!hit) console.log('     ' + await storage.diagnose(r.storage_path));
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
