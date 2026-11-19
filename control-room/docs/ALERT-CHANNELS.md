# E-mail and SMS for alerts

Alerts, incidents and (optionally) request / footage / evidence notices are still shown in the RPF dashboard exactly as before.
With this feature they are **also e-mailed and/or texted**:

* to the **alert e-mail / alert mobile of the RPF post** that receives the alert (so when an alert escalates to the next post, that post is told), and
* to **control-room recipients** you list once in the CMS console (copy of everything, optional).

Nothing about the in-app alerts depends on it: if the internet is down or a provider refuses, the alert still arrives in the dashboard.

## 1. Set it up - all on one page (10 minutes)

Open the CMS console as **super admin** -> menu **Administration -> E-mail & SMS**. The page has a checklist at the top that turns green as you go.

### Step 1 - Connect a provider (once)

**E-mail** (free options: Brevo - 300 e-mails/day, no expiry; or Gmail)

1. Create the free account at your provider and get the SMTP login:
   * **Brevo:** Brevo -> *SMTP & API* -> SMTP: login = your Brevo e-mail, password = the **SMTP key**; verify a sender address.
   * **Gmail:** turn on 2-step verification, then Google account -> Security -> **App passwords**; use that 16-letter password (not your normal one).
2. On the page, card **E-mail provider**: pick **Brevo** or **Gmail** in the *Provider* list - the server and port fill in by themselves.
3. Type your **Login**, **Password** and **Sender** (Gmail: your Gmail address; Brevo: the verified sender). Press **Save**.
4. In *Test message to* type your own e-mail address and press **Send test**. Check the inbox (and spam). If it fails, the page shows the provider's own reason.

**SMS** (India: Fast2SMS; anywhere: Twilio)

1. **Fast2SMS:** sign up at fast2sms.com (free credit, then a small recharge), copy the **API key** from *Dev API*.
   **Twilio:** copy *Account SID*, *Auth token* and your Twilio number from the Twilio console (a free trial texts only numbers you verified there).
2. Card **SMS provider**: pick the provider, paste the key (Fast2SMS) or SID / token / number (Twilio), press **Save**.
   Fast2SMS route **q** = Quick SMS (no DLT registration needed). Keys are write-only: once saved the field only says "saved".
3. *Test message to*: type your mobile number (e.g. `+91 98765 43210`) and press **Send test**.

### Step 2 - Say who receives the alerts

Table **2. Who receives the alerts**: one row per RPF post. Type the post's **Alert e-mail** and **Alert mobile** and press **Save** on that row.

* **Alerts for a post go to that post's e-mail and mobile.** If an alert is escalated to another post, that post's contacts are used.
* Leave a field empty = nothing is sent on that channel for that post.
* The column *What will happen* tells you, per row, whether it will be sent or why not ("no contact", "switched off", "provider not connected").
* **Control-room copies:** e-mail addresses / mobile numbers that receive a copy of **every** message (supervisors, duty officer). Comma separated.
* Zone admins can fill the contacts of the posts in their own zone; only super admins see providers, rules and the log.

### Step 3 - Switch on and choose the rules

Card **3. Rules** (super admin): tick **Send e-mail** and/or **Send SMS**; choose which messages go out (new alerts, incidents, request updates, footage, evidence);
optionally *SMS only for alerts of priority N or higher* (lower ones are still e-mailed). Press **Save rules**. Takes effect immediately.
The card also shows what an e-mail / SMS looks like.

Then trigger an alert (or press **Send test**) and look at the **Delivery log** at the bottom of the page: every message, status, tries and error.
**Retry failed (last 24 h)** sends failed ones again after you fixed the key.

### Optional: file instead of page

`config/notify.conf` holds the same settings as defaults (useful for scripted installs). A value saved on the page **wins** over the file. Gateway
addresses (Fast2SMS / Twilio URLs) and the provider presets of the form (`config/notify-presets.json`) are only in those files - edit them there,
then `bash run-offline.sh restart`.

## 2. What the rules mean

| Setting | Meaning |
|---|---|
| Send e-mail / Send SMS | master switch per channel |
| Which messages go out | `alert, incident` by default; add `request`, `footage`, `evidence` if wanted |
| SMS only for priority >= N | lower-priority alerts are e-mailed but not texted (SMS costs money) |
| Control-room copies | get a copy of every outgoing message |

## 3. How delivery works (and what happens offline)

1. The CMS writes the in-app notification and, **in the same database transaction**, one row per recipient into `notification_delivery` (the outbox).
   So a cancelled / rolled-back alert sends nothing, and a slow provider can never delay an alert.
2. The CMS job **notify_outbox** (every 10 s, and right after an alert) sends the rows. A network or gateway problem is retried with growing waits
   (`NOTIFY_RETRY_BASE_S`, doubling, up to `NOTIFY_RETRY_MAX` tries). A wrong key, an unknown recipient or an invalid number fails at once.
3. **No internet at the control room?** Messages wait and go out as soon as the connection returns - but a message older than `NOTIFY_MAX_AGE_MIN`
   (default 120 min) is **dropped instead of arriving late**, because an hours-old alert would mislead.
4. Every message is logged: **CMS console -> Administration -> E-mail & SMS -> Delivery log** (time, channel, recipient, status, tries, provider error). Kept `NOTIFY_LOG_DAYS` days.

Sending e-mail / SMS needs the provider to be reachable (normally the internet). Everything else in the offline package works without it.

## 4. Troubleshooting

| Symptom | Look at |
|---|---|
| Provider shows "not connected" | the line "Still missing: ..." on the provider card: fill those fields and press Save |
| "Send test" fails | the message shown is the provider's own: `Invalid Authentication` (wrong key), `535` (wrong SMTP login / app password), `550` (sender or recipient refused), `Indian mobile numbers only` (Fast2SMS) |
| Nothing arrives, status `sent` | spam folder (Brevo/Gmail senders you did not verify); for SMS the number is on DND or the provider needs DLT for that route |
| Stays `pending` | the provider is unreachable (no internet / firewall for the SMTP port); it retries by itself; see the Detail column |
| `skipped` | the channel was turned off or unconfigured when the message was due |
| An alert did not produce any row | the post has no alert e-mail / mobile, the notice type is not in "Which notices go out", the channel is off, or (SMS) the priority is below the minimum |

## 5. What this feature changed (for developers)

| File | Change |
|---|---|
| `config/notify.conf`, `config/notify-presets.json` | new: default provider settings / keys / rules (read by `start.sh`; environment wins), and the presets of the console form |
| `RPF_CMS/CMS/sql/migrations/008_notify_provider_config.sql` | table for provider logins entered on the console page (secrets are write-only; not readable by the RPF role) |
| `.../services/providerConfig.js` | merges file defaults with the values saved on the page |
| `.../public/js/admin.js`, `boot.js` | new page **Administration -> E-mail & SMS** (`V.notify`), menu entry |
| `start.sh` | `load_notify_conf` exports the `EMAIL_* SMTP_* SMS_* FAST2SMS_* TWILIO_* NOTIFY_*` keys to CMS and fills `NOTIFY_RPF_URL` |
| `RPF_CMS/CMS/sql/migrations/007_alert_channels.sql` | `rpf_post.alert_email / alert_phone`, table `notification_delivery` |
| `.../services/outbound.js` | outbox: enqueue (same transaction, savepoint-guarded), worker, status, test send |
| `.../services/channels/{emailChannel,smsChannel,sendError}.js` | SMTP (nodemailer), Fast2SMS, Twilio |
| `.../services/notify.js`, `incidentService.js`, `jobs.js`, `settings.js`, `config.js` | hook into every notification; alert priority passed along; `notify_outbox` job; new settings |
| `.../routes/console/admin.js` | post contact fields + validation; `GET /notify/overview` (admin), `GET/PUT /notify/config`, `GET /notify/status`, `POST /notify/test`, `POST /notify/retry` (super admin) |
| `RPF_CMS/CMS/backend/package.json` (+ lock, `node_modules/nodemailer`) | new dependency `nodemailer` (no further dependencies) |
| `RPF_CMS/CMS/test/outbound.test.js` | unit tests (`node --test test/outbound.test.js`) |

The provider logins entered on the page are kept in the CMS database (table `notify_provider_config`), readable only by the CMS database role; no API returns them.
Do not name a new file `mailer.js`, `emails.js` or `mail.env`: `start.sh` deletes those (left over from an earlier feature).
