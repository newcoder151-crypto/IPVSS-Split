const config = require("../../config");
const { SendError } = require("./sendError");

/**
 * SMS through an HTTP gateway chosen in config/notify.conf (SMS_PROVIDER):
 *   fast2sms - India. Free credit on sign-up; "Quick SMS" route (q) needs no DLT registration, "dlt" uses your approved template.
 *   twilio   - worldwide. A free trial sends only to numbers you verified in the Twilio console.
 * Gateway URLs and keys come from the configuration - nothing is defaulted here.
 */
const cfg = () => config.outbound.sms;
const provider = () => cfg().provider;

function problems() {
  const c = cfg();
  const p = [];
  if (c.provider === "fast2sms") {
    if (!c.fast2sms.url) p.push("FAST2SMS_API_URL");
    if (!c.fast2sms.key) p.push("FAST2SMS_API_KEY");
    if (!["q", "dlt"].includes(c.fast2sms.route)) p.push("FAST2SMS_ROUTE (q or dlt)");
    if (c.fast2sms.route === "dlt") {
      if (!c.fast2sms.senderId) p.push("FAST2SMS_SENDER_ID");
      if (!c.fast2sms.templateId) p.push("FAST2SMS_DLT_TEMPLATE_ID");
    }
  } else if (c.provider === "twilio") {
    if (!c.twilio.url) p.push("TWILIO_API_URL");
    if (!c.twilio.sid) p.push("TWILIO_ACCOUNT_SID");
    if (!c.twilio.token) p.push("TWILIO_AUTH_TOKEN");
    if (!c.twilio.from && !c.twilio.messagingServiceSid) p.push("TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID)");
  } else return ["SMS_PROVIDER is not 'fast2sms' or 'twilio'"];
  return p;
}
const configured = () => problems().length === 0;

/** Any way a number is written -> digits with country code (no '+'), or null. 98xxxxxx10 / 098.. / +91 98.. / 0091 98.. */
function normalizePhone(raw) {
  let d = String(raw || "").replace(/[^\d+]/g, "");
  if (!d) return null;
  const cc = cfg().defaultCountryCode;
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (cc) {
    d = d.replace(/^0+/, "");
    if (!d.startsWith(cc) || d.length <= 10) d = cc + d; // national number without the country code
  }
  return /^\d{8,15}$/.test(d) ? d : null;
}
const isPhone = (s) => normalizePhone(s) !== null;

async function http(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(config.outbound.timeoutS * 1000) });
  } catch (e) {
    throw new SendError(`${e.name === "TimeoutError" ? "timeout" : "network"}: ${e.cause && e.cause.code ? e.cause.code : e.message}`.slice(0, 300), false);
  }
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch (_) { /* not JSON */ }
  return { res, json, raw };
}

async function viaFast2sms(num, text) {
  const c = cfg().fast2sms;
  const national = num.startsWith("91") && num.length === 12 ? num.slice(2) : null;
  if (!national) throw new SendError(`Fast2SMS sends to Indian mobile numbers only (got +${num})`, true);
  const body = c.route === "dlt"
    ? { route: "dlt", sender_id: c.senderId, message: c.templateId, variables_values: text.replace(/\|/g, "/"), numbers: national, flash: 0 }
    : { route: "q", message: text, language: /[^\x00-\x7f]/.test(text) ? "unicode" : "english", numbers: national, flash: 0 };
  const { res, json, raw } = await http(c.url, {
    method: "POST",
    headers: { authorization: c.key, "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify(body),
  });
  if (res.ok && json && json.return === true) return { ref: String(json.request_id || "") };
  const why = (json && (Array.isArray(json.message) ? json.message.join(" ") : json.message)) || raw.slice(0, 200) || `HTTP ${res.status}`;
  throw new SendError(`Fast2SMS: ${why}`.slice(0, 300), res.status >= 400 && res.status < 500 && res.status !== 429);
}

async function viaTwilio(num, text) {
  const c = cfg().twilio;
  const form = new URLSearchParams({ To: `+${num}`, Body: text });
  if (c.messagingServiceSid) form.set("MessagingServiceSid", c.messagingServiceSid);
  else form.set("From", c.from);
  const { res, json, raw } = await http(`${c.url.replace(/\/+$/, "")}/Accounts/${encodeURIComponent(c.sid)}/Messages.json`, {
    method: "POST",
    headers: { authorization: "Basic " + Buffer.from(`${c.sid}:${c.token}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (res.ok && json && json.sid) return { ref: json.sid };
  const why = (json && json.message) || raw.slice(0, 200) || `HTTP ${res.status}`;
  throw new SendError(`Twilio${json && json.code ? " " + json.code : ""}: ${why}`.slice(0, 300), res.status >= 400 && res.status < 500 && res.status !== 429);
}

async function send({ to, text }) {
  if (!configured()) throw new SendError(`SMS is not configured (missing: ${problems().join(", ")})`, true);
  const num = normalizePhone(to);
  if (!num) throw new SendError(`'${to}' is not a valid mobile number (use +<country code><number>, or set SMS_DEFAULT_COUNTRY_CODE)`, true);
  return provider() === "twilio" ? viaTwilio(num, text) : viaFast2sms(num, text);
}

module.exports = { send, configured, problems, normalizePhone, isPhone, provider };
