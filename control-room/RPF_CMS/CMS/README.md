# CMS - Central Management System

The control-room side of the IPVSS chain **M-NVR (train) -> CMS -> RPF (post)**.

CMS receives alerts and GPS from the trains, routes them to RPF posts, lets operators decide footage requests,
fetches footage from the train on demand, keeps flagged evidence, and pushes every change to the screens live.
It shares one PostgreSQL/PostGIS database with the RPF dashboard (a separate project, folder `rpf/`).

Design background: `CMS_Architecture_v0.2.md`. Flow, roles and rules in one page: `docs/WORKFLOW.md`.

## What it does

- **Alerts in.** High-priority alerts (default 7+) go straight to the nearest post **with an incident already raised**.
  Lower ones (below 7) are **also delivered to the nearest post automatically, but without an incident** - the officer
  decides whether to raise one. (Settings -> *Alerts BELOW the threshold* can instead hold them in the CMS **operator
  queue**, where an operator forwards, sends with an incident, or dismisses.)
  Unacknowledged alerts escalate to the next post. NVR retries are idempotent.
- **Footage on request.** The post asks for footage for an incident; the operator approves, amends the window or
  rejects. If the footage is still on the train, CMS commands the NVR to upload it (resumable, SHA-256 verified),
  stitches it into one MP4 (no re-encode) and delivers it. If the train is out of coverage the request waits and
  completes when the train is back.
- **Evidence.** The post marks a section of the footage and flags it. It chooses **where it is kept**:
  - **On CMS** - CMS copies just that section to permanent storage and keeps it beyond the 30-day limit
    (for life, or until a date);
  - **Locally at the post** - the RPF server saves its own copy (plus a `.json` with what the officer entered);
    CMS keeps no clip but records the flag, the section and the retention time;
  - **Both.**
  The 30-day FIFO never deletes anything under an active CMS flag.
- **Live.** Postgres `NOTIFY` -> Server-Sent Events to both dashboards (about 25 ms to the browser); the NVR gets
  commands through a long-poll, so "upload now" reaches a train in coverage in milliseconds.
- **Audit.** Every decision, view and download is logged; footage links are short-lived and signed.

## Layout

```
CMS/
  .env.example                  database settings for scripts/start.sh
  backend/
    .env.example                database + backend settings
    src/
      server.js                 app entry, port fallback, health, error handler
      config.js                 all settings (env)
      routes/nvr.js             M-NVR -> CMS interface (heartbeat, alerts, segments, commands)
      routes/console/*          operator / admin console API (+ dev.js = Test lab)
      routes/legacy.js          original v0.1 endpoints (dev only)
      services/                 alert ingest, dispatch, requests, evidence, retention, escalation, live push, jobs
    public/                     the CMS console (served at /console/)
  sql/
    schema.sql                  base schema            }  apply in this order:
    seed.sqlx                   admin + system users   }  schema -> seed -> migrations -> fixtures
    migrations/                 002 workflow, 003 live updates, 004 evidence storage (idempotent)
    fixtures.sql                demo zones, posts, 3 NVRs x 3 cameras, demo logins (dev only)
  scripts/
    start.sh                    database setup (applies schema, seed and migrations)
    mnvr_sim.js                 M-NVR simulator (the train's VMS stand-in)
    seed_demo_data.sh           demo alerts through the legacy API
  test/flow.js                  whole chain through the APIs
  test/browser/ui_flow.py       real browser test of both dashboards
  docs/WORKFLOW.md
```

## Requirements

Node.js 18+, PostgreSQL 15+ with PostGIS (tested on 16 / 3.4), `psql`, bash, and **ffmpeg** (stitching footage,
cutting sections). Ubuntu: `sudo apt install postgresql postgresql-16-postgis-3 ffmpeg`.

## Ports

CMS **7080**, RPF **7090**. (8080 / 8090 are left for the M-NVR.) If a port is busy the server tries the next ones
and prints which it chose; `PORT_AUTO=0` turns that off. `rpf/scripts/start.sh` picks free ports itself.

## Quick start (everything, with simulated trains)

```bash
cd rpf
bash scripts/start.sh start --demo
# RPF dashboard  http://localhost:7090          post-a-officer / rpf-demo-123
# CMS console    http://localhost:7080/console/ cms-operator / cms-demo-123   (also cms-zone1-admin, cms-super)
```

## Manual setup (CMS on its own)

```bash
cp .env.example .env && cp backend/.env.example backend/.env     # set DB_PASSWORD in both, same values
bash scripts/start.sh --setup-db        # role, database, extensions, schema, seed AND migrations
# fixtures are applied AFTER the migrations (they need the new columns):
PGPASSWORD=... psql -h localhost -U cms -d cms -v ON_ERROR_STOP=1 -f sql/fixtures.sql
cd backend && npm install && npm start
curl http://localhost:7080/health       # {"status":"ok","db":"reachable","version":"0.2.0"}
```

If you set the database up by hand, apply in this order: `schema.sql`, `seed.sqlx`, every file in
`sql/migrations/` (in name order), then `fixtures.sql`. Migrations are safe to re-run.

### Settings (`backend/.env`)

| Variable | Default | Meaning |
|---|---|---|
| `DB_*` | cms / localhost:5432 | database connection (same in both `.env` files) |
| `PORT` | 7080 | HTTP port; `PORT_AUTO=0` to fail instead of trying the next port |
| `CMS_JWT_SECRET` | random per start | signs console sessions and footage links (32+ chars) |
| `MEDIA_ROOT` | `../media` | footage store; **RPF must point at the same folder** |
| `PRIORITY_THRESHOLD` | 7 | alerts at or above this are auto-dispatched with an incident |
| `LOW_PRIORITY_MODE` | `auto_deliver` | alerts below it: `auto_deliver` (to the nearest post, no incident) or `operator_queue` |
| `AUTO_APPROVE_REQUESTS` | 0 | 1 = approve footage requests automatically (demo only) |
| `DEV_TOOLS` | on (off in production) | the Test lab page in the console |
| `CMS_WORKERS` | 1 | 0 = do not run background jobs in this process |

Threshold, escalation time, window limit, retention days and more are also editable at runtime under
**Settings** (super admin).

## How to test the live link between CMS and RPF

In production the alerts come from the train's VMS / M-NVR. The dashboards only *display* them - they cannot make
an alert - so to test you stand in for the train. Three ways, easiest first.

### 1. The Test lab (in the CMS console)

Sign in to the CMS console -> **Administration -> Test lab**. It lets you:

- **send an alert as an M-NVR** (pick unit, camera, type, priority and position - at the train, next to a post, or custom).
  It goes through the same code as a real alert. Priority 7+ is auto-dispatched with an incident; lower waits in the queue;
- **put a simulated train in a tunnel** and bring it back (for the "waiting for train" case);
- one-click presets.

Open the RPF dashboard in a second window as an officer of the nearest post and watch it update by itself.

### 2. A 10-minute test script

1. `bash rpf/scripts/start.sh start --demo` (or start CMS, RPF and `node scripts/mnvr_sim.js run --units 1,2,3`).
2. Window A: RPF as **post-a-officer**. Window B: CMS console as **cms-operator**.
3. Test lab -> **Panic button P9**, location *next to Post A*. In A the alert appears at once with an open incident. Acknowledge it.
4. Test lab -> **Loitering P3**. In A it appears at once too, tagged "low priority - no incident yet"; open it -> **Raise incident**.
   (To test the operator queue instead, set Settings -> *Alerts BELOW the threshold* to "Hold in the CMS queue"; then the P3 waits in
   **Alert queue** until you *Choose post...* -> Post A -> Forward.)
5. No alert at all? In A: **Incidents -> Raise incident**, choose a camera - a manual incident.
6. In A open an incident -> **Request footage** (pick a window in the last hour). In B: **Footage requests -> Approve**.
   The simulated train uploads it; in A the request becomes "footage ready" within seconds.
7. Test lab -> put **nvr-1 in a tunnel**, request more footage, approve it: A shows "waiting for train". Bring the train back: it completes.
8. In A: **Footage** tab - the player is on the page. Mark a start and end, then **Save section to PC** or **Flag section...**
   and choose *On CMS*, *Locally at this post* or *Both*, for life or until a date. A justification is required.
9. **Evidence** on both sides shows the flagged recordings with their players, the section, the retention time, and the copies.
10. B: **Audit trail** shows everything above.

### 3. Command line / the real NVR contract

```bash
node scripts/mnvr_sim.js run   --units 1,2,3 --alerts 60      # trains with heartbeat, GPS, random alerts, uploads
node scripts/mnvr_sim.js alert --unit 1 --type intrusion --priority 9 --lat 26.001 --lon 80.101
node scripts/mnvr_sim.js offline 1        # tunnel     |    node scripts/mnvr_sim.js online 1
```

The real VMS must call these (header `X-NVR-Fingerprint: <certificate fingerprint>`; terminate mTLS in front in production):

| Method | Path (`/nvr/v1`) | Purpose |
|---|---|---|
| GET | `/self` | the unit's cameras and the server clock |
| POST | `/heartbeat` | position, health, buffered GPS track; returns waiting commands |
| GET | `/commands/wait?timeout=25` | long-poll for commands (instant "upload now") |
| POST | `/alerts` | `nvr_event_id`, `alert_type`, `priority`, `lat`, `lon`, optional `event_time`, `camera_id` (idempotent) |
| POST | `/segments` | announce a recorded segment (`camera_id`, times, `size_bytes`, `sha256`) |
| PUT | `/segments/:id/chunks/:n` | upload a chunk (resumable) |
| POST | `/segments/:id/complete` | verify size + SHA-256 and store |
| POST | `/commands/:id/ack`, `/done`, `/fail` | report on a command |

```bash
curl -X POST http://localhost:7080/nvr/v1/alerts -H 'X-NVR-Fingerprint: fp-demo-1' -H 'Content-Type: application/json' \
  -d '{"nvr_event_id":"evt-1","alert_type":"intrusion","priority":9,"lat":26.0,"lon":80.1,"camera_id":3}'
```

### Automated tests

```bash
CODEC=vp9 NODE_PATH=backend/node_modules node test/flow.js     # the whole chain through the APIs
python3 test/browser/ui_flow.py                                  # real browser, both dashboards, with timings
```
They write to the **development** database only.

## Seeing the right version, and what each login can do

Both dashboards show their version next to the title (CMS `v0.2.0`, RPF `v0.3.0`). The servers send
`Cache-Control: no-cache`, so a normal refresh always loads the newest scripts. If the RPF title has no `v0.3.0`,
you are looking at an old copy.

On the RPF dashboard **only a post officer** can raise incidents, request footage, flag and save evidence
(`post-a-officer`, `post-b-officer`, password `rpf-demo-123`). `zone1-admin` and super admins are read-only and see a
banner saying so. Officers have **+ Incident** and **Footage request** buttons in the top bar on every page.

Both dashboards have a **dark mode** toggle (sun / moon in the top bar); it follows your system setting at first and
then remembers your choice.

## Filters and sorting

Every list has a filter and sort bar. RPF filters instantly in the browser while you type: **Alerts** (search, priority,
type, acknowledged, incident, how it arrived, when, sort), **Incidents**, **Requests**, **Footage**, **Evidence**. The CMS
console filters on the server: **Alerts**, **Incidents**, **Requests** (search, status, source, priority, when, sort) and the
**Alert queue** (priority, type, sort). "Clear filters" resets a bar; choices are kept while you move between tabs.

## CMS console pages

Control room - Alert queue - Alerts - Incidents - Live map - Footage requests - Delivered footage (player) -
Evidence (flagged recordings, player, copies) - M-NVR fleet - Stored segments - Zones & posts - Users - Retention -
Settings - Jobs & health - Audit trail - Test lab (dev).
Roles: `operator` (their zone), `zone_admin` (+ registry, users, release evidence), `super_admin` (+ zones, settings, retention).

## Retention in one paragraph

Raw segments older than the policy (30 days) are deleted by an hourly job, **except** segments overlapping an
active evidence flag that is kept **on CMS** (for life, or until its date). Delivered footage, archived evidence
clips and the audit trail are never touched. A flag kept **locally only** does not hold anything on CMS; the post's
own copy lives in the RPF server's `local-evidence/` folder and is never deleted automatically.

## Monthly partitions

`alert` and `gps_point` are partitioned by month. CMS creates the next months itself (job `partitions`) and
creates the partition for an old event's month on demand, so an NVR that was offline for weeks can still report.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `column "train_no" does not exist` (or similar) when loading fixtures | the migrations were not applied; apply `sql/migrations/*.sql` first (`start.sh --setup-db` does) |
| `EADDRINUSE` / port in use | an old backend is still running: `ss -ltnp \| grep 7080`, stop it; or `PORT=7081 npm start` |
| `{"error":"Not found"}` from the demo scripts | you are talking to an old v0.1 backend; stop it and start this one (`/health` must say 0.2.0) |
| `Peer authentication failed for user "postgres"` | use `sudo -u postgres psql ...` for the superuser steps |
| Footage never arrives | the NVR is not contacting CMS: Test lab / M-NVR fleet shows "no contact"; start `mnvr_sim.js run` |
| Video does not play in the browser | the codec is H.264 and the browser lacks it; use `CODEC=vp9` for the simulator, or Save to PC |
| `ffmpeg is required` | install ffmpeg on the CMS server (stitching) and the RPF server (cutting a local section) |
| `password authentication failed` | `DB_PASSWORD` differs between the `.env` files or from the role's password |

## Known limits

- NVR authentication is a certificate-fingerprint header; put mTLS in front for production.
- The footage store is a shared folder (`MEDIA_ROOT`); replace `services/fsutil.js` for S3/MinIO.
- E-mail/SMS: notifications go to the in-app bell and an optional webhook (Settings).
- The live map is a plain geo plot (no tiles) so it works on a closed network.
- Several CMS backends: jobs are lock-protected, live streams are per process (use sticky sessions).
