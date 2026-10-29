const { pool } = require('../db');
const config = require('../config');

/**
 * Background jobs. Each run takes a Postgres advisory lock, so two CMS backends on one database
 * never run the same job twice, and the outcome is written to job_status for the console.
 */
const JOBS = [
  { name: 'requests',   every: 8,     fn: () => require('./requestService').processOpen(),    label: 'Footage requests: auto-approve, check NVR uploads, deliver, expire' },
  { name: 'archive',    every: 8,     fn: () => require('./evidenceService').archivePending(),label: 'Evidence: copy flagged sections to permanent storage' },
  { name: 'escalation', every: 30,    fn: () => require('./escalation').run(),                 label: 'Alerts: escalate unacknowledged deliveries' },
  { name: 'retention',  every: 3600,  fn: () => require('./retentionService').runIfEnabled(),  label: 'Retention: 30-day FIFO on raw segments, expire timed flags' },
  { name: 'partitions', every: 86400, fn: async () => `${(await pool.query('SELECT ensure_partitions(3) AS n')).rows[0].n} partition(s) created`, label: 'Database: monthly alert / GPS partitions' },
];

async function runJob(job) {
  const lockKey = Array.from(job.name).reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);
  const client = await pool.connect();
  const t0 = Date.now();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [lockKey]);
    if (!rows[0].got) return;
    try {
      const msg = await job.fn();
      await record(job.name, true, Date.now() - t0, msg);
    } catch (e) {
      console.error(`job ${job.name} failed:`, e.message);
      await record(job.name, false, Date.now() - t0, e.message);
    } finally { await client.query('SELECT pg_advisory_unlock($1)', [lockKey]); }
  } finally { client.release(); }
}

const record = (name, ok, ms, msg) => pool.query(
  `INSERT INTO job_status (name, last_run_at, last_ok, last_ms, last_message, runs) VALUES ($1, now(), $2, $3, $4, 1)
   ON CONFLICT (name) DO UPDATE SET last_run_at = now(), last_ok = $2, last_ms = $3, last_message = $4, runs = job_status.runs + 1`,
  [name, ok, ms, String(msg || '').slice(0, 300)]).catch(() => {});

// Run a job NOW because work just appeared (instead of waiting for its next tick). Bursts coalesce:
// while one run is in progress at most one more is queued.
const state = new Map();
function kick(name) {
  const j = JOBS.find((x) => x.name === name); if (!j || !config.workers) return;
  const st = state.get(name) || { running: false, again: false };
  state.set(name, st);
  if (st.running) { st.again = true; return; }
  st.running = true;
  runJob(j).catch((e) => console.error(`job ${name}:`, e.message)).finally(() => { st.running = false; if (st.again) { st.again = false; kick(name); } });
}

const timers = [];
function start() {
  if (!config.workers) { console.log('background workers disabled (CMS_WORKERS=0)'); return; }
  for (const j of JOBS) {
    const tick = () => runJob(j).catch((e) => console.error(`job ${j.name}:`, e.message));
    setTimeout(tick, 1500 + timers.length * 400);
    const t = setInterval(tick, j.every * 1000); t.unref();
    timers.push(t);
  }
}
const stop = () => timers.splice(0).forEach(clearInterval);

module.exports = { JOBS, start, stop, runJob, kick };
