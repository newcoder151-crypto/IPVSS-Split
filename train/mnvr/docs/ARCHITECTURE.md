# Architecture

## Design rules

1. **MediaMTX is the only thing the live pipeline reads cameras through.**
   `stream-manager` pulls each camera once and publishes it into MediaMTX; the
   browser, the Smart Search indexer and every other consumer read
   `rtsp://localhost:8554/cam_<id>` (or its WebRTC/HLS form). Camera
   credentials and reconnection are handled in one place, and the frontend
   never sees camera credentials.
2. **The Node API owns every request that comes from a person or from the
   indexer.** Authentication, role checks and validation live there. Two
   background workers deliberately talk to PostgreSQL directly instead, because
   they run on the same box and must not depend on API availability or hold a
   login: `stream-manager` (writes `recordings` and `camera_health`) and
   `mediamtx-sync` (reads `cameras`).
3. **Heavy work runs in its own process.** YOLO and CLIP live in the AI sidecar
   so a slow model load can't block HTTP requests for the rest of the system.

## Components

| Component | Language | Port | Responsibility |
|---|---|---|---|
| Frontend | TypeScript / React | 8080 | Operator console |
| API | Node.js / Express | 3001 | REST, WebSocket, auth, validation, most DB access |
| AI sidecar | Python / FastAPI | 8000 | `/detect` (YOLO), `/embed-image` and `/embed-text` (CLIP) |
| AI indexer | Python | – | Samples live streams, writes person detections through the API |
| Stream manager | Python / ffmpeg | – | Live view push to MediaMTX, segmented recording, retention, GPS overlay, camera health |
| mediamtx-sync | Python | – | Mirrors cameras in the DB into MediaMTX paths every 15 s |
| MediaMTX | Go binary | 8554 / 8888 / 8889 / 9997 | RTSP, HLS, WebRTC, control API |
| PostgreSQL | – | 5432 | All persistent state |

## Startup order

`scripts/start.sh` runs nine steps, each depending on the last:

1. Environment files (`backend/api/.env`, `frontend/.env`)
2. Prerequisite tools (node, npm, python3, ffmpeg, psql, curl)
3. Database: optional create + schema + seed, then every migration
4. Node dependencies
5. Python venv for the light workers (`backend/.venv`)
6. MediaMTX download/start, then mediamtx-sync
7. AI sidecar (`backend/ai/.venv`) and indexer
8. API, then stream-manager
9. Frontend (Vite)

## Data flows

**Live view:** camera → stream-manager (ffmpeg) → MediaMTX → WebRTC (WHEP) or
HLS → browser. `/api/mediamtx/cameras` returns the playable URLs per camera,
with the host derived from the incoming request so it is correct for any
viewer.

**Recording:** stream-manager writes segments under
`/storage/recordings/cam_<id>/`, upserts a `recordings` row per finished
segment, and enforces retention from `recording_settings`. The API serves them
(`/api/streaming/recordings/:id/stream|download`) and builds time-range exports
by trimming and concatenating segments with ffmpeg
(`/api/streaming/recordings/export`).

**Camera health:** stream-manager inserts a `camera_health` row per camera every
10 s; a trigger refreshes `cameras.last_seen_at`. `GET /api/cameras` joins the
latest row to produce the online / recording badges.

**Smart Search:**

```
indexer samples frame  →  sidecar /detect (YOLO)  →  crop each person
                       →  sidecar /embed-image (CLIP)  →  vector + thumbnail
                       →  POST /api/ai/index-detection  →  person_detections
```

At query time (`POST /api/search/smart`) the prompt is split into a time window
and a description. The description goes to `/embed-text`, producing a vector in
the same space as the stored crops, and rows in the window are ranked by cosine
similarity.

**Events:** created through `POST /api/events` (the integration ingress used by
analytics and external systems). The API broadcasts `event.new` over the
WebSocket and the dashboard and notification bell update live.

## Cross-cutting concerns

**Authentication.** JWT bearer tokens (8 h) for JSON endpoints. `<img>`/`<video>`
can't set headers, so media URLs carry a separate 5-minute `purpose: media`
token (`/api/auth/media-token`), validated by `authenticateMedia`; a normal
login token is rejected in a URL. A user flagged `must_change_password` can
only call `/api/auth/me`, `/refresh` and `/change-password` until it is changed.

**Timestamps.** Every timestamp column is timezone-*naive* and is compared
against naive local wall-clock strings. A UTC conversion anywhere shifts every
time-window query by the local offset (this caused the "Today shows 0
recordings" bug). Use `toApiDateTime()` on the frontend and the equivalent in
`smart-search.js`; never `.toISOString()`.

**Storage layout.**

```
/storage/
├── recordings/cam_<id>/     Recorded segments
├── hls/cam_<id>/            HLS playlists and segments
├── exports/                 Time-range export scratch files
└── search_thumbs/<id>/      Smart Search person crops
```

**Failure isolation.** Services restart independently and retry their own
dependencies; the indexer retries API login rather than requiring the API to be
up first, so startup order is an optimisation, not a hard requirement. The API
logs and survives stray exceptions from third-party libraries (notably ONVIF
discovery) instead of exiting.

## Known gaps

- `person_detections` rows and thumbnails are never pruned and can outlive the
  footage they reference.
- Embeddings are stored as JSON arrays and scanned in-process, not in a vector
  index. Fine inside a bounded time window; would need `pgvector` for very
  large windows.
- The indexer logs in with the seeded admin account (`API_USER`/`API_PASS` in
  `scripts/start.sh`). Create a dedicated low-privilege account for production
  (the endpoint only needs an authenticated user).
- The UI has no screen for the forced password change (see
  [QUICK_START](QUICK_START.md#first-login)).
