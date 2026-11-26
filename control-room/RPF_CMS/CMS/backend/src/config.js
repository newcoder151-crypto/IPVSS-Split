require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const int = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const str = (name) => String(process.env[name] || "").trim();
const flag = (name) => ["1", "true", "yes", "on"].includes(str(name).toLowerCase());
const list = (name) => str(name).split(/[\s,;]+/).filter(Boolean);

// Session hours: 0 (the default) = a console session never expires. A positive number = hours (renewed while the console is in use).
const hours = (name, dflt) => {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return dflt;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};

let jwtSecret = process.env.CMS_JWT_SECRET || process.env.JWT_SECRET || "";
let ephemeralSecret = false;
if (jwtSecret.length < 32) {
  // No secret configured: generate one ONCE and keep it in a file, so a restart does not log everybody out.
  const secretFile = path.resolve(
    process.env.JWT_SECRET_FILE || path.join(__dirname, "..", "..", "data", "jwt-secret"),
  );
  try {
    const saved = fs.readFileSync(secretFile, "utf8").trim();
    if (saved.length >= 32) jwtSecret = saved;
  } catch (_) {
    /* first start: no file yet */
  }
  if (jwtSecret.length < 32) {
    jwtSecret = crypto.randomBytes(48).toString("hex");
    try {
      fs.mkdirSync(path.dirname(secretFile), { recursive: true });
      fs.writeFileSync(secretFile, jwtSecret + "\n", { mode: 0o600 });
    } catch (_) {
      ephemeralSecret = true; // folder not writable: sessions end at restart (warned at start-up)
    }
  }
}

module.exports = {
  version: "0.3.0",
  // Several CMS find each other by themselves (services/directory.js). The port, the key and the other values come from
  // config/control-room.conf through start.sh - nothing is defaulted here.
  discovery: {
    enabled: !["off", "no", "0", "false"].includes(str("CMS_DISCOVERY").toLowerCase()),
    port: process.env.CMS_DISCOVERY_PORT ? Number(process.env.CMS_DISCOVERY_PORT) : undefined,
    key: str("CMS_CLUSTER_KEY"),
    seeds: list("CMS_SEED_URLS"),
    broadcast: list("CMS_DISCOVERY_BROADCAST"),
    publicUrl: str("CMS_PUBLIC_URL"),
    name: str("CMS_NODE_NAME"),
    location: str("CMS_NODE_LOCATION"),
  },
  // Hosts, ports and database names are NOT defaulted here: config/control-room.conf is the one place, start.sh hands them over (see main() in server.js).
  port: process.env.PORT ? Number(process.env.PORT) : undefined,
  // If the port is taken, try the next ones (development). Off in production, or with PORT_AUTO=0.
  portAuto: process.env.PORT_AUTO === "1", // off unless asked for: the port is fixed (config/control-room.conf), the server never wanders to port+1
  env: process.env.NODE_ENV || "development",
  db: {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  },
  jwtSecret,
  ephemeralSecret,
  sessionHours: hours("SESSION_LIMIT_HOURS", 0), // 0 = never expires; the old SESSION_HOURS setting is ignored on purpose
  // Footage store (object-storage stand-in). Shared with the RPF server, which reads delivered
  // footage and archived clips from the same root.
  mediaRoot: path.resolve(
    process.env.MEDIA_ROOT || path.join(__dirname, "..", "..", "media"),
  ),
  footageLinkMinutes: int("FOOTAGE_LINK_MINUTES", 15),
  workers: process.env.CMS_WORKERS !== "0",
  // Defaults for runtime settings (the console overrides them in the `setting` table).
  defaults: {
    priority_threshold: int("PRIORITY_THRESHOLD", 7), // >= : auto-dispatch to nearest post + incident
    escalation_minutes: int("ESCALATION_MINUTES", 10), // unacknowledged this long -> next post
    low_priority_mode: ["auto_deliver", "operator_queue"].includes(
      process.env.LOW_PRIORITY_MODE,
    )
      ? process.env.LOW_PRIORITY_MODE
      : "auto_deliver", // alerts below the threshold: deliver to the nearest post, or hold for an operator
    request_max_window_min: int("MAX_REQUEST_WINDOW_MIN", 240),
    retention_days: int("RETENTION_DAYS", 30), // 30-day FIFO on raw segments
    request_expiry_days: int("REQUEST_EXPIRY_DAYS", 0), // 0 = never: a request waits for its NVR however long it takes (>0 = give up after this many days)
    nvr_offline_after_s: int("NVR_OFFLINE_AFTER_S", 60),
    auto_approve_requests: process.env.AUTO_APPROVE_REQUESTS === "1",
    auto_enroll_nvr: process.env.AUTO_ENROLL_NVR !== "0", // a new M-NVR that connects is added to the fleet by itself
    reenrol_removed_nvr: process.env.NVR_RESTORE_REMOVED !== "0", // a removed M-NVR that is still running comes back by itself (e.g. deleted by mistake)
    retention_auto: process.env.RETENTION_AUTO !== "0",
    notify_webhook_url: process.env.NOTIFY_WEBHOOK_URL || "",
    // E-mail / SMS for alerts (provider + keys: config/notify.conf -> environment; these are only the on/off switches and the rules)
    notify_email_enabled: flag("NOTIFY_EMAIL_ENABLED"),
    notify_sms_enabled: flag("NOTIFY_SMS_ENABLED"),
    notify_kinds: str("NOTIFY_KINDS") || "alert,incident", // which notifications also go out by e-mail / SMS
    notify_sms_min_priority: int("NOTIFY_SMS_MIN_PRIORITY", 1), // alerts below this priority are e-mailed but not texted
    notify_extra_emails: str("NOTIFY_EXTRA_EMAILS"), // control-room addresses that receive every outgoing notification
    notify_extra_phones: str("NOTIFY_EXTRA_PHONES"),
  },
  // Outgoing channels. Nothing is defaulted here (no hosts, ports, URLs or keys): they all come from config/notify.conf.
  outbound: {
    email: {
      provider: str("EMAIL_PROVIDER").toLowerCase(), // smtp | none
      host: str("SMTP_HOST"),
      port: Number(str("SMTP_PORT")) || undefined,
      secure: str("SMTP_SECURE").toLowerCase() || "starttls", // starttls | ssl | none
      user: str("SMTP_USER"),
      password: process.env.SMTP_PASSWORD || "",
      from: str("EMAIL_FROM"),
    },
    sms: {
      provider: str("SMS_PROVIDER").toLowerCase(), // fast2sms | twilio | none
      defaultCountryCode: str("SMS_DEFAULT_COUNTRY_CODE").replace(/\D/g, ""),
      maxChars: int("SMS_MAX_CHARS", 300),
      fast2sms: {
        url: str("FAST2SMS_API_URL"),
        key: process.env.FAST2SMS_API_KEY || "",
        route: str("FAST2SMS_ROUTE") || "q", // q = Quick SMS (no DLT), dlt = your approved DLT template
        senderId: str("FAST2SMS_SENDER_ID"),
        templateId: str("FAST2SMS_DLT_TEMPLATE_ID"),
      },
      twilio: {
        url: str("TWILIO_API_URL"),
        sid: str("TWILIO_ACCOUNT_SID"),
        token: process.env.TWILIO_AUTH_TOKEN || "",
        from: str("TWILIO_FROM"),
        messagingServiceSid: str("TWILIO_MESSAGING_SERVICE_SID"),
      },
    },
    timeoutS: int("NOTIFY_TIMEOUT_S", 15),
    retryMax: int("NOTIFY_RETRY_MAX", 6), // attempts per message (network trouble / gateway busy)
    retryBaseS: int("NOTIFY_RETRY_BASE_S", 20), // wait before the 2nd attempt; doubles each time (max 15 min)
    maxAgeMin: int("NOTIFY_MAX_AGE_MIN", 120), // a message older than this is dropped, not sent late (an alert from hours ago would mislead)
    logDays: int("NOTIFY_LOG_DAYS", 90), // keep the delivery log this long
    linkBase: str("NOTIFY_RPF_URL"), // optional: shown at the end of e-mails ("open the RPF dashboard"); start.sh fills it in
  },
  // Optional shared secret a new M-NVR must present (header X-Enroll-Key) to enrol itself. Empty = any unit that can reach the CMS may enrol.
  nvrEnrollKey: process.env.NVR_ENROLL_KEY || "",
  // Test lab in the console (send alerts as an NVR, put a train in a tunnel). On in development, off in production.
  devTools: process.env.DEV_TOOLS
    ? process.env.DEV_TOOLS === "1"
    : process.env.NODE_ENV !== "production",
  // Where the M-NVR simulator looks for its offline flags (must match the simulator's SIM_DIR / CMS/run).
  simDir: path.resolve(
    process.env.SIM_DIR || path.join(__dirname, "..", "..", "run"),
  ),
  ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobe: process.env.FFPROBE_PATH || "ffprobe",
  legacyApi: process.env.LEGACY_API
    ? process.env.LEGACY_API === "1"
    : process.env.NODE_ENV !== "production",
};
