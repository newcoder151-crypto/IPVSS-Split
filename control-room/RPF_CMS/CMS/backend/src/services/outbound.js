const { pool } = require("../db");
const config = require("../config");
const settings = require("./settings");
const providerConfig = require("./providerConfig");
const email = require("./channels/emailChannel");
const sms = require("./channels/smsChannel");
const { SendError } = require("./channels/sendError");

/**
 * Outgoing e-mail / SMS for notifications (the same ones the RPF bell shows).
 *
 *   notify.send()  ->  enqueue()   writes notification_delivery rows IN THE SAME TRANSACTION as the notification
 *   job notify_outbox -> processQueue()  sends them after commit, retrying with growing waits; a message older than
 *                                        NOTIFY_MAX_AGE_MIN is dropped (an alert from hours ago would mislead).
 * So: a rolled-back alert sends nothing, a slow or unreachable gateway never delays an alert, and nothing is lost while
 * the control room is offline - it goes out as soon as the network is back.
 */
const CHANNELS = { email, sms };
const csv = (s) => String(s || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const clip = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).trimEnd() + "…");

function compose(n, postName) {
  const when = new Date().toLocaleString();
  const lines = [n.title];
  if (n.body) lines.push("", n.body);
  lines.push("");
  if (postName) lines.push(`Post: ${postName}`);
  lines.push(`Time: ${when}`);
  if (config.outbound.linkBase) lines.push("", `Open the RPF dashboard: ${config.outbound.linkBase}`);
  lines.push("", "-- IPVSS control room (automatic message, do not reply)");
  const smsText = clip(`IPVSS: ${n.title}${n.body ? ". " + n.body : ""}${postName ? ` [${postName}]` : ""}`, config.outbound.sms.maxChars);
  return { subject: clip(`[IPVSS] ${n.title}`, 150), text: lines.join("\n"), sms: smsText };
}

/** Called by notify.send with the same connection / transaction as the notification insert. Never throws. */
async function enqueue(q, notificationId, n) {
  try {
    await providerConfig.fresh();
    const s = await settings.all();
    const kinds = csv(s.notify_kinds).map((k) => k.toLowerCase());
    if (!kinds.includes(String(n.kind).toLowerCase())) return 0;
    let emailOn = !!s.notify_email_enabled && email.configured();
    let smsOn = !!s.notify_sms_enabled && sms.configured();
    if (smsOn && n.kind === "alert" && n.priority != null && Number(n.priority) < Number(s.notify_sms_min_priority)) smsOn = false;
    if (!emailOn && !smsOn) return 0;

    let post = null;
    if (n.post_id) post = (await q.query("SELECT name, alert_email, alert_phone FROM rpf_post WHERE id = $1", [n.post_id])).rows[0] || null;
    const to = { email: new Set(), sms: new Set() };
    if (post && post.alert_email && email.isEmail(post.alert_email)) to.email.add(post.alert_email.trim());
    if (post && post.alert_phone) { const p = sms.normalizePhone(post.alert_phone); if (p) to.sms.add("+" + p); }
    for (const a of csv(s.notify_extra_emails)) if (email.isEmail(a)) to.email.add(a);
    for (const t of csv(s.notify_extra_phones)) { const p = sms.normalizePhone(t); if (p) to.sms.add("+" + p); }
    const msg = compose(n, post && post.name);
    const rows = [];
    if (emailOn) for (const r of to.email) rows.push([notificationId, n.post_id || null, n.kind, "email", r, msg.subject, msg.text]);
    if (smsOn) for (const r of to.sms) rows.push([notificationId, n.post_id || null, n.kind, "sms", r, null, msg.sms]);
    if (!rows.length) return 0;

    // a savepoint, so that a problem here can never poison the caller's transaction (the in-app notification must always be saved)
    let sp = false;
    try { await q.query("SAVEPOINT notify_outbox"); sp = true; } catch (e) { if (e.code !== "25P01") throw e; } // 25P01: not in a transaction
    try {
      for (const r of rows)
        await q.query(
          `INSERT INTO notification_delivery (notification_id, post_id, kind, channel, recipient, subject, body) VALUES ($1,$2,$3,$4,$5,$6,$7)`, r);
      if (sp) await q.query("RELEASE SAVEPOINT notify_outbox");
    } catch (e) {
      if (sp) await q.query("ROLLBACK TO SAVEPOINT notify_outbox").catch(() => {});
      throw e;
    }
    // send soon (the job also runs on a timer); by then the surrounding transaction has committed
    setTimeout(() => { try { require("./jobs").kick("notify_outbox"); } catch (_) { /* jobs not started (tests) */ } }, 1500).unref();
    return rows.length;
  } catch (e) {
    console.warn("outbound enqueue failed:", e.message);
    return 0;
  }
}

async function deliver(row) {
  const ch = CHANNELS[row.channel];
  return ch.send(row.channel === "email" ? { to: row.recipient, subject: row.subject, text: row.body } : { to: row.recipient, text: row.body });
}

async function processQueue() {
  await providerConfig.fresh();
  const o = config.outbound;
  // 1) too old to be useful
  const old = await pool.query(
    `UPDATE notification_delivery SET status = 'expired', last_error = 'not sent within ' || $1::text || ' minutes (network or gateway down) - dropped instead of arriving late'
      WHERE status = 'pending' AND cms_owns(id) AND created_at < now() - make_interval(mins => $1)`, [o.maxAgeMin]);
  // 2) claim a batch (lease: if this process dies mid-send the row is picked up again later)
  const { rows } = await pool.query(
    `WITH c AS (SELECT id FROM notification_delivery WHERE status = 'pending' AND next_attempt_at <= now() AND cms_owns(id) ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED)
     UPDATE notification_delivery d SET attempts = d.attempts + 1, next_attempt_at = now() + interval '2 minutes'
       FROM c WHERE d.id = c.id RETURNING d.*`);
  let sent = 0, failed = 0, retry = 0, skipped = 0;
  const work = async (row) => {
    const ch = CHANNELS[row.channel];
    if (!ch.configured()) {
      await pool.query(`UPDATE notification_delivery SET status = 'skipped', last_error = $2 WHERE id = $1`, [row.id, `${row.channel} is not configured (missing: ${ch.problems().join(", ")})`]);
      skipped++; return;
    }
    try {
      const r = await deliver(row);
      await pool.query(`UPDATE notification_delivery SET status = 'sent', sent_at = now(), last_error = NULL, provider = $2, provider_ref = $3 WHERE id = $1`, [row.id, ch.provider(), r.ref || null]);
      sent++;
    } catch (e) {
      const permanent = e instanceof SendError ? e.permanent : false;
      const msg = String(e.message || e).slice(0, 400);
      if (permanent || row.attempts >= o.retryMax) {
        await pool.query(`UPDATE notification_delivery SET status = 'failed', last_error = $2, provider = $3 WHERE id = $1`, [row.id, msg, ch.provider()]);
        failed++;
      } else {
        const wait = Math.min(900, o.retryBaseS * 2 ** (row.attempts - 1));
        await pool.query(`UPDATE notification_delivery SET last_error = $2, provider = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`, [row.id, msg, ch.provider(), wait]);
        retry++;
      }
    }
  };
  for (let i = 0; i < rows.length; i += 5) await Promise.all(rows.slice(i, i + 5).map(work));
  // 3) housekeeping
  await pool.query(`DELETE FROM notification_delivery WHERE status <> 'pending' AND created_at < now() - make_interval(days => $1)`, [o.logDays]);
  if (!rows.length && !old.rowCount) return "nothing to send";
  return `${sent} sent, ${retry} to retry, ${failed} failed, ${skipped} skipped${old.rowCount ? `, ${old.rowCount} too old` : ""}`;
}

/** For the console: what is configured (never the keys), counts, and the latest messages. */
async function status() {
  await providerConfig.fresh();
  const s = await settings.all();
  const { rows: counts } = await pool.query(
    `SELECT channel, status, count(*)::int AS n FROM notification_delivery WHERE created_at > now() - interval '24 hours' GROUP BY 1, 2`);
  const { rows: recent } = await pool.query(
    `SELECT d.id, d.created_at, d.channel, d.recipient, d.kind, d.status, d.attempts, d.last_error, d.sent_at, p.name AS post_name
       FROM notification_delivery d LEFT JOIN rpf_post p ON p.id = d.post_id ORDER BY d.id DESC LIMIT 25`);
  const chan = (name) => ({
    enabled: !!s[`notify_${name}_enabled`],
    provider: CHANNELS[name].provider(),
    configured: CHANNELS[name].configured(),
    missing: CHANNELS[name].configured() ? [] : CHANNELS[name].problems(),
  });
  return { email: chan("email"), sms: chan("sms"), kinds: csv(s.notify_kinds), last_24h: counts, recent };
}

/** "Send a test" button: goes straight to the provider (not through the queue) so the answer is the provider's real answer. */
async function testSend(channel, to) {
  await providerConfig.fresh();
  if (!CHANNELS[channel]) throw new SendError("channel must be 'email' or 'sms'", true);
  const text = `IPVSS test message - if you can read this, ${channel === "email" ? "e-mail" : "SMS"} alerts reach you. ${new Date().toLocaleString()}`;
  return channel === "email" ? email.send({ to, subject: "[IPVSS] test message", text }) : sms.send({ to, text });
}

/** What the "E-mail & SMS" page shows: are the channels ready, and what each post (and the control room) will receive. scope: SQL fragment + params for the posts this user may see. */
async function overview(postRows, isSuper) {
  await providerConfig.fresh();
  const s = await settings.all();
  const ready = (name) => ({ enabled: !!s[`notify_${name}_enabled`], configured: CHANNELS[name].configured(), provider: CHANNELS[name].provider(), missing: CHANNELS[name].configured() ? [] : CHANNELS[name].problems() });
  const sample = compose({ kind: "alert", title: "weapon detected - priority 9 (incident raised)", body: "Example alert text" }, postRows[0] ? postRows[0].name : "Post name");
  return {
    email: ready("email"),
    sms: ready("sms"),
    kinds: csv(s.notify_kinds),
    sms_min_priority: s.notify_sms_min_priority,
    extras: isSuper ? { emails: csv(s.notify_extra_emails), phones: csv(s.notify_extra_phones) } : null,
    sample,
  };
}

/** Put messages that FAILED in the last 24 h back in the queue (after you fixed the key / provider). They are dated now, so they are not dropped as too old. */
async function retryFailed() {
  const r = await pool.query(
    `UPDATE notification_delivery SET status = 'pending', attempts = 0, next_attempt_at = now(), created_at = now(), last_error = NULL
      WHERE status = 'failed' AND created_at > now() - interval '24 hours'`);
  setTimeout(() => { try { require("./jobs").kick("notify_outbox"); } catch (_) { /* jobs not started */ } }, 500).unref();
  return r.rowCount;
}

module.exports = { enqueue, processQueue, status, testSend, compose, overview, retryFailed };
