# API Reference

Base URL `http://<host>:3001`. All JSON endpoints use `Content-Type: application/json`.
Errors are `{ "error": "message" }`. `GET /api/health` is the only unauthenticated
endpoint besides `POST /api/auth/login`.

## Conventions

**Authentication.** `Authorization: Bearer <token>` using the token from
`POST /api/auth/login` (HS256, issuer `railway-nvr-api`, 8 h).

**Media tokens.** `<img>`/`<video>` can't send headers, so media endpoints
(*media* in the tables below) also accept `?token=<media token>` from
`GET /api/auth/media-token` (5 minutes, `purpose: media`). A login token in a
URL is rejected with 401.

**Forced password change.** If the account has `must_change_password`, every
endpoint except `GET /api/auth/me`, `POST /api/auth/refresh` and
`POST /api/auth/change-password` returns `403 { code: "MUST_CHANGE_PASSWORD" }`.

**Roles.** `ADMIN`, `OPERATOR`, `VIEWER`. *any* = every authenticated role.

**Pagination.** List endpoints take `limit` (default 100, or 50 for recordings; max 500)
and `offset`, and return `{ <items>, total, limit, offset }`.

**Status codes.** 400 invalid input · 401 missing/invalid/expired token ·
403 role not allowed / forced password change / origin not allowed · 404 not
found · 409 conflict · 429 rate limited · 502/503 upstream (camera, sidecar,
MediaMTX) unreachable · 500 unexpected (generic message in production).

**Rate limits.** 300 requests/min per IP on `/api` (`API_RATE_LIMIT`); login and
register: 10 attempts per 15 min per IP + username. Five failed logins lock the
account (`is_locked`); an admin unlocks it with `PUT /api/users/:id`.

---

## Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | none | `{ "status": "ok" }` |

## Auth: `/api/auth`

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/login` | none | Body `{ username, password }` → `{ token, must_change_password, user }`. 401 bad credentials, 403 locked |
| GET | `/me` | any | Current user profile |
| POST | `/refresh` | any | New login token for the current user |
| POST | `/change-password` | any | Body `{ current_password, new_password }`; clears `must_change_password`. Password policy: 10+ characters, common passwords rejected |
| GET | `/media-token` | any | `{ token, expires_in }` for media URLs |
| POST | `/register` | ADMIN | Body `{ username, password, full_name, email, role }`. Admin-only; there is no public sign-up |

## Cameras: `/api/cameras`

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/` | any | Query `status`, `camera_type`, `location`, `limit`, `offset` → `{ cameras, total, limit, offset }` with latest health (`is_online`, `is_recording`) joined. Credentials are never returned |
| GET | `/:id` | any | One camera |
| POST | `/` | ADMIN | Create. `camera_name` required; also `camera_type` (INTERIOR, EXTERIOR, DOOR, DRIVER_CAB), `ip_address`, `rtsp_url`, `rec_rtsp_url`, `third_rtsp_url`, `rtsp_port`, `username`, `password_hash`, `onvif_port`, `manufacturer`, `model`, `resolution_width/height`, `target_fps`, `video_codec`, `location_description`, `physical_position`, `ptz_supported`, `audio_supported`, `ai_model`, `ai_confidence_threshold` (0–1), `ai_detection_enabled`. Broadcasts `camera.created` |
| PUT | `/:id` | ADMIN, OPERATOR | Partial update of the same fields. Broadcasts `camera.updated` |
| PUT | `/:id/credentials` | ADMIN | Body `{ username, password_hash }` |
| DELETE | `/:id` | ADMIN | Delete. Broadcasts `camera.deleted` |

## Recordings: `/api/recordings`

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/` | any | Query `camera_id`, `start_date`, `end_date` (against `start_timestamp`), `status`, `q` (camera name/location), `limit`, `offset` → `{ recordings, total, limit, offset }`, newest first |

## Streaming: `/api/streaming` (*media*)

| Method | Path | Description |
|---|---|---|
| GET | `/recordings/:id/stream` | MP4 with HTTP Range support (206) |
| GET | `/recordings/:id/download` | Same file as an attachment |
| GET | `/recordings/export?camera_id=&start=&end=` | Trims and concatenates all segments overlapping `[start, end]` into one MP4 (ffmpeg). 400 if parameters are missing/invalid, `start >= end`, the range exceeds `MAX_EXPORT_RANGE_SECONDS` (default 6 h) or spans more than 300 segments; 404 if no segment file exists on disk |
| GET | `/hls/:cameraId/stream.m3u8` | HLS playlist |
| GET | `/hls/:cameraId/:segment` | HLS segment |

Paths from the database are re-validated to sit under `RECORDINGS_PATH` /
`HLS_PATH` before any file is served.

## Events: `/api/events`

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/` | any | Query `camera_id`, `severity`, `event_type`, `acknowledged` (`true`/`false`), `start_date`, `end_date`, `limit`, `offset` → `{ events, total, limit, offset }` |
| POST | `/` | ADMIN, OPERATOR | **Integration ingress.** Body `event_type`, `title` (required), `severity` (INFO, WARNING, ERROR, CRITICAL, EMERGENCY), `camera_id`, `description`, `event_data`, `snapshot_path`, `video_clip_path`, `coach_location`, `gps_latitude`, `gps_longitude`. Broadcasts `event.new` |
| PUT | `/:id/acknowledge` | ADMIN, OPERATOR | Acknowledge one. Broadcasts `event.acknowledged` |
| PUT | `/all/acknowledge` | ADMIN, OPERATOR | Acknowledge all open events → `{ acknowledged }` |
| PUT | `/batch/acknowledge` | ADMIN, OPERATOR | Body `{ event_ids: [] }` (non-empty) → `{ acknowledged }` |

## Users: `/api/users` (ADMIN)

| Method | Path | Description |
|---|---|---|
| GET | `/` | `{ users, total }` |
| POST | `/` | Body `username`, `password`, `full_name`, `email`, `phone`, `role` (default VIEWER) → 201 |
| PUT | `/:id` | Body any of `full_name`, `email`, `phone`, `role`, `is_active`, `is_locked` |
| PUT | `/:id/password` | Body `{ password }`; also clears `must_change_password` |
| DELETE | `/:id` | Delete |

## Config and status: `/api/config`

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/status` | any | `{ cameras, events, recordings, health, storage, system }`: counts by status, unacknowledged events by severity, recording totals, latest `system_health` row, `storage_devices` |
| GET | `/dashboard` | any | `{ totalCameras, activeCameras, totalEvents, unacknowledgedAlerts, cameras, recentAlerts }` |
| GET | `/` | any | `{ config: [...] }`, all `system_config` rows |
| GET | `/:key` | any | One row |
| PUT | `/:key` | ADMIN | Body `{ config_value }`; read-only keys are refused |

## Settings: `/api/settings`

GET is open to any role; PUT/POST/DELETE need ADMIN.

| Path | Methods | Body / notes |
|---|---|---|
| `/health` | GET, PUT | Health thresholds: `poll_interval_sec`, `cpu/mem/disk_warn_threshold`, `cpu/mem/disk_critical_threshold`, `enable_alerts` |
| `/recording` | GET, PUT | `storage_path`, `recording_retention_days`, `log_retention_days`, `segment_duration_sec`, `segment_max_size_mb`, `max_storage_gb`, `enable_audio`, `enable_watermark`. stream-manager polls and applies it |
| `/hls` | GET, PUT | `hls_base`, `hls_segment_sec`, `hls_window_size`, `hls_delete_old_segments` |
| `/onvif` | GET, PUT | `multicast_ip`, `multicast_port`, `discovery_interval_sec`, `probe_timeout_ms`, `enable_discovery` |
| `/cameras` | GET, POST | Camera slots (`cameras_config_details`): `camera_slot`, `ip_address`, `name` required; also location, type, ONVIF and RTSP credentials, manufacturer, model, `is_active`. Passwords are write-only |
| `/cameras/:slot` | PUT, DELETE | Update / remove a slot |

## ONVIF: `/api/onvif`

Per-camera calls use the stored ONVIF credentials (cached connection, 5 min).
An unreachable camera returns `502 { camera_id, error }`.

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/cameras/:id/capabilities` | any | Capability snapshot (drives which control tabs show) |
| GET | `/cameras/:id/profiles` | any | Stream profiles with resolution, fps, bitrate, codec |
| POST | `/cameras/:id/profiles/:token/activate` | ADMIN | Make this profile the live source |
| GET | `/cameras/:id/ptz/status` | any | Current pan/tilt/zoom |
| POST | `/cameras/:id/ptz/move` | OPERATOR, ADMIN | Body `mode` (continuous default), `x`, `y`, `zoom`, `speed`, `timeout` |
| POST | `/cameras/:id/ptz/stop` | OPERATOR, ADMIN | Body `panTilt`, `zoom` (both default true) |
| POST | `/cameras/:id/ptz/home` | OPERATOR, ADMIN | Go to home |
| GET | `/cameras/:id/ptz/presets` | any | `{ live, presets }` |
| POST | `/cameras/:id/ptz/presets` | OPERATOR, ADMIN | Body `{ name }` saves the current position |
| POST | `/cameras/:id/ptz/presets/:token/goto` | OPERATOR, ADMIN | Body `speed` optional |
| DELETE | `/cameras/:id/ptz/presets/:token` | ADMIN | Remove preset |
| GET / PUT | `/cameras/:id/image` | any / OPERATOR, ADMIN | `brightness`, `contrast`, `saturation`, `sharpness`, `ir_cut_filter`, `wide_dynamic_range`, `exposure_mode` |
| GET / PUT | `/cameras/:id/audio` | any / OPERATOR, ADMIN | `encoding`, `bitrate_kbps`, `sample_rate_khz`, `is_enabled` |
| GET | `/discover?timeout_ms=` | ADMIN, OPERATOR | WS-Discovery probe (1–15 s, default 4 s) → `{ count, devices }` |
| POST | `/discover/probe` | ADMIN, OPERATOR | Body `hostname`, `port`, `path`, `username`, `password`: probe one address |

## MediaMTX: `/api/mediamtx`

| Method | Path | Description |
|---|---|---|
| GET | `/cameras` | `{ cameras, mediamtx_api }`: each camera with `webrtc_url` and `hls_url` built from the request host (or `MEDIAMTX_WEB` / `MEDIAMTX_HLS` if set). RTSP credentials are never included |
| GET | `/status` | `{ online, active_paths, api_url, rtsp_url, webrtc_url, hls_url }`; 503 `{ online: false }` if MediaMTX is down |

## System: `/api/system`

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/info` | any | Hostname, platform, CPU, load, memory, uptimes, Node version |
| POST | `/reboot` | ADMIN | Reboots the host |
| POST | `/shutdown` | ADMIN | Shuts the host down |

## Smart Search

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/search/smart` | any | Body `{ prompt, limit = 24 }`. Returns `{ query, interpreted: { time_range, time_phrase, camera_id, description_used }, candidates_scanned, results: [{ detection_id, camera_id, camera_name, location, occurred_at, similarity, caption, thumbnail_url, clip_start, clip_end }] }`. 502 with a hint if the AI sidecar is unreachable |
| GET | `/api/search/smart/thumbnail/:id` | media | Person crop (JPEG) |
| POST | `/api/ai/index-detection` | any | **Internal, called by `backend/ai/indexer.py`.** Body `camera_id`, `thumbnail_path` (`<camera>/<name>.jpg`), `embedding` (1–2048 finite numbers), optional `occurred_at`, `bbox` `[x1,y1,x2,y2]`, `confidence` (0–1), `attributes` → 201 `{ ok: true }`. Feeds `person_detections` |

Clips for a result reuse `/api/streaming/recordings/export` with `clip_start`/`clip_end`.

---

## WebSocket: `ws://<host>:3001/ws?token=<login token>`

The server closes with code 4001 (no token) or 4002 (invalid token), pings every
30 s and drops clients that don't pong.

**Server → client** (`{ type, data }`):

| `type` | When |
|---|---|
| `connection.established` | After connect |
| `event.new` | `POST /api/events` created an event |
| `event.acknowledged` | One event acknowledged |
| `events.batch_acknowledged` | `{ count }` after acknowledge-all / batch |
| `camera.created`, `camera.updated`, `camera.deleted` | Camera changes (no credentials) |
| `pong`, `subscribed`, `error` | Replies to client messages |

**Client → server:** `{ "type": "ping" }`, `{ "type": "subscribe.camera", "data": { "cameraId" } }`,
`{ "type": "unsubscribe.camera", ... }`. Messages over 16 KB are rejected.
