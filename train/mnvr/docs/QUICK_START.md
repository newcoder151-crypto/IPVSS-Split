# Quick Start

## Prerequisites

| Tool | Used for |
|---|---|
| Node.js 18+ and npm | API and frontend |
| Python 3.10+ with `venv` | stream-manager, mediamtx-sync, AI services |
| ffmpeg | live-view push, recording, exports |
| PostgreSQL 14+ (running) and `psql` | database |
| curl | health checks, MediaMTX download |

```bash
sudo apt install -y nodejs npm python3 python3-pip python3-venv ffmpeg postgresql postgresql-client curl
```

The AI sidecar installs torch, ultralytics and open_clip into `backend/ai/.venv`
on first run (large download). If that install fails the launcher logs it and
starts everything else without Smart Search.

## Run

```bash
bash scripts/start.sh --setup-db     # first time only
bash scripts/start.sh                # every run
```

`--setup-db` creates the `mnvr` PostgreSQL user and database (using
`sudo -u postgres` or the `postgres` role), applies `database/schema.sql`, and
runs `backend/api/seed.js` (users and six demo cameras). Every run then applies
all migrations in `database/migrations/`.

Docker is not provided; this is the bare-metal path.

## What starts

| Step | Service | Port | Purpose |
|---|---|---|---|
| 1 | MediaMTX | 8554 / 8889 / 8888 / 9997 | RTSP → WebRTC/HLS (binary downloaded on first run) |
| 2 | mediamtx-sync | – | Cameras in DB → MediaMTX paths every 15 s |
| 3 | AI sidecar | 8000 | YOLO detection, CLIP embeddings |
| 4 | Smart Search indexer | – | Samples live streams, indexes people |
| 5 | Node API | 3001 | REST + WebSocket |
| 6 | stream-manager | – | ffmpeg live push + recording to `/storage/recordings` |
| 7 | Frontend | 8080 | React UI |

PostgreSQL must already be running; the launcher does not start it.

## First login

Open <http://localhost:8080>. Seeded accounts:

| User | Password | Role |
|---|---|---|
| `admin` | `Admin@123` | ADMIN |
| `operator` | `Operator@123` | OPERATOR |

The schema flags the seeded admin with `must_change_password`. While that flag
is set the API answers every call except `/api/auth/me`, `/refresh` and
`/change-password` with `403 MUST_CHANGE_PASSWORD`, and **the UI has no screen
for the change**, so the app will look empty after signing in. Change it once
from the command line:

```bash
TOKEN=$(curl -s localhost:3001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"Admin@123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s localhost:3001/api/auth/change-password -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"current_password":"Admin@123","new_password":"<new strong password, 10+ chars>"}'
```

Or, for a throwaway dev database only:
`psql ... -c "UPDATE users SET must_change_password=0"`.

If you change the admin password, also update `API_USER` / `API_PASS` for the
indexer in `scripts/start.sh` (it logs in to the API with them), ideally to a
dedicated account.

## Access

| URL | What |
|---|---|
| http://localhost:8080 | Web UI |
| http://localhost:3001/api/health | API health |
| http://localhost:8889/cam_1/whep | Camera 1 WebRTC |
| http://localhost:8888/cam_1/index.m3u8 | Camera 1 HLS |
| rtsp://localhost:8554/cam_1 | Camera 1 RTSP re-stream |
| http://localhost:9997/v3/paths/list | MediaMTX paths |

Stream URLs follow the pattern `cam_<camera_id>`.

## Commands

```bash
bash scripts/start.sh --status          # health of every service
bash scripts/start.sh --stop            # stop everything
bash scripts/start.sh --restart         # stop, then start
bash scripts/start.sh --clean           # wipe /storage/recordings and /storage/hls
bash scripts/start.sh --logs api        # also: frontend mediamtx mtxsync stream_manager sidecar indexer
```

## Adding a camera

From **Camera Grid** (works on an empty install):

- **Add Camera**: enter IP, RTSP URL, username, password.
- **Discover & Add Camera**: scan the LAN for ONVIF devices, then supply
  credentials.

Wait about 15 s: `mediamtx-sync` creates the stream path and the live tile
appears.

## Configuration

`start.sh` writes `backend/api/.env` on first run (database, `JWT_SECRET`,
CORS, storage paths, MediaMTX URLs) and `frontend/.env` (`VITE_API_URL`). Edit
`backend/api/.env` and restart. **Set a strong `JWT_SECRET`** (32+ characters;
`openssl rand -hex 32`) and set `NODE_ENV=production` plus an explicit
`CORS_ORIGIN` before exposing the API. The root `.env.example` lists every
variable across services.

### Port 5432 already in use

Set `DB_PORT` in `backend/api/.env` (for example `15432`); `start.sh` reads it
for the schema apply, migrations and health checks.

## Troubleshooting

| Symptom | Check |
|---|---|
| UI loads but every page is empty / 403 | Forced password change, see [First login](#first-login) |
| Tiles stay black | `--logs stream_manager` and `--logs mediamtx`; confirm `http://localhost:9997/v3/paths/list` lists `cam_<id>` |
| Smart Search returns nothing | `--logs indexer`; the sidecar must be up (`curl localhost:8000/health`); results appear only after the indexer has seen people |
| `Cannot connect to PostgreSQL` | Is PostgreSQL running? Run `--setup-db` once; check `DB_*` in `backend/api/.env` |
| `MediaMTX binary not found` | The download failed; fetch it manually into `backend/mediamtx/` (the launcher prints the URL) |
