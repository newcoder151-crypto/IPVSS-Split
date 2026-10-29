#!/usr/bin/env node
/**
 * M-NVR simulator - plays the part of the train unit, so the whole chain
 *   M-NVR -> CMS -> RPF
 * can be run and demonstrated without hardware. DEV / DEMO ONLY: it talks to CMS exactly the way a
 * real unit does (heartbeat + GPS track, alerts, resumable chunked uploads, upload-now commands).
 *
 *   node scripts/mnvr_sim.js run   [--units 1,2,3] [--api http://localhost:7080] [--alerts 60]
 *   node scripts/mnvr_sim.js alert --unit 1 --type intrusion --priority 9 [--camera 1] [--lat .. --lon ..]
 *   node scripts/mnvr_sim.js offline <unit>      # the train enters a tunnel: no contact with CMS
 *   node scripts/mnvr_sim.js online  <unit>
 *
 * Unit N authenticates with fingerprint "fp-demo-N" (CMS sql/fixtures.sql).
 * Each unit "records" a continuous 10-second-segment timeline on its own disk for the last
 * REC_MINUTES (default 90) and only uploads what CMS asks for (upload_now commands), which is how a
 * real unit behaves given 5G is intermittent. Footage is synthetic: a test pattern with the camera
 * name and wall-clock time burnt in, so a viewer can see which moment they are looking at.
 *   CODEC=vp9 produces VP9 (plays in stock Chromium); the default is H.264.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ARGS = process.argv.slice(2);
const CMD = ARGS[0] && !ARGS[0].startsWith('--') ? ARGS[0] : 'run';
const opt = (name, dflt) => { const i = ARGS.indexOf(`--${name}`); return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : dflt; };
const API = opt('api', process.env.CMS_URL || 'http://localhost:7080').replace(/\/$/, '') + '/nvr/v1';
const RUN_DIR = path.resolve(process.env.SIM_DIR || path.join(__dirname, '..', 'run'));
const SEG_S = 10;
const REC_MIN = Number(process.env.REC_MINUTES || 90);
const CODEC = (process.env.CODEC || 'h264').toLowerCase();
const CHUNK = 256 * 1024;
const CACHE = path.join(os.tmpdir(), 'mnvr-sim-cache');
fs.mkdirSync(RUN_DIR, { recursive: true }); fs.mkdirSync(CACHE, { recursive: true });

const flagFile = (n) => path.join(RUN_DIR, `mnvr-offline-${n}`);
const log = (n, ...a) => console.log(`[${new Date().toLocaleTimeString()}] nvr-${n}`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (CMD === 'offline' || CMD === 'online') {
  const n = ARGS[1]; if (!n) { console.error(`usage: mnvr_sim.js ${CMD} <unit number>`); process.exit(2); }
  if (CMD === 'offline') fs.writeFileSync(flagFile(n), 'offline'); else fs.rmSync(flagFile(n), { force: true });
  console.log(`unit ${n} is now ${CMD}`); process.exit(0);
}

// A rail route to drive along (Kanpur -> Lucknow-ish, matches the fixture posts in lon 80-81.5, lat 26).
const ROUTES = {
  1: { from: [80.10, 26.00], to: [81.50, 26.20] },
  2: { from: [81.40, 26.18], to: [80.20, 26.02] },
  3: { from: [77.20, 28.60], to: [77.60, 28.90] },
};

class Unit {
  constructor(n, api) {
    this.n = n; this.api = api; this.fp = `fp-demo-${n}`;
    this.t0 = Date.now() - REC_MIN * 60000;          // when this unit "started recording"
    this.route = ROUTES[n] || ROUTES[1];
    this.cameras = []; this.busy = false; this.track = [];
  }
  headers(extra) { return { 'X-NVR-Fingerprint': this.fp, ...extra }; }
  async call(method, p, body, raw) {
    const res = await fetch(this.api + p, {
      method, headers: this.headers(body && !raw ? { 'Content-Type': 'application/json' } : raw ? { 'Content-Type': 'application/octet-stream' } : {}),
      body: raw || (body ? JSON.stringify(body) : undefined), signal: AbortSignal.timeout(30000),
    });
    let data = null; try { data = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status });
    return data;
  }
  offline() { return fs.existsSync(flagFile(this.n)); }

  position(at = Date.now()) { // oscillate along the route, one pass per 30 min
    const f = (((at - this.t0) / 1000 / 1800) % 2); const k = f <= 1 ? f : 2 - f;
    const [a, b] = [this.route.from, this.route.to];
    return { lon: a[0] + (b[0] - a[0]) * k, lat: a[1] + (b[1] - a[1]) * k, speed_mps: 28 };
  }

  async init() {
    const me = await this.call('GET', '/self');
    this.cameras = me.cameras;
    if (!this.cameras.length) throw new Error('this unit has no cameras registered in CMS');
    log(this.n, `registered as '${me.nvr.name}' with ${this.cameras.length} camera(s)`);
  }

  // ---- recording (synthetic) ------------------------------------------------------------------
  slotStart(ms) { return Math.floor(ms / (SEG_S * 1000)) * SEG_S * 1000; }
  segFile(cam, slot) {
    const f = path.join(CACHE, `${CODEC}-n${this.n}-c${cam.id}-${slot}.mp4`);
    if (fs.existsSync(f)) return f;
    const when = new Date(slot).toLocaleTimeString('en-GB', { hour12: false });
    const text = `${cam.name}  unit ${this.n}  %{pts\\:hms}`; // overlay: camera + elapsed; wall clock below
    const enc = CODEC === 'vp9' ? ['-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-g', '25', '-keyint_min', '25']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-maxrate', '250k', '-bufsize', '500k', '-pix_fmt', 'yuv420p', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0'];
    const tmp = f + `.tmp${process.pid}`;
    const font = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf', '/Library/Fonts/Arial.ttf'].find((p) => fs.existsSync(p));
    const clock = new Date(slot).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    const vf = font
      ? `drawtext=fontfile=${font}:text='${cam.name} / unit ${this.n}':x=10:y=10:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6,` +
        `drawtext=fontfile=${font}:text='${clock.replace(/:/g, '\\:')}  +%{eif\\:t\\:d}s':x=10:y=h-30:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6`
      : 'null';
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=25:duration=${SEG_S}`, '-vf', vf, ...enc, '-an', '-movflags', '+faststart', '-f', 'mp4', tmp]);
    fs.renameSync(tmp, f);
    return f;
  }
  /** Segment slots this unit actually has for [from, to]: only complete 10 s slots it was recording. */
  slotsFor(from, to) {
    const out = []; const end = Math.min(to, Date.now() - SEG_S * 1000);
    for (let s = this.slotStart(Math.max(from, this.t0)); s + SEG_S * 1000 <= end + 1; s += SEG_S * 1000) if (s >= this.t0) out.push(s);
    return out;
  }

  // ---- uploads (chunked, resumable) -----------------------------------------------------------
  async uploadSlot(cam, slot) {
    const file = this.segFile(cam, slot);
    const buf = fs.readFileSync(file);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const p0 = this.position(slot); const p1 = this.position(slot + SEG_S * 1000);
    const seg = await this.call('POST', '/segments', {
      camera_id: cam.id, start_time: new Date(slot).toISOString(), end_time: new Date(slot + SEG_S * 1000).toISOString(),
      size_bytes: buf.length, sha256: sha, start_lat: p0.lat, start_lon: p0.lon, end_lat: p1.lat, end_lon: p1.lon,
    });
    if (seg.upload_status === 'complete') return false;
    let index = seg.last_chunk_index + 1;
    for (let off = seg.bytes_received; off < buf.length; off += CHUNK, index++) {
      if (this.offline()) throw new Error('lost coverage mid-upload (will resume)');
      await this.call('PUT', `/segments/${seg.id}/chunks/${index}`, null, buf.subarray(off, off + CHUNK));
    }
    await this.call('POST', `/segments/${seg.id}/complete`);
    return true;
  }

  async runCommand(cmd) {
    if (cmd.kind === 'ping' || cmd.kind === 'sync_clock') { await this.call('POST', `/commands/${cmd.id}/done`, {}); return; }
    if (cmd.kind !== 'upload_now') { await this.call('POST', `/commands/${cmd.id}/fail`, { error: 'unsupported command' }); return; }
    await this.call('POST', `/commands/${cmd.id}/ack`);
    const cam = this.cameras.find((c) => c.id === cmd.camera_id);
    if (!cam) { await this.call('POST', `/commands/${cmd.id}/fail`, { error: `unknown camera ${cmd.camera_id}` }); return; }
    const from = new Date(cmd.window_start).getTime(); const to = new Date(cmd.window_end).getTime();
    const slots = this.slotsFor(from, to);
    log(this.n, `upload-now #${cmd.id}: ${cam.name} ${new Date(from).toLocaleTimeString()}-${new Date(to).toLocaleTimeString()} (${slots.length} segment(s))`);
    let n = 0;
    try {
      for (const s of slots) if (await this.uploadSlot(cam, s)) n++;
    } catch (e) { log(this.n, `upload interrupted: ${e.message}`); return; } // stays 'acked'; resumes on the next heartbeat
    const missing = [];
    if (!slots.length || slots[0] > from + SEG_S * 1000) missing.push({ from: new Date(from).toISOString(), to: new Date(slots[0] || to).toISOString() });
    await this.call('POST', `/commands/${cmd.id}/done`, { missing });
    log(this.n, `upload-now #${cmd.id} done (${n} new segment(s))`);
  }

  // ---- heartbeat loop ---------------------------------------------------------------------------
  async tick() {
    if (this.busy) return;
    if (this.offline()) { if (!this.wasOffline) log(this.n, 'in a tunnel - no contact with CMS'); this.wasOffline = true; this.track.push(this.gpsPoint()); this.track = this.track.slice(-600); return; }
    if (this.wasOffline) { log(this.n, 'back in coverage'); this.wasOffline = false; }
    this.busy = true;
    try {
      const p = this.position();
      const gps = [...this.track, this.gpsPoint()].slice(-300); this.track = [];
      const hb = await this.call('POST', '/heartbeat', { lat: p.lat, lon: p.lon, speed_mps: p.speed_mps, firmware: 'sim-1.0', fix_quality: 'gps',
        health: { disk_used_pct: 41 + this.n, cameras_ok: this.cameras.length, uptime_h: Math.round((Date.now() - this.t0) / 360000) / 10, temp_c: 38 }, gps });
      for (const c of hb.commands) {
        try { await this.runCommand(c); } catch (e) { log(this.n, `command #${c.id}: ${e.message}`); }
      }
    } catch (e) { log(this.n, `heartbeat failed: ${e.message}`); } finally { this.busy = false; }
  }
  /** Holds a request open; CMS answers the moment a command is queued for this unit (milliseconds, not a heartbeat). */
  async commandLoop() {
    for (;;) {
      if (this.offline()) { await sleep(500); continue; }
      try {
        const cmds = await this.call('GET', '/commands/wait?timeout=20');
        for (const c of cmds) {
          if (this.busy) await sleep(200);
          this.busy = true;
          try { await this.runCommand(c); } catch (e) { log(this.n, `command #${c.id}: ${e.message}`); } finally { this.busy = false; }
        }
        if (!cmds.length) continue;
        await sleep(100);
      } catch (e) { await sleep(1500); }
    }
  }
  gpsPoint() { const p = this.position(); return { ts: new Date().toISOString(), lat: p.lat, lon: p.lon, speed_mps: p.speed_mps }; }

  async alert({ type, priority, camera, lat, lon }) {
    const p = this.position();
    const cam = this.cameras.find((c) => c.id === Number(camera)) || this.cameras[Math.floor(Math.random() * this.cameras.length)];
    const body = { nvr_event_id: `sim-${this.n}-${crypto.randomUUID()}`, alert_type: type, priority: Number(priority), camera_id: cam.id,
      lat: lat != null ? Number(lat) : p.lat, lon: lon != null ? Number(lon) : p.lon, event_time: new Date().toISOString(), fix_quality: 'gps', fix_age_s: 1 };
    const r = await this.call('POST', '/alerts', body);
    log(this.n, `alert ${type} P${priority} on ${cam.name} -> ${r.dispatched ? `auto-dispatched, incident #${r.incidentId}` : 'queued for CMS operator'}`);
    return r;
  }
}

const TYPES = [['intrusion', 9], ['panic_button', 9], ['tamper', 8], ['unattended_bag', 7], ['loitering', 3], ['crowding', 4], ['smoke', 6], ['camera_blocked', 2]];

(async () => {
  const units = (opt('units', '1,2,3')).split(',').map((s) => Number(s.trim())).filter(Boolean);
  if (CMD === 'alert') {
    const u = new Unit(Number(opt('unit', 1)), API); await u.init();
    await u.alert({ type: opt('type', 'intrusion'), priority: opt('priority', 9), camera: opt('camera'), lat: opt('lat'), lon: opt('lon') });
    return;
  }
  if (CMD !== 'run') { console.error('usage: mnvr_sim.js run|alert|offline|online'); process.exit(2); }

  const fleet = [];
  for (const n of units) {
    const u = new Unit(n, API);
    for (let i = 0; ; i++) { try { await u.init(); break; } catch (e) { if (i === 0) console.error(`unit ${n}: ${e.message} (retrying)`); if (i > 20) throw e; await sleep(2000); } }
    fleet.push(u);
  }
  const every = Number(opt('alerts', 0));
  console.log(`simulating ${fleet.length} unit(s) against ${API}; ${every ? `a random alert every ~${every}s` : 'no random alerts (use: alert)'}.  Ctrl-C to stop.`);
  for (const u of fleet) { setInterval(() => u.tick(), 3000); u.commandLoop(); }
  fleet.forEach((u) => u.tick());
  if (every) {
    const loop = async () => {
      for (;;) {
        await sleep(every * 1000 * (0.5 + Math.random()));
        const u = fleet[Math.floor(Math.random() * fleet.length)];
        if (u.offline()) continue;
        const [type, prio] = TYPES[Math.floor(Math.random() * TYPES.length)];
        await u.alert({ type, priority: prio }).catch((e) => log(u.n, `alert failed: ${e.message}`));
      }
    };
    loop();
  }
})().catch((e) => { console.error('mnvr_sim:', e.message); process.exit(1); });
