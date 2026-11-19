const nodemailer = require("nodemailer");
const config = require("../../config");
const { SendError } = require("./sendError");

/**
 * E-mail over SMTP. Works with any free provider that offers SMTP (Brevo, Gmail with an app password, Zoho, Outlook, Mailgun, ...):
 * host, port, login and sender all come from config/notify.conf - nothing is defaulted here.
 */
const cfg = () => config.outbound.email;

function problems() {
  const c = cfg();
  const p = [];
  if (c.provider !== "smtp") return ["EMAIL_PROVIDER is not 'smtp'"];
  if (!c.host) p.push("SMTP_HOST");
  if (!c.port) p.push("SMTP_PORT");
  if (!c.from) p.push("EMAIL_FROM");
  if (c.user && !c.password) p.push("SMTP_PASSWORD");
  if (!["starttls", "ssl", "none"].includes(c.secure)) p.push("SMTP_SECURE (starttls, ssl or none)");
  return p;
}
const configured = () => problems().length === 0;

let cached = null;
let cachedKey = "";
function transport() {
  const c = cfg();
  const key = JSON.stringify([c.host, c.port, c.secure, c.user, c.password, config.outbound.timeoutS]);
  if (cached && key === cachedKey) return cached;
  const ms = config.outbound.timeoutS * 1000;
  cached = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure === "ssl", // true = TLS from the first byte (usually port 465)
    requireTLS: c.secure === "starttls", // upgrade with STARTTLS or refuse to send (never send a password in clear)
    ignoreTLS: c.secure === "none",
    auth: c.user ? { user: c.user, pass: c.password } : undefined,
    connectionTimeout: ms,
    greetingTimeout: ms,
    socketTimeout: ms,
  });
  cachedKey = key;
  return cached;
}

const isEmail = (s) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(s || "").trim());

async function send({ to, subject, text }) {
  if (!configured()) throw new SendError(`e-mail is not configured (missing: ${problems().join(", ")})`, true);
  if (!isEmail(to)) throw new SendError(`'${to}' is not a valid e-mail address`, true);
  try {
    const info = await transport().sendMail({ from: cfg().from, to: String(to).trim(), subject, text });
    return { ref: info.messageId || "" };
  } catch (e) {
    // wrong login / rejected recipient or sender = permanent; network trouble, greylisting (4xx) = try again later
    const code = Number(e.responseCode) || 0;
    const permanent = e.code === "EAUTH" || e.code === "EREQUIRETLS" || (code >= 500 && code < 600);
    throw new SendError(`${e.code || "SMTP"}: ${e.response || e.message}`.slice(0, 400), permanent);
  }
}

module.exports = { send, configured, problems, isEmail, provider: () => "smtp" };
