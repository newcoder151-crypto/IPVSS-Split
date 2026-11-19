/**
 * E-mail / SMS channel unit tests. No database, no real provider: the SMS gateways are a local HTTP server.
 *   node --test test/outbound.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");

let gw, base;
const seen = [];
test.before(async () => {
  gw = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: b });
      const send = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url.startsWith("/f2s")) return req.headers.authorization === "KEY" ? send(200, { return: true, request_id: "r1" }) : send(401, { return: false, message: "Invalid Authentication" });
      if (req.url.includes("/Messages.json")) return send(201, { sid: "SM1" });
      send(404, {});
    });
  });
  await new Promise((r) => gw.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${gw.address().port}`;
});
test.after(() => gw.close());

function fresh(env) {
  for (const k of Object.keys(process.env)) if (/^(EMAIL_|SMTP_|SMS_|FAST2SMS_|TWILIO_|NOTIFY_)/.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  for (const k of Object.keys(require.cache)) if (/backend[\\/]src[\\/](config|services[\\/]channels)/.test(k)) delete require.cache[k];
  return { sms: require("../backend/src/services/channels/smsChannel"), email: require("../backend/src/services/channels/emailChannel") };
}

test("phone numbers are normalised with the default country code", () => {
  const { sms } = fresh({ SMS_DEFAULT_COUNTRY_CODE: "91" });
  assert.strictEqual(sms.normalizePhone("9876543210"), "919876543210");
  assert.strictEqual(sms.normalizePhone("098765 43210"), "919876543210");
  assert.strictEqual(sms.normalizePhone("+91 98765-43210"), "919876543210");
  assert.strictEqual(sms.normalizePhone("0091 9876543210"), "919876543210");
  assert.strictEqual(sms.normalizePhone("+14155550123"), "14155550123");
  assert.strictEqual(sms.normalizePhone("12"), null);
  assert.strictEqual(sms.normalizePhone(""), null);
});

test("e-mail addresses are validated", () => {
  const { email } = fresh({});
  assert.ok(email.isEmail("a@b.in"));
  assert.ok(!email.isEmail("bad@"));
  assert.ok(!email.isEmail("two@a.in,three@b.in"));
});

test("nothing is configured by default", () => {
  const { sms, email } = fresh({});
  assert.ok(!sms.configured() && !email.configured());
  assert.ok(email.problems().length && sms.problems().length);
});

test("Fast2SMS: quick route request, 10-digit Indian number; wrong key is a permanent error", async () => {
  const { sms } = fresh({ SMS_PROVIDER: "fast2sms", SMS_DEFAULT_COUNTRY_CODE: "91", FAST2SMS_API_URL: base + "/f2s", FAST2SMS_API_KEY: "KEY" });
  assert.ok(sms.configured());
  const r = await sms.send({ to: "+91 98765 43210", text: "hello" });
  assert.strictEqual(r.ref, "r1");
  const b = JSON.parse(seen.at(-1).body);
  assert.deepStrictEqual([b.route, b.numbers, b.message], ["q", "9876543210", "hello"]);
  await assert.rejects(sms.send({ to: "+14155550123", text: "x" }), (e) => e.permanent && /Indian/.test(e.message));
  const bad = fresh({ SMS_PROVIDER: "fast2sms", SMS_DEFAULT_COUNTRY_CODE: "91", FAST2SMS_API_URL: base + "/f2s", FAST2SMS_API_KEY: "WRONG" }).sms;
  await assert.rejects(bad.send({ to: "9876543210", text: "x" }), (e) => e.permanent && /Invalid Authentication/.test(e.message));
});

test("Fast2SMS: the DLT route needs sender id and template id", () => {
  const { sms } = fresh({ SMS_PROVIDER: "fast2sms", FAST2SMS_API_URL: base, FAST2SMS_API_KEY: "KEY", FAST2SMS_ROUTE: "dlt" });
  assert.deepStrictEqual(sms.problems(), ["FAST2SMS_SENDER_ID", "FAST2SMS_DLT_TEMPLATE_ID"]);
});

test("Twilio: form request with basic auth and E.164 number", async () => {
  const { sms } = fresh({ SMS_PROVIDER: "twilio", SMS_DEFAULT_COUNTRY_CODE: "91", TWILIO_API_URL: base + "/tw", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+15005550006" });
  assert.strictEqual((await sms.send({ to: "9876543210", text: "hi" })).ref, "SM1");
  const s = seen.at(-1);
  assert.strictEqual(s.url, "/tw/Accounts/AC1/Messages.json");
  assert.strictEqual(s.auth, "Basic " + Buffer.from("AC1:tok").toString("base64"));
  const f = Object.fromEntries(new URLSearchParams(s.body));
  assert.deepStrictEqual([f.To, f.From, f.Body], ["+919876543210", "+15005550006", "hi"]);
});

test("message text: SMS is shortened, e-mail carries the post and the link", () => {
  fresh({ SMS_MAX_CHARS: "60", NOTIFY_RPF_URL: "http://rpf.example" });
  const { compose } = require("../backend/src/services/outbound");
  const m = compose({ title: "weapon detected - priority 9", body: "x".repeat(200) }, "Post A");
  assert.ok(m.sms.length <= 60 && m.sms.endsWith("…"));
  assert.match(m.text, /Post: Post A/);
  assert.match(m.text, /Open the RPF dashboard: http:\/\/rpf\.example/);
  assert.match(m.subject, /^\[IPVSS\] weapon detected/);
});
