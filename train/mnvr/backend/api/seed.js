require("dotenv").config({ path: __dirname + "/.env" });
const { pool, query, testConnection } = require("./src/db");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");

async function seed() {
  const ok = await testConnection();
  if (!ok) {
    console.error("Cannot connect to DB");
    process.exit(1);
  }
  console.log("Seeding database...");

  // Users
  const adminHash = await bcrypt.hash("Admin@123", 12);
  const opHash = await bcrypt.hash("Operator@123", 12);

  await query(
    `INSERT INTO users(username,password_hash,full_name,email,role,is_active)
     VALUES('admin',$1,'System Administrator','admin@railway.gov.in','ADMIN',1)
     ON CONFLICT(username) DO UPDATE SET password_hash=$1, is_active=1`,
    [adminHash],
  );
  await query(
    `INSERT INTO users(username,password_hash,full_name,email,role,is_active)
     VALUES('operator',$1,'NVR Operator','operator@railway.gov.in','OPERATOR',1)
     ON CONFLICT(username) DO NOTHING`,
    [opHash],
  );
  console.log("✓ Users: admin/Admin@123, operator/Operator@123");

  const storagePath = path.resolve(
    process.env.RECORDINGS_PATH || "/storage/recordings",
  );
  const hlsPath = path.resolve(process.env.HLS_PATH || "/storage/hls");

  // Only insert cameras that don't already exist (by camera_name)
  const cameras = [
    {
      name: "CAM-01-INTERIOR",
      type: "INTERIOR",
      ip: "192.168.1.100",
      rtsp: "rtsp://192.168.1.100:554/stream1",
      user: "admin",
      pass: "bel123456",
      loc: "Coach S1 — Main Camera (Live)",
    },
    {
      name: "CAM-02-INTERIOR",
      type: "INTERIOR",
      ip: "192.168.1.101",
      rtsp: "rtsp://192.168.1.101:554/stream1",
      user: "admin",
      pass: "bel123456",
      loc: "Coach S1 — Front Passenger Area",
    },
    {
      name: "CAM-03-INTERIOR",
      type: "INTERIOR",
      ip: "192.168.1.102",
      rtsp: "rtsp://192.168.1.102:554/stream1",
      user: "admin",
      pass: "bel123456",
      loc: "Coach S1 — Rear Passenger Area",
    },
    {
      name: "CAM-04-DOOR",
      type: "DOOR",
      ip: "192.168.1.103",
      rtsp: "rtsp://192.168.1.103:554/stream1",
      user: "admin",
      pass: "bel123456",
      loc: "Door 1 — Left Entry",
    },
    {
      name: "CAM-05-EXTERIOR",
      type: "EXTERIOR",
      ip: "192.168.1.104",
      rtsp: "rtsp://192.168.1.104:554/stream1",
      user: "admin",
      pass: "bel123456",
      loc: "Exterior — Front View",
    },
    {
      name: "CAM-06-DRIVER",
      type: "DRIVER_CAB",
      ip: "192.168.1.105",
      rtsp: "rtsp://192.168.1.105:554/stream1",
      user: "admin",
      pass: "bel123456",
      loc: "Driver Cab",
    },
  ];

  const camIds = [];
  for (const c of cameras) {
    // Check if already exists by name
    const existing = await query(
      `SELECT camera_id FROM cameras WHERE camera_name=$1`,
      [c.name],
    );
    if (existing.rows.length > 0) {
      console.log(
        `  skip: ${c.name} already exists (camera_id=${existing.rows[0].camera_id})`,
      );
      camIds.push(existing.rows[0].camera_id);
      continue;
    }

    const r = await query(
      `INSERT INTO cameras(camera_name,camera_type,ip_address,rtsp_url,username,password_hash,
         location_description,target_fps,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,25,'ACTIVE')
       RETURNING camera_id`,
      [c.name, c.type, c.ip, c.rtsp, c.user, c.pass, c.loc],
    );
    if (r.rows[0]) {
      const cid = r.rows[0].camera_id;
      camIds.push(cid);

      // Create storage dirs and register in DB
      const recDir = path.join(storagePath, `cam_${cid}`);
      const hDir = path.join(hlsPath, `cam_${cid}`);
      fs.mkdirSync(recDir, { recursive: true });
      fs.mkdirSync(hDir, { recursive: true });

      await query(
        `UPDATE cameras SET rec_output_dir=$1, hls_output_dir=$2, hls_playlist_url=$3 WHERE camera_id=$4`,
        [recDir, hDir, `/api/streaming/hls/${cid}/stream.m3u8`, cid],
      );
      await query(
        `INSERT INTO camera_health(camera_id,is_online,is_recording,frame_rate_actual,bitrate_kbps,error_count)
         VALUES($1,0,0,0,0,0) ON CONFLICT DO NOTHING`,
        [cid],
      );
      console.log(`  + CAM: ${c.name} → camera_id=${cid} | IP: ${c.ip}`);
    }
  }

  // Sample events
  const eventDefs = [
    ["CROWD_DENSITY", "High crowd density near door", "WARNING", 2],
    ["INTRUSION", "Unauthorized access detected", "CRITICAL", 0],
    ["SMOKE", "Smoke detected near entry", "CRITICAL", 3],
    ["PHONE_USE", "Mobile phone use by LP", "WARNING", 5],
    ["MOTION", "Motion detected", "INFO", 0],
  ];
  for (const [etype, etitle, esev, cidx] of eventDefs) {
    const cid = camIds[cidx];
    if (!cid) continue;
    await query(
      `INSERT INTO events(event_type,title,severity,camera_id,description,occurred_at)
       VALUES($1,$2,$3,$4,$5,NOW()-INTERVAL '${Math.floor(Math.random() * 8) + 1} hours')
       ON CONFLICT DO NOTHING`,
      [etype, etitle, esev, cid, `Auto-seeded: ${etitle}`],
    );
  }

  console.log(
    `\n✅ Seed complete — ${camIds.length} cameras, login: admin/Admin@123`,
  );
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
