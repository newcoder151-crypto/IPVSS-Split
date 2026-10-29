# M-NVR -> CMS -> RPF : workflow, live updates, how to run and test

## 1. The flow

```
 M-NVR (train)                    CMS (control room)                         RPF (post / thana)
 -------------                    ------------------                         ------------------
 alert + GPS  ──────────────►  priority >= threshold (default 7)
                                 │  yes: nearest post, incident created  ──►  alert arrives WITH an open
                                 │       automatically (source=auto)           incident; officer acknowledges
                                 │  no : alert waits in the OPERATOR QUEUE
                                 │       operator: Forward  | Send + incident ─►  alert arrives; officer decides:
                                 │                 Dismiss                       "Raise incident" (source=officer)
                                 │
                                 │  Nothing reported by an alert? the officer raises a MANUAL incident
                                 │  (complaint, patrol) choosing the nearest camera/train (source=manual)
                                 │
 footage stays on the train ◄── request footage  ◄────────────────────────  officer requests footage for the
 (30-day FIFO on the unit)       operator Approve | Amend window | Reject     incident (camera, time window)
        │                         │
        │  "upload now" command   │  footage already in CMS?  yes -> stitch + deliver at once
        ◄─────────────────────────┘                           no  -> request = "waiting for train"
 uploads segments (chunked,                                           (delivered the moment the train is
 resumable, SHA-256 verified) ──►  stitch to ONE mp4 (no re-encode) ──►  back in coverage)
                                                                         officer REVIEWS: play, seek,
                                                                         mark section start/end
                                                                           ├─ Save section to PC (just that part)
                                                                           └─ Flag section: FOR LIFE or until date
                                  copy section to permanent archive  ◄──   (justification mandatory)
                                  hash it, never touched by retention
```

## 2. Live updates (low latency)

* Postgres triggers (migration `003_live.sql`) `NOTIFY` on every change to alerts, deliveries, incidents,
  requests, footage, evidence flags, notifications, segments and NVR commands.
* Both servers `LISTEN` and push to the open browsers over **Server-Sent Events** (`/console/api/stream`,
  `/api/stream`). The browser opens the stream with a 60-second ticket (EventSource cannot send headers) and
  reconnects by itself; on reconnect the screen reloads, so nothing is missed.
* Scope is enforced server-side: an officer only receives events of their post, an operator/zone admin of their
  zone, a super admin everything.
* The M-NVR gets commands through a **long-poll** (`GET /nvr/v1/commands/wait`): "upload now" reaches a train
  with coverage in milliseconds, not at the next heartbeat. Background jobs are also kicked the moment work
  appears (new request, new evidence flag) instead of waiting for their timer.
* Measured on the demo stack (same machine): event reaches the officer's browser in ~25 ms; alert shown in the
  CMS queue ~0.3 s after the NVR posts it; request visible to the operator ~0.2-0.3 s after the officer sends;
  approved footage delivered to the officer in ~0.3-1.5 s (3 min clip); archive of a flagged section ~0.2-2 s.
* Things that change without a database write (NVR heartbeats, "x min ago") refresh every 5 s on the fleet/map.

## 3. Roles

| Role | Where | Can |
|---|---|---|
| operator | CMS console | work the alert queue, decide requests, see everything in their zone |
| zone_admin | CMS console (+ read-only RPF) | + registry (posts, NVRs, cameras), users, release evidence, export audit |
| super_admin | CMS console | + zones, NVR zone handover, settings, run retention |
| post_user | RPF dashboard | acknowledge, raise incidents, request footage, review, flag, download |

## 4. CMS console pages
Control room (KPIs, attention list, 24 h chart) - Alert queue - Alerts - Incidents - Live map (SVG geo plot, works
offline) - Footage requests - Delivered footage - Evidence (chain of custody, retry archive, release) - M-NVR fleet
(commands, cameras, zone history, 6 h GPS track) - Stored segments - Zones & posts - Users - Retention (preview of
what will be deleted and what is protected) - Settings (threshold, escalation, windows, retention days, auto-approve,
webhook) - Jobs & health - Audit trail (filter + CSV).

## 5. Rules worth knowing
* Auto-dispatch threshold, escalation time (unacknowledged -> next post), max window, retention days, request
  expiry are runtime **Settings** (super admin).
* Retention deletes raw segments older than the policy **except** those overlapping an active evidence flag.
  Delivered footage, archived evidence and the audit trail are never deleted by it.
* A flagged section kept **on CMS** is archived by CMS (stream copy, SHA-256 recorded) so it survives even after the raw
  segments are gone. "For life" flags stay until a zone admin releases them (the archive copy is kept).
* Every view/download of footage or evidence goes through a short-lived signed link and is audited.
* NVR retries are idempotent (same event id + time = same alert); segment uploads resume from the last chunk.

## 6. Run it
```
cd rpf
bash scripts/start.sh start --demo      # DB + migrations + CMS + RPF + simulated trains
#  RPF dashboard  http://localhost:7090   post-a-officer / rpf-demo-123
#  CMS console    http://localhost:7080/console/   cms-operator / cms-demo-123  (also cms-zone1-admin, cms-super)
```
Needs PostgreSQL + PostGIS, Node 18+, ffmpeg. Demo trains: `node CMS/scripts/mnvr_sim.js alert --unit 1 --type
intrusion --priority 9`, `... offline 1` / `online 1` to put a train in a tunnel. Use `SIM_CODEC=vp9` in `.env` if
your browser cannot play H.264.

* A flag kept **locally** is saved by the RPF server in `local-evidence/post-<id>/flag-<n>.mp4` with a `.json` of what the
  officer entered; CMS records the flag but holds no clip and does not protect segments for it.

## 7. Tests
```
node CMS/test/flow.js                    # whole chain through the APIs (55 checks)
python3 CMS/test/browser/ui_flow.py      # real browser, both dashboards, live latency, screenshots
```
Dev database only: they create alerts, incidents, requests and flags. The browser test needs VP9 footage (stock
Chromium has no H.264), so run `CODEC=vp9 node CMS/test/flow.js` if you run both against the same database.

## 8. Not done / needs your decision
* Real M-NVR authentication is by certificate fingerprint header (put mTLS in front in production).
* Footage store is a shared folder (`MEDIA_ROOT`); swap `fsutil.js` for S3/MinIO for production.
* Email/SMS: notifications go to the in-app bell and an optional webhook; wire your gateway to the webhook.
* The map is a plain geo plot (no tiles) so it works on a closed network; a tile layer needs a map server.
* Several CMS backends: jobs are advisory-locked, but SSE streams are per process (fine behind sticky sessions).
