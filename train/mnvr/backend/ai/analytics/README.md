# Analytics worker (CPU-only)

Per-camera AI analytics (fall/lean today; smoke, crowd, rail-obstacle next).
Separate from `sidecar.py` / `indexer.py` on purpose: own venv, own process,
and it never talks to PostgreSQL — only to the Node API.

```
MediaMTX cam_<id> ──► worker.py ──► analyzers/* ──► Event
                         ▲                              │ POST /api/analytics/events
   GET /api/analytics/config                            ▼
   (camera_analytics table)          events table + WebSocket "event.new" + snapshot JPEG
                                     └─► Events page, toast, "Watch" jump-to-recording
```

## Files this change touches
New: everything under `backend/ai/analytics/`, `backend/api/src/routes/analytics.js`,
`backend/api/create-service-user.js`, `database/migrations/006_camera_analytics.sql`.
**Overwritten (small edits; check with `git diff`):**
| File | Change |
|---|---|
| `scripts/start.sh` | new "8b/9 AI Analytics Worker" step (never fatal); `analytics` added to `--stop`/`--status`/log tail; creates `/storage/event_snaps`; indexer login now reads `INDEXER_USER`/`INDEXER_PASS` (defaults unchanged) |
| `backend/api/src/routes/analytics.js` (updated each release) | allow-list of event types per analytic (now incl. `TRACK_NOT_VISIBLE`) |
| `backend/api/src/index.js` | +2 lines: mounts `/api/analytics`; starts the stream auto-discovery sweep |
| `backend/api/src/routes/cameras.js` | create / edit / fix-credentials now auto-discover a missing `rtsp_url` (+26 lines) |
| `backend/api/src/services/onvifClient.js` | adds the missing `getStreamUri()` (callers were silently failing); `probeDevice` now errors on bad credentials instead of returning an empty camera |
| `backend/api/src/services/streamAutoDiscovery.js` (new) | background sweep: fills empty `rtsp_url` for ACTIVE cameras that have credentials; back-off 5 min → 1 h |
| `frontend/src/pages/EventsPage.tsx`, `frontend/src/lib/api.ts` | new event types in the filter/icons; snapshot thumbnail on each event card |

## Setup
1. **Service account.** Do NOT use the seeded `admin`: it has `must_change_password=1`
   (every API call except change-password returns 403) and the UI has no screen to change it.
   ```bash
   cd backend/api && node create-service-user.js analytics-worker '<long random password>'
   ```
2. `cd backend/ai/analytics && cp .env.example .env` and put the same user/password in it.
3. Weights are already in `models/` (they are git-ignored by `*.pt`; deploy by copying).
4. `bash scripts/start.sh` — migrations (incl. 006) are applied automatically on every run;
   the first run builds `backend/ai/analytics/.venv` and installs torch CPU (slow).
   If anything in the analytics step fails it is skipped with a message; the rest of the NVR still starts.
5. **Prove the pipe with no model:** enable the `fake` analytic on an ACTIVE camera and watch
   `bash scripts/start.sh --logs analytics`; an `AI_TEST` event should appear in the UI within ~30 s.
   ```
   PUT /api/analytics/cameras/<id>/fake    {"enabled": true}      (ADMIN token)
   ```
   No admin token yet? Enable it straight in the database instead (safe; same table the API writes):
   ```bash
   psql -h localhost -U mnvr -d mnvr -c "INSERT INTO camera_analytics (camera_id, analytic, enabled) VALUES (<id>, 'fake', true) ON CONFLICT (camera_id, analytic) DO UPDATE SET enabled = true"
   ```
   (The PUT route needs an ADMIN token, which needs the admin's one-time command-line password
   change from docs/QUICK_START.md#first-login — do the indexer fix below before that.)

## IMPORTANT: the existing indexer and the admin password
`start.sh` starts `indexer.py` as `admin / Admin@123`. If you change the admin password while the
indexer is still configured that way, the indexer keeps retrying the old password, and the API locks
an account after 5 failed logins (`auth.js`) — that takes about 25 seconds. Fix the indexer first:
```bash
cd backend/api && node create-service-user.js indexer-worker '<another long password>'
# then in backend/api/.env (start.sh sources it):
#   INDEXER_USER=indexer-worker
#   INDEXER_PASS=<that password>
```
Also fixes the 403 loop in `logs/indexer.log`. (The indexer's separate 8h-token bug is not touched here.)
To unlock any account: `node create-service-user.js <existing user> '<new password>' --reset`.

## Turning analytics on and off
Analytics are switched per camera. The names: `fall_lean`, `crowd`, `smoke`, `rail_obstacle` (and `fake`, a no-model test
that raises a test event every 20 s). Each camera has its own switches, so enabling `crowd` on camera 1 does nothing for camera 2.
The worker checks every 30 s; there is no restart needed, and a new analytic loads its model on the first check after it is enabled.
Pick the camera by its type: `DOOR` -> fall_lean, `INTERIOR` -> crowd and smoke, `DRIVER_CAB` -> rail_obstacle
(`select camera_id, camera_name, camera_type, status from cameras`).

**1. Get a token** (valid 8 hours; run it again in a new terminal or when you get `401`):
```bash
TOKEN=$(curl -s localhost:3001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"YOUR_ADMIN_PASSWORD"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
echo ${#TOKEN}     # a number in the hundreds; 0 means the login failed
```

**2. Define a small helper** (once per terminal; set `CAM` to your camera id):
```bash
CAM=1
analytic() {   # usage: analytic <name> true|false
  curl -sS -w "\n   <- $1 enabled=$2  HTTP %{http_code}\n" -X PUT "localhost:3001/api/analytics/cameras/$CAM/$1" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"enabled\":$2}"
}
```

**3. Switch them** (you want `HTTP 200` each time):
```bash
analytic rail_obstacle true                      # turn ONE on
analytic rail_obstacle false                     # turn ONE off

for a in fall_lean crowd smoke rail_obstacle; do analytic $a true;  done      # turn ALL FOUR on
for a in fall_lean crowd smoke rail_obstacle; do analytic $a false; done      # turn ALL FOUR off
```
Sending only `enabled` never touches the settings you saved earlier (thresholds, zones, shadow mode); turning an analytic off
and on again keeps them.

**No token needed: straight in the database** (replace the `1`s with your camera id):
```bash
# turn ALL FOUR on
psql -h localhost -U mnvr -d mnvr -c "insert into camera_analytics (camera_id, analytic, enabled) select 1, a, true from unnest(array['fall_lean','crowd','smoke','rail_obstacle']) a on conflict (camera_id, analytic) do update set enabled = true, updated_at = now()"

# turn ALL off for that camera
psql -h localhost -U mnvr -d mnvr -c "update camera_analytics set enabled = false, updated_at = now() where camera_id = 1"

# turn ONE off / on
psql -h localhost -U mnvr -d mnvr -c "update camera_analytics set enabled = false, updated_at = now() where camera_id = 1 and analytic = 'smoke'"
psql -h localhost -U mnvr -d mnvr -c "insert into camera_analytics (camera_id, analytic, enabled) values (1, 'smoke', true) on conflict (camera_id, analytic) do update set enabled = true, updated_at = now()"
```

**See what is on right now:**
```bash
psql -h localhost -U mnvr -d mnvr -c "select camera_id, analytic, enabled, updated_at from camera_analytics order by camera_id, analytic"
bash scripts/start.sh --logs analytics        # look for the line:  config: analytics enabled on cam 1 [...]
```
Turning everything off logs `config: no ACTIVE camera has an analytic enabled, so nothing is running` and the camera's analysis
stops within 30 s. New analytics start in **shadow mode** (events are INFO and labelled `[SHADOW]`); see "Shadow mode" below for going live.
Emergency stop of the whole worker: `kill $(cat .pids/analytics.pid)` (it stays off until the next `bash scripts/start.sh`).

## Weights in `models/` (bare filenames only; no paths, no auto-download)
| File | Used by | Status |
|---|---|---|
| `yolo26m-pose.pt` | `fall_lean` | **ported** |
| `smoke_detect.pt` | `smoke` | **ported** |
| `yolo26m.pt` | `crowd` | **ported** |
| `seg_model.pt` + `detect_model.pt` | `rail_obstacle` | **ported** |

## Turning on fall/lean for a camera
```
PUT /api/analytics/cameras/<id>/fall_lean      (starts in SHADOW mode — see below)
{ "enabled": true,
  "params": { "model": "yolo26m-pose.pt", "interval_sec": 0.5,
              "lean_enabled": true,
              "lean_polygon": [[0.45,0.10],[0.72,0.10],[0.72,0.65],[0.45,0.65]] } }
```
`lean_polygon` is **normalized 0..1** (x/width, y/height); leaning stays off until one is set.
Send only `enabled` and/or `params`; omitted fields keep their stored value. All params and
defaults: `analyzers/fall_lean.py`. Edits are picked up within `POLL_CONFIG_SECS` (30 s).
Natural fit by camera type: `DOOR` → fall_lean, `DRIVER_CAB` → rail_obstacle, `INTERIOR` → crowd/smoke.
(To just switch analytics on or off, see "Turning analytics on and off" above.)

## Overcrowding (`crowd`, from person_detection.py)
Counts COCO `person` detections (conf >= 0.40) every `interval_sec` (default 2 s) and raises one `CROWD_DENSITY`
event per crowding episode. It uses ONE shared copy of `yolo26m.pt` for all cameras.
```
PUT /api/analytics/cameras/<id>/crowd
{ "enabled": true,
  "params": { "crowded_above": 8, "clear_at_or_below": 6, "min_sec": 5, "window_sec": 10,
              "zone_polygon": [[0.05,0.20],[0.95,0.20],[0.95,0.95],[0.05,0.95]] } }
```
| Param | Default | Meaning |
|---|---|---|
| `crowded_above` | 8 | crowded when MORE than this many people (same rule as the original script) |
| `clear_at_or_below` | 6 | hysteresis: stays crowded until the smoothed count falls to this (must be < `crowded_above`) |
| `window_sec` | 10 | the count is the MEDIAN of the last N seconds, so one missed/extra detection can't flip it |
| `min_sec` | 5 | must stay over the limit this long before the event |
| `zone_polygon` | none | normalized 0..1 points; only people whose FEET (bottom-centre of the box) are inside count |
| `interval_sec` / `cooldown_sec` | 2 / 300 | how often it looks / minimum gap between events for this camera |
Limits: this is a head-COUNT, not density. Set `crowded_above` per camera (same count means different things in a
vestibule and a small compartment). Start in shadow mode and compare the `people_count` in the events with what you see.

## Smoke (`smoke`, from pipeline.py)
Looks for the model's smoke class every `interval_sec` (default 1 s) and raises one `SMOKE_DETECTED` event per
smoke episode, with a snapshot showing the boxes. One shared copy of `smoke_detect.pt` serves all cameras.
```
PUT /api/analytics/cameras/<id>/smoke      {"enabled": true}
```
Same behaviour as the original, verified against your script: CLAHE preprocessing (pixel-identical output),
conf 0.35, iou 0.35, imgsz 640, and "at least 3 detections in the last 5 samples". Fixed: box coordinates (no longer
rescaled twice), one event per episode instead of one per 30 frames, CPU instead of hard-coded GPU 0, class found by
name (weights with no "smoke"/"fume" class are refused), and a video gap clears the window.
| Param | Default | Meaning |
|---|---|---|
| `persistence_window` / `persistence_trigger` | 5 / 3 | smoke is confirmed when >= trigger of the last `window` samples had a detection |
| `clear_at_or_below` | 0 | once confirmed, stays confirmed until the window holds this few detections (stops flicker re-firing) |
| `conf`, `iou`, `imgsz` | 0.35, 0.35, 640 | passed to the model |
| `use_clahe`, `clahe_clip_limit`, `clahe_tile_size` | true, 2.0, 8 | must match how the model was trained; turn off only to experiment |
| `interval_sec` / `cooldown_sec` | 1 / 120 | how often it looks / minimum gap between events for this camera |
Timing: the original ran ~3 samples/s, so "3 of 5" meant about 1 s; at the default 1 s interval it means 3-5 s.
Set `interval_sec` lower only if the timing log says the CPU keeps up.
Cannot be tested without real footage: the 0.35 threshold (the original says to tune it) and false positives from
steam, dust, glare or exhaust. Run in shadow mode first and review every `[SHADOW]` event.

## Rail obstacles (`rail_obstacle`, from final_video_pipeline.py) — driver's-cab / ego-view camera only
Per sample: `seg_model.pt` finds the rails -> the rail mask is widened into a **track corridor** (perspective-aware
dilation, kernels 11/31/61/101/151 px for the five horizontal bands at 1080p) -> everything outside it is blacked out ->
`detect_model.pt` looks for obstacles in what is left. Enable it ONLY on the camera that looks down the track
(camera type `DRIVER_CAB`); on any other camera it will correctly report "track not visible".
```
PUT /api/analytics/cameras/<id>/rail_obstacle      {"enabled": true}
```
Kept exactly: seg conf 0.30, det conf 0.20, both imgsz 640, the bands and kernel sizes (at 1080p; they scale with the
frame height on other resolutions so the corridor keeps its real-world width; `corridor_scale` widens/narrows it).
Faster but bit-identical (tested against the original code): corridor step ~4x, and mask apply via `cv2.copyTo`
(~1 ms) instead of `bitwise_and(..., mask=)` (~100 ms on a 1080p frame in a benchmark; different CPU, so your numbers will differ).
| Param | Default | Meaning |
|---|---|---|
| `persistence_window` / `persistence_trigger` | 3 / 2 | per CLASS: confirmed when seen in >= trigger of the last `window` samples (the original reported every raw detection) |
| `clear_at_or_below` | 0 | stays confirmed until the window has this few detections (flicker can't re-fire) |
| `seg_conf`, `det_conf`, `seg_imgsz`, `det_imgsz` | 0.30, 0.20, 640, 640 | passed to the models |
| `corridor_scale` | 1.0 | multiplies the dilation kernels (0.2-3.0) |
| `report_rail_lost`, `rail_lost_sec`, `min_rail_area_frac` | true, 15, 0.0005 | raise `TRACK_NOT_VISIBLE` when no rails were found for this long |
| `class_names` | model's own | optional `{"0": "Pedestrian", ...}` override |
| `interval_sec` / `cooldown_sec` | 1 / 120 | how often it looks / minimum gap per class |
Events: `TRACK_OBSTACLE` ("Pedestrian on track ahead", one per class per episode, snapshot shows the corridor in green and the
boxes) and `TRACK_NOT_VISIBLE` (WARNING).
**Read these limits before relying on it**
- *No alarm does not mean the track is clear.* If the rail segmentation finds nothing (tunnel, sharp curve, glare, snow, dirty lens) the
  detector never sees anything. That is why `TRACK_NOT_VISIBLE` exists; treat it as seriously as an obstacle alarm.
- Latency: one sample interval + persistence (about 1-2 s by default) + processing. At 80 km/h a train covers ~22 m per second, so
  the event can arrive 22-44 m of travel after the obstacle first appears. Advisory only until validated on real footage.
- The original has no notion of distance or closeness, and none was added: a person far down the track and one in front of the train
  produce the same event.
- Two models per sample on CPU is the heaviest analytic. The log prints a per-stage line (`segmentation | corridor+mask | detector`)
  every `STATS_INTERVAL_SEC`, next to the usual timing line, so you can see which stage costs what.

## Shadow mode — the default for every real analytic
A newly enabled analytic does NOT raise alarms. Its events appear on the Events page as **INFO** with the title
prefixed **`[SHADOW]`**, and `event_data` records `"shadow": true` and `"would_be_severity": "CRITICAL"`, so you can
review what it *would* have alarmed on, with a snapshot each, while you tune thresholds. The `fake` test analytic is
never shadowed. Cooldowns still apply (default 60 s per event kind; lower it with `cooldown_sec` while tuning).

Go live only after reviewing real footage (look for false positives, and also for obvious misses):
```
PUT /api/analytics/cameras/<id>/fall_lean     {"params": {"shadow": false}}
```
(`shadow` must be a real `true`/`false`; anything else is rejected with a warning and the safe default is used.
Note: a PUT with `params` REPLACES the whole params object, so include your other params too.)
Go back to shadow with `{"shadow": true}`.

## Timing log — does the model keep up on this CPU?
Every `STATS_INTERVAL_SEC` (default 60) each analyzer logs one line, e.g.
```
[cam 1] fall_lean: 112 runs in 60s (1.87/s, wanted 2.00/s) | run avg 310 ms, max 640 ms | lock wait avg 12 ms | keeping up
[cam 1] fall_lean: 31 runs in 60s (0.52/s, wanted 2.00/s) | run avg 1180 ms ... | SLOW: model is slower than interval_sec: ...
```
- `run` = time inside the model; `lock wait` = time queued behind other cameras/analytics (all inference is serialized).
- `SLOW` is logged as a WARNING. The two hints: model slower than the interval -> raise `interval_sec` or use a smaller
  model; waiting on others -> fewer cameras/analytics, longer interval, or a smaller model.
- The first run after start (model warm-up) is logged once as `first run took N ms` and excluded from the averages.
- Read it with `bash scripts/start.sh --logs analytics`.
- Timing lines only exist while an analytic is RUNNING. The worker logs `config: ...` whenever its list changes: either
  `analytics enabled on cam N [fall_lean]` or `no ACTIVE camera has an analytic enabled ...`. First timing line appears
  about one window (60 s) after the first frame is analysed.

## Event types
`PASSENGER_FALLEN`, `PASSENGER_LEANING_OUT` (fall_lean) · `SMOKE_DETECTED` · `CROWD_DENSITY`
(already known to the Events page) · `TRACK_OBSTACLE` · `AI_TEST`. Allow-list: `ANALYTICS` in `routes/analytics.js`.

## Adding an analytic
1. `analyzers/<name>.py`: subclass `Analyzer`, return `Event`s from `process()`.
2. Register in `analyzers/__init__.py`.   3. Add its event types to `ANALYTICS` in `routes/analytics.js`.
(No migration. For a new type, optionally add it to `EVENT_TYPES` in `EventsPage.tsx`.)

## Tests
- Python (no torch/camera/API): `python -m unittest discover -s tests -v`
- API route: from `backend/api`, `node --test tests/analytics-route.test.js tests/stream-autodiscovery.test.js`
- Real database + real routes: `backend/api/tests/integration.pg.js`, `backend/api/tests/autodiscovery.pg.js` (set `DB_*` env vars first)

## CPU notes — read before enabling many cameras
- The stream it reads, `cam_<id>`, is the **watermarked, re-encoded** live stream made by
  stream_manager (`LIVE_VIDEO_CODEC` defaults to `libx265` in `start.sh`), so the CPU is already
  encoding HEVC per camera, and the indexer decodes the same stream. Decoding it again here adds load.
  If a camera has `third_rtsp_url`, `cam_<id>_third` is a lighter low-res feed meant for analytics;
  this worker does not use it yet.
- All inference is serialized behind one lock; if analysis is slower than `interval_sec`, frames are
  dropped, not queued. Measure ms/inference on the real box first (`yolo26m` is a medium model;
  `s`/`n` weights or an ONNX export are the first levers).
- `fall_lean` keeps one private model per camera (ByteTrack state lives on the model object).

## Not verified here
Real YOLO26 inference, real RTSP, the pinned `requirements.txt` install (PyTorch CPU index was
unreachable from my build sandbox), and the first-load behaviour of snapshot thumbnails right after login.

## Automatic stream discovery (camera RTSP URL)
A camera saved without an `rtsp_url` no longer needs manual SQL/curl. Once it has credentials, the API asks the
camera for its stream addresses over ONVIF: immediately when you add/edit it or use **Credentials**, and every
`STREAM_AUTODISCOVERY_SECS` (default 60; `0` = off) for any ACTIVE camera still empty. It only ever fills an EMPTY
`rtsp_url`. `AUTODISCOVER_THIRD_STREAM=false` skips the third stream. Put these in `backend/api/.env`.
The URL lives only in `cameras` (`rtsp_url`, `rec_rtsp_url` NULL = same as rtsp_url, `third_rtsp_url`);
`cameras_config_details` stores credentials only and has no URL column.
Limits: URIs are stored as the camera reports them (a NAT'd camera that reports its LAN address is not rewritten).

## Troubleshooting
- `No module named 'lap'` (fall_lean): ByteTrack needs it. `requirements.txt` now pins `lap==0.5.12`; install with
  `backend/ai/analytics/.venv/bin/pip install -r backend/ai/analytics/requirements.txt` and restart. The analyzer now checks for it
  once at startup and says so, instead of failing on every frame.
- An analyzer that cannot start (missing package or weights) is retried after a cool-off (`ANALYTICS_RESTART_COOLOFF_SEC`, default 120 s),
  not on every config poll.
