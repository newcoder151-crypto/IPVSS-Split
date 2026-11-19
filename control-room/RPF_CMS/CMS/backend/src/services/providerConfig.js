const { pool } = require("../db");
const config = require("../config");

/**
 * E-mail / SMS provider settings. Two sources, merged:
 *   1. config/notify.conf (-> environment -> config.outbound)   the defaults
 *   2. table notify_provider_config, written from the CMS console page "E-mail & SMS"   wins over the file
 * The channels read config.outbound on every send, so applying an override simply rewrites those fields in place.
 * Secrets are write-only: view() says whether one is set, never what it is.
 */
const FIELDS = {
  EMAIL_PROVIDER: { path: ["email", "provider"], type: "choice", options: ["none", "smtp"] },
  SMTP_HOST: { path: ["email", "host"], type: "text", max: 200 },
  SMTP_PORT: { path: ["email", "port"], type: "port" },
  SMTP_SECURE: { path: ["email", "secure"], type: "choice", options: ["starttls", "ssl", "none"] },
  SMTP_USER: { path: ["email", "user"], type: "text", max: 200 },
  SMTP_PASSWORD: { path: ["email", "password"], type: "text", max: 300, secret: true },
  EMAIL_FROM: { path: ["email", "from"], type: "text", max: 200 },
  SMS_PROVIDER: { path: ["sms", "provider"], type: "choice", options: ["none", "fast2sms", "twilio"] },
  SMS_DEFAULT_COUNTRY_CODE: { path: ["sms", "defaultCountryCode"], type: "digits", max: 4 },
  FAST2SMS_API_KEY: { path: ["sms", "fast2sms", "key"], type: "text", max: 300, secret: true },
  FAST2SMS_ROUTE: { path: ["sms", "fast2sms", "route"], type: "choice", options: ["q", "dlt"] },
  FAST2SMS_SENDER_ID: { path: ["sms", "fast2sms", "senderId"], type: "text", max: 50 },
  FAST2SMS_DLT_TEMPLATE_ID: { path: ["sms", "fast2sms", "templateId"], type: "text", max: 50 },
  TWILIO_ACCOUNT_SID: { path: ["sms", "twilio", "sid"], type: "text", max: 100 },
  TWILIO_AUTH_TOKEN: { path: ["sms", "twilio", "token"], type: "text", max: 300, secret: true },
  TWILIO_FROM: { path: ["sms", "twilio", "from"], type: "text", max: 50 },
  TWILIO_MESSAGING_SERVICE_SID: { path: ["sms", "twilio", "messagingServiceSid"], type: "text", max: 100 },
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const BASE = { email: clone(config.outbound.email), sms: clone(config.outbound.sms) }; // what the file / environment said at start
const getAt = (root, path) => path.reduce((o, k) => (o ? o[k] : undefined), root);
function setAt(root, path, v) {
  let o = root;
  for (const k of path.slice(0, -1)) o = o[k];
  o[path[path.length - 1]] = v;
}

let overrides = new Map();
let loadedAt = 0;
const TTL_MS = 3000;

function apply() {
  for (const [key, f] of Object.entries(FIELDS)) {
    const root = f.path[0] === "email" ? config.outbound.email : config.outbound.sms;
    const sub = f.path.slice(1);
    const base = getAt(f.path[0] === "email" ? BASE.email : BASE.sms, sub);
    let v = base;
    if (overrides.has(key)) {
      v = overrides.get(key);
      if (f.type === "port") v = Number(v) || undefined;
    }
    setAt(root, sub, v);
  }
}

/** Reload the console-entered values (at most every few seconds) and apply them. Never throws: the file values stay in force if the table is unreadable. */
async function fresh(force = false) {
  if (!force && Date.now() - loadedAt < TTL_MS) return;
  try {
    const { rows } = await pool.query("SELECT key, value FROM notify_provider_config");
    overrides = new Map(rows.filter((r) => FIELDS[r.key]).map((r) => [r.key, r.value]));
    apply();
    loadedAt = Date.now();
  } catch (e) {
    console.warn("notify provider config not loaded:", e.message);
  }
}

function clean(key, raw) {
  const f = FIELDS[key];
  const s = String(raw == null ? "" : raw).trim();
  if (f.type === "choice") {
    const v = s.toLowerCase();
    if (!f.options.includes(v)) throw new Error(`${key}: choose one of ${f.options.join(", ")}`);
    return v;
  }
  if (f.type === "port") {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${key}: a port number (1-65535)`);
    return String(n);
  }
  if (f.type === "digits") {
    if (!/^\d{1,4}$/.test(s)) throw new Error(`${key}: digits only (e.g. 91)`);
    return s;
  }
  if (s.length > f.max) throw new Error(`${key} is too long`);
  return s;
}

/** values: {KEY: text}. A blank SECRET keeps the saved one; a blank other field goes back to the config-file value. clear: [KEY] removes a console value. */
async function save(values, clear, userId) {
  const changed = [];
  for (const [key, raw] of Object.entries(values || {})) {
    const f = FIELDS[key];
    if (!f) throw new Error(`unknown setting '${key}'`);
    const blank = String(raw == null ? "" : raw).trim() === "";
    if (blank) {
      if (f.secret) continue; // keep the saved secret
      await pool.query("DELETE FROM notify_provider_config WHERE key = $1", [key]);
      changed.push(key);
      continue;
    }
    const v = clean(key, raw);
    await pool.query(
      `INSERT INTO notify_provider_config (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, v, userId || null]);
    changed.push(key);
  }
  for (const key of clear || []) {
    if (!FIELDS[key]) continue;
    await pool.query("DELETE FROM notify_provider_config WHERE key = $1", [key]);
    changed.push(key);
  }
  await fresh(true);
  return changed;
}

/** For the console form: values of non-secret fields, and only "set / not set" for secrets. */
function view() {
  return Object.entries(FIELDS).map(([key, f]) => {
    const cur = getAt(f.path[0] === "email" ? config.outbound.email : config.outbound.sms, f.path.slice(1));
    const isSet = cur !== undefined && cur !== null && String(cur) !== "";
    return {
      key,
      type: f.type,
      options: f.options || null,
      secret: !!f.secret,
      set: isSet,
      value: f.secret ? "" : isSet ? String(cur) : "",
      source: overrides.has(key) ? "console" : isSet ? "file" : "none",
    };
  });
}

module.exports = { FIELDS, fresh, save, view };
