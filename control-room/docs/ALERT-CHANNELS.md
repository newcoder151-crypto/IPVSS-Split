# E-mail and SMS for alerts

Alerts, incidents and (optionally) request / footage / evidence notices are still shown in the RPF dashboard exactly as before.
With this feature they are **also e-mailed and/or texted**:

* to the **alert e-mail / alert mobile of the RPF post** that receives the alert (so when an alert escalates to the next post, that post is told), and
* to **control-room recipients** you list once in the CMS console (copy of everything, optional).

Nothing about the in-app alerts depends on it: if the internet is down or a provider refuses, the alert still arrives in the dashboard.

## 1. Set it up - all on one page (10 minutes)

Open the CMS console as **super admin** -> menu **Administration -> E-mail & SMS**. At the top, three boxes (**Connect**, **Add contacts**, **Switch on**)
turn green as you finish each step. Only the essential boxes are shown; technical ones are folded away under **Advanced** / **More options**.

### Step 1 - Connect a service to send messages (once)

**E-mail** (free options: Brevo - 300 e-mails/day, no expiry; or Gmail)

1. Create the free account and get the login:
   * **Brevo:** Brevo -> *SMTP & API* -> SMTP: login = your Brevo e-mail, password = the **SMTP key**; verify a sender address.
   * **Gmail:** Gmail no longer accepts your normal password for sending (error `535-5.7.8 Username and Password not accepted`). First turn on **2-Step Verification** (Google account -> Security; the *App passwords* option does not exist until it is on), then open myaccount.google.com/apppasswords, create one named IPVSS and use those 16 letters as the password. Tip: use a separate Gmail account just for alerts. If you do not want 2-Step Verification, use Brevo instead.
2. In the **E-mail** card choose **Brevo** or **Gmail** under *E-mail service* - the server and port fill in by themselves and a short help text appears.
3. Type **Login**, **Password or key** and **Send e-mails from** (Gmail: your Gmail address; Brevo: the verified sender). Press **Save**.
4. The card now says **Connected**. Under *Check that it works* type your own e-mail address and press **Send test** (look in spam too).
   If it fails, the page shows the provider's own reason.

**SMS** (India: Fast2SMS; anywhere: Twilio)

1. **Fast2SMS:** sign up at fast2sms.com (free credit, then a small recharge), copy the **API key** from *Dev API*.
   **Twilio:** copy *Account SID*, *Auth token* and your Twilio number from the Twilio console (a free trial texts only numbers you verified there).
2. In the **SMS** card choose the service, paste the key (Fast2SMS) or SID / token / number (Twilio) and press **Save**.
   Keys are write-only: once saved the box only says "saved". *Quick SMS* needs no DLT registration; use *DLT template* (under Advanced) once yours is approved.
3. Under *Check that it works* type your mobile number (e.g. `+91 98765 43210`) and press **Send test**.

To change anything later: **Change settings** on the card.

### Step 2 - Who should receive the alerts?

One row per RPF post. Type the post's **E-mail** and **Mobile** and press **Save** on that row (Save lights up only when you changed something;
unsaved typing in other rows is kept).

* **Alerts for a post go to that post's e-mail and mobile.** If an alert is escalated to another post, that post's contacts are used.
* Leave a box empty = nothing is sent that way for that post.
* A small label under the boxes tells you the state: **E-mail ✓** (will be sent), **E-mail is off** (do step 3), **E-mail not connected** (do step 1).
* **Also send a copy of every message to the control room** (fold-out): e-mail addresses / mobile numbers of supervisors, comma separated.
* Zone admins see only the posts of their own zone and can fill their contacts; the rest of the page is for super admins.

### Step 3 - Switch it on

Two switches: **E-mail alerts** and **SMS alerts**. They save by themselves and take effect immediately.
**More options** (fold-out): which messages are sent (new alerts, incidents, footage request updates, ...), *Send SMS for* alerts of a minimum priority
(lower ones are still e-mailed), and a preview of what a message looks like.

Then trigger an alert (or press **Send test**) and open **Recent messages** at the bottom: every message with its result. It opens by itself when
something failed and shows the reason; **Send failed ones again** retries them after you fixed the key.

### Optional: file instead of page

`config/notify.conf` holds the same settings as defaults (useful for scripted installs). A value saved on the page **wins** over the file. Gateway
addresses (Fast2SMS / Twilio URLs) and the provider choices of the forms (`config/notify-presets.json`) are only in those files - edit them there,
then `bash run-offline.sh restart`.

## 2. What the rules mean

| Setting | Meaning |
|---|---|
| E-mail alerts / SMS alerts (switches) | master switch per channel |
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
4. Every message is logged: **CMS console -> Administration -> E-mail & SMS -> Recent messages** (time, channel, recipient, status, tries, provider error). Kept `NOTIFY_LOG_DAYS` days.

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
| `.../public/js/admin.js`, `boot.js`, `public/console.css` | new page **Administration -> E-mail & SMS** (`V.notify`), menu entry |
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
