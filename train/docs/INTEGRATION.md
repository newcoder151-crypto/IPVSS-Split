# M-NVR -> CMS -> RPF integration

The three systems stay separate. **`mnvr/`, `RPF_CMS/CMS` and `RPF_CMS/rpf` are byte-for-byte what you sent.**
The only new code is `bridge/`, a small agent that runs on the train next to the M-NVR and speaks the
CMS's existing M-NVR contract (`/nvr/v1`), which until now only the simulator (`CMS/scripts/mnvr_sim.js`) implemented.

```
 TRAIN                                           CONTROL ROOM                        POST
 M-NVR  (recordings, events, GPS in its own DB)  CMS  (:7080)                        RPF (:7090)
   |  read-only SQL                                ^  |                                ^
   v                                               |  v                                |
 bridge --- heartbeat + GPS track --------------> /nvr/v1/heartbeat                    |
        --- event -> alert ---------------------> /nvr/v1/alerts ---> incident/dispatch -> alert on officer's screen
        <-- "upload now" (long-poll) ------------ officer requests footage, operator approves
        --- segments (chunked, resumable, SHA-256) -> stitched MP4 -----------------> "footage ready" at the officer
```

## What happens, automatically
| Step | Who | How |
|---|---|---|
| Train alive, position, GPS track | bridge -> CMS | heartbeat every 5 s; GPS read from `gps_track_log`, thinned to 1 per 5 s, back-filled after a tunnel |
| Alert | M-NVR `events` row -> bridge -> CMS -> RPF | rules in `bridge/config/alert-rules.json`; CMS auto-dispatches P>=7 with an incident, lower go to the nearest post without one |
| Footage request | officer (RPF) -> operator approves (CMS) | existing CMS/RPF workflow, unchanged |
| Fetch footage | CMS command -> bridge | long-poll: the command arrives in milliseconds; the bridge finds the camera's finished segments for the window in `recordings`, uploads them |
| While recording | bridge | if the window reaches "now", it waits (bounded) for the segment being written to finish, so the clip is complete |
| Delivery | CMS stitches (no re-encode) -> RPF | officer is notified; review, flag, save as before |
| No coverage | bridge | alerts and GPS stay in the M-NVR DB (they are the outbox); a cut upload resumes from the last stored chunk |

Optional (`AUTO_UPLOAD_ON_ALERT=1`): footage around a serious alert is pushed before anyone asks, so a later request is delivered instantly. Off by default (uses mobile data).

## Setup
**One command:** `bash start.sh` in the folder above (starts CMS+RPF, the M-NVR and the bridge). The bridge
registers the train in CMS by itself: name and train number come from the M-NVR's `system_config`
(`device_name`, `train_number` - set them in the M-NVR settings), the certificate fingerprint is generated once
(`bridge/state/identity.json`), the zone is the first zone in CMS (override `ZONE=` in `bridge/.env`), and the
cameras are copied by name. A fresh CMS needs zones/posts: create them in the CMS console or use `--demo-data`.

Separate machines (train vs control room): copy `bridge/.env.example` to `.env`, set `CMS_URL`, `MNVR_DB_*`,
`CMS_DB_*` (registration writes registry rows to the CMS database), and run `bash bridge/scripts/start.sh`.
Manual registration (`scripts/provision.js`) and the read-only DB login (`scripts/grant_readonly.sql`) remain optional.

## Things you must know / decide
* **Alert priorities are my assumption.** `alert-rules.json` maps panic/ETBU/fire/intrusion/tamper high, human/animal/object low. Review it; an AI module can also put `{"priority":9,"alert_type":"fire"}` in `event_data`, which wins.
* **Time zone.** The M-NVR stores naive local times. Run the bridge on the M-NVR host with the same `TZ`.
* **Clip boundaries.** M-NVR segments are 2 min (`segment_duration_sec`), so a delivered clip covers whole segments (up to a segment wider than asked); the officer marks the exact section in RPF.
* **Playback.** The M-NVR records H.265 by default; stock Chrome/Chromium often cannot play it in the CMS/RPF players (Save to PC still works). Stitching HEVC+AAC was verified.
* **Camera matching** is by name; otherwise set `CAMERA_MAP=mnvrId:cmsId,...`. Unmatched cameras are logged; alerts go without a camera, footage requests for them fail clearly.
* A GPS fix is needed to route an alert; with none for `ALERT_GPS_WAIT_S` the alert is logged and skipped unless `FALLBACK_LAT/LON` is set.
* Pre-upload schedules are not persisted across a bridge restart. Auth is the fingerprint header (put mTLS in front in production, as the CMS docs say).

## Tests
`cd bridge && npm i && node test/unit.js` (pure logic) and `node test/e2e.js` (needs the CMS, RPF, a database `mnvr` built from `mnvr/database/schema.sql`; it uses a stand-in M-NVR writing the real schema/files). It drives the real RPF and CMS APIs: heartbeat/GPS, alert -> incident -> officer, footage request -> upload -> delivery, a window up to "now", empty window, mid-upload failure + resume, tunnel and back, bridge restart, pre-upload. 34/34 passed here.

## RPF dashboard = one post
Each RPF dashboard serves one Thana / Post. The first time it is opened it shows a registration form (post name, zone, location, officer login) that creates the post and login in the CMS database (existing tables, no schema change) and binds the dashboard to that post. Afterwards only that post's officers can sign in. See `RPF_CMS/rpf/README.md` ("One dashboard, one post"). For an existing install: `bash RPF_CMS/rpf/scripts/start.sh users bind "<post name>"`.

## Accounts and passwords
Plain username + password in all three apps; there is no e-mail or recovery-code flow. `bash start.sh reset-passwords` sets every account to `Admin@123` (service accounts of the analytics worker are left alone). RPF: officers change their own password under *Account* and an officer can set a new one for a colleague on the *Team* tab. CMS: administrators use Users > Reset password. mNVR: Users > Reset password, or on the unit `node backend/api/scripts/reset_password.js <username> [password]`.
