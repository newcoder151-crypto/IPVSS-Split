# RPF Dashboard

RPF Thana/Post dashboard for IPVSS. A separate application from CMS and M-NVR that **shares the CMS database** and owns no schema: no migrations, no tables, no DDL. CMS stays exactly as it is; RPF reads and writes CMS's own tables.

## How it fits

```
M-NVR ──> CMS ──(alert_delivery + incident rows)──> RPF dashboard ──> officer
                 <──(video_request rows)──────────  RPF
   CMS operator approves, CMS ingest writes delivered_footage ──> RPF serves it
```

RPF and CMS talk only through the shared tables. There is no RPF-to-CMS HTTP call.

| Step | Who | What happens in the database |
|---|---|---|
| Alert arrives | CMS | `alert` -> `alert_delivery` (+ `incident` if auto-dispatched). RPF inbox = deliveries for the officer's post. |
| Acknowledge | RPF | `alert_delivery.ack_at/ack_by`, `alert.status='acknowledged'`, `alert_history` row |
| Raise / work incident | RPF | `incident` insert; status `open -> under_review -> closed` (forward only). Closing resolves the alert. |
| Request footage | RPF | `video_request` insert (status `submitted`) |
| Approve / amend / reject | **CMS operator** | updates `video_request` |
| Deliver footage | **CMS ingest** | inserts `delivered_footage` (one stitched file), sets request `fulfilled` |
| View / save locally | RPF | short-lived `video_access_grant`, served with HTTP Range; every view/download written to `audit_log` |
| Flag for retention | RPF | `evidence_flag` insert; justification mandatory |

## One dashboard, every post

One RPF dashboard serves **every Thana / Post**, but each officer belongs to exactly one post and only ever sees that post's data. There are no admin, zone or "work as" modes here (CMS operators and administrators use the CMS console).

* **First screen:** a card with **Sign in** and **Register post** tabs (both are shown every time; it opens on Register while no officer login exists). Officers of every post sign in on this same dashboard and each sees only their own post's alerts, incidents, requests, footage and evidence. Once any officer exists, registering another post needs a current officer's username and password as confirmation (a new post receives alerts, so nobody may add one unchecked). Usernames are forgiving: "Anshika Sharma" becomes `anshika.sharma`, and signing in with the name as typed works.
* **Registering:** the registration form (Thana / Post name, zone, location, first officer login). That creates the post (`rpf_post`) and the login (`users`, role `post_user`) in the CMS database - existing tables only, no schema change - and remembers the post in `data/post.json`. The post's location is what CMS uses to send alerts to the nearest post.
* **After that:** officers of every post sign in on the same page; the registration form stays available but needs a current officer's confirmation. Their alerts, incidents, requests, footage and evidence are only their own post's.
* A post that the CMS administrator already created (same zone and name, no officer yet) is adopted by the registration; one that already has an officer cannot be taken over.
* Existing install, or a post created in the CMS console: `bash scripts/start.sh users bind "<post name>"`. More officers for the same post: `users add <username>`.
* **More officers:** an officer of the post adds a colleague on the **Team** tab (username + a starting password), and can set a new password for a colleague who is locked out. Everyone can change their own password under **Account**.

## Run everything with one command

`scripts/start.sh` brings up the whole stack: PostgreSQL, the CMS database, the CMS backend, and the RPF server (API + dashboard).

```
workspace/
  CMS/      your CMS code (unchanged)
  rpf/      this project
```

```bash
cd rpf
bash scripts/start.sh --demo     # first run, with demo data (dev only)
bash scripts/start.sh            # normal start, no demo data
```

On the first run it creates `.env` with random secrets, starts PostgreSQL if it is down, creates the role and database, enables PostGIS, applies the CMS schema and seed, makes sure this month's and the next three months' `alert` / `gps_point` partitions exist, installs dependencies, then starts the services and waits until each answers. Every step is skipped when already done, so it is safe to re-run.

| Command | What it does |
|---|---|
| `start` (default) | Everything above, in the background. Services keep running after the script returns. |
| `run` (or `start -f`) | Same, but stays in the foreground: watches the services, restarts any that crash, streams the logs, and stops everything on Ctrl-C. |
| `stop` | Stops the supervisor (if any), CMS backend, RPF and the demo stand-in. Never stops PostgreSQL. |
| `restart` | `stop`, then `start` |
| `status` | PostgreSQL, supervisor, CMS backend, RPF and stand-in: running or not, and whether they answer |
| `logs [cms\|rpf\|sim]` | Follow the logs in `logs/` |
| `users ...` | List, add and reset RPF logins (see "Logging in") |
| `service-file` | Print a systemd unit that runs the stack at boot (see "Keeping it running") |
| `setup-db` | Only prepare the database |
| `check` | Read-only check that the database suits RPF |

| Flag | Meaning |
|---|---|
| `--demo` | Also load demo zones, posts, NVR units and logins, raise four demo alerts through the CMS backend, and run `simulate_cms.js watch` as a stand-in for the CMS operator and footage ingest. Dev only. |
| `--no-db` | Do not touch the database (it is already prepared) |
| `-f`, `--foreground` | Same as the `run` command |

Demo login (password `rpf-demo-123`): `post-a-officer` - `--demo` binds this dashboard to Post A. Dashboard: `http://localhost:7090`. CMS API: `http://localhost:7080`.

Settings live in `.env` (see `.env.example`):

| Variable | Purpose |
|---|---|
| `CMS_DIR` | Where the CMS code is (default `../CMS`) |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | The one shared database |
| `PORT`, `CMS_PORT` | RPF and CMS backend ports (7090 / 7080) |
| `PRIORITY_THRESHOLD` | CMS auto-dispatches alerts at or above this priority |
| `PG_SUPERUSER`, `PG_SUPERUSER_PASSWORD` | Only for first-time role/database creation when sudo/su access to `postgres` is not available |
| `RPF_LEAST_PRIVILEGE=1` | Run RPF as the least-privilege `rpf_app` role (see below) |
| `ENSURE_PARTITIONS`, `PARTITION_MONTHS_AHEAD` | Monthly partition maintenance at start-up (on, 3 months) |

### Logging in

1. Open the dashboard: `http://localhost:7090` (from another machine on the network: `http://<this-machine-ip>:7090`).
2. First time: fill in the registration form. Later: sign in with an officer login of the post (the start-up banner lists them).

Accounts created by `--demo` use the password `rpf-demo-123`. **Passwords are stored as bcrypt hashes, so nobody (including this script) can display them.** An account that already existed before `--demo` keeps its old password. Change the demo passwords before anyone else can reach the machine.

Only post officers (`post_user`) sign in here; CMS operators and administrators use the CMS console.

### Managing accounts

```bash
bash scripts/start.sh users list
bash scripts/start.sh users password post-a-officer              # generates a password and shows it once
bash scripts/start.sh users password post-a-officer 'MyPass-2026'  # or set one yourself (8+ characters)
bash scripts/start.sh users add sharma                           # another officer for this dashboard's post
bash scripts/start.sh users bind "Post A"                        # make this dashboard the dashboard of an existing post
```

The commands write to the CMS `users` table with the owner credentials from `.env`, and leave a `user.create` / `user.password` entry in the audit log.

### Keeping it running

- **After the script returns:** `start` already leaves everything running in the background (`bash scripts/start.sh status` shows it). It survives closing the terminal, but not a reboot or a crash.
- **Stay attached, auto-restart on crash:** `bash scripts/start.sh run`. A crashed service is restarted within a few seconds; a service that cannot start (for example its port is taken) is retried and then backed off for 30 s instead of looping. Closing the terminal does not stop it; Ctrl-C or `stop` does.
- **Across reboots:** install it as a systemd service.

```bash
bash scripts/start.sh service-file > rpf-stack.service        # add --demo only for demos
sudo cp rpf-stack.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rpf-stack
journalctl -u rpf-stack -f                                    # follow the logs
```

The unit runs as your user, waits for PostgreSQL, and handles folder names containing spaces or parentheses. Under systemd the script cannot ask for a `sudo` password, so PostgreSQL must start on its own (it normally does).

Notes on how it behaves:

- **CMS is never modified.** Its own `.env` files are not used; the launcher passes the database settings to the CMS backend as environment variables.
- **Existing database:** if the role and database already exist and the `.env` credentials work, no superuser access is needed at all.
- **Ports:** both are checked before anything starts, so a conflict never leaves a half-started stack.
- **Production:** do not use `--demo`. Put TLS in front, and note that the CMS API has no authentication yet.
- **Partitions** are created with `CREATE TABLE IF NOT EXISTS ... PARTITION OF` as the database owner. Set `ENSURE_PARTITIONS=0` if you manage them yourself.
- **`rpf_app` is cluster-wide.** With `RPF_LEAST_PRIVILEGE=1` the launcher creates the role from `sql/rpf_app_role.sql` and, if it already exists with a different password, resets it to `RPF_APP_PASSWORD` from `.env`. Two RPF deployments on one PostgreSQL cluster would share that role.
- **Needs:** bash, Node.js 18+, `psql`, `curl`, PostgreSQL with PostGIS. Linux is tested. On macOS, `setsid` is absent and the script falls back to plain `nohup`.

### Manual setup (without start.sh)

```bash
cp .env.example .env              # point DB_* at the CMS database, set JWT_SECRET
npm install
npm run check-db                  # read-only: verifies CMS tables, columns and privileges
npm start                         # RPF only, http://localhost:7090 (CMS backend started separately)
```

**Least-privilege role by hand.** Run once as a superuser:

```bash
psql -d cms -v rpf_password='...' -f sql/rpf_app_role.sql
```

`rpf_app` gets SELECT, a few INSERTs, and column-limited UPDATEs. It has no DELETE anywhere and no UPDATE on `audit_log` or `delivered_footage`.

**Footage files.** `delivered_footage.storage_path` is resolved under `MEDIA_ROOT` (mount or sync CMS's footage store there). Paths that escape it are refused.

**Real-time.** The browser polls `/api/alerts/summary` every `ALERT_POLL_SECONDS`, matching the poll-based model in CMS. Swap in SSE later if CMS adds LISTEN/NOTIFY.

## Demo pieces by hand (what `--demo` automates)

```bash
node scripts/seed_demo.js                    # demo logins in users (needs CMS sql/fixtures.sql)
bash <CMS>/scripts/seed_demo_data.sh         # alerts, via CMS's own backend
node scripts/simulate_cms.js watch           # stands in for the operator + ingest
```

Login: `post-a-officer`, password `rpf-demo-123` (the demo binds the dashboard to Post A). Demo scripts refuse to run with `NODE_ENV=production`.

## The dashboard (frontend)

Served by the same Node process from `public/` (plain HTML, CSS and JavaScript: no build step, no framework, no CDN). Open `http://localhost:7090`.

| Tab | What the post's officers do |
|---|---|
| Alerts | Inbox with live unacknowledged counter; drawer to acknowledge, raise and work incidents, request footage |
| Incidents | Raise incidents (or auto-raised for high priority), add notes, move open -> under review -> closed |
| Requests | Raise, track and cancel footage requests |
| Footage | Play in browser, save the original file or a chosen section, flag for retention |
| Evidence | Retention flags with justification; archive status; local copies |
| Activity log | Every sign-in, acknowledgement, request, view, download and flag made under this post (chain of custody) |

The page polls every `ALERT_POLL_SECONDS` and shows a toast when CMS delivers an alert or footage. Browsers play H.264 MP4 natively (Chrome, Edge, Safari, Firefox). If a browser cannot decode a file, the player says so and points to "Save locally". AVI and MKV are download-only.

## Tests

Two layers, both against a real CMS database:

- `npm test` - API workflow test (described below).
- `python3 test/browser/e2e.py` and `python3 test/browser/fallback.py` - drive the real dashboard in headless Chromium (Playwright): sign-in, acknowledge, request, live toast when CMS delivers footage, real video decoding and seeking, download hash check, flagging, admin views, phone layout, console errors, and screenshots into `test/browser/shots/`. Needs `pip install playwright`, `python -m playwright install chromium`, and ffmpeg. Stock Chromium has no H.264, so the e2e script delivers a VP9 clip via `SAMPLE_FILE`, and `fallback.py` checks that an undecodable file gives a clear message.

`RPF_TEST=1 JWT_SECRET=<32+ chars> DB_USER=rpf_app DB_PASSWORD=... TEST_OWNER_USER=cms TEST_OWNER_PASSWORD=... npm test`

Runs the whole workflow through HTTP against a real CMS database as `rpf_app`. Dev databases only: the audit log and delivered footage are append-only, so its rows cannot be cleaned up.

## Things you should know

1. **CMS's dummy alert endpoint sets no `camera_id`.** Incident-driven requests then ask the officer to pick a camera. Real NVR alerts should carry one.
2. **Approval, fulfilment, escalation timers and the 30-day retention job are CMS's.** RPF writes the acknowledgement that stops escalation, and flags that CMS's retention job must honour; neither job exists in CMS yet.
3. **Design-doc items not built:** email/SMS notification (Cl. 3.15.8; needs a provider), watermark/speed overlay (comes from the CMS-stitched file), cross-zone merged requests (CMS resolves those), and the REST contract to a separate CMS (superseded by the shared database you asked for).
4. **Schema gaps in CMS that shaped RPF:** `request_status` has no PENDING/IN_TRANSIT/EXPIRED, so RPF shows CMS's own states; `delivered_footage` has no 'archive status'; `incident` has no manual-raise path without an alert. Worth a CMS schema review.
5. **Security:** the token lives in `sessionStorage`; put TLS in front (RDSO mTLS over IP-MPLS) and keep `JWT_SECRET` out of source control.
