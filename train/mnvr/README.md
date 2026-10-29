# Railway mNVR

A network video recorder for railway deployments: multi-camera live viewing,
continuous recording with retention, ONVIF/PTZ camera control, event and alarm
handling, and AI-powered **Smart Search** ("find a person in a red shirt between
2 and 4 pm") over indexed footage.

**Operator console:** `http://localhost:8080` (default login `admin` / `Admin@123`;
see [First login](docs/QUICK_START.md#first-login)).

---

## Quick start

```bash
# First run: creates the database, applies schema + seed data
bash scripts/start.sh --setup-db

# Every run after that
bash scripts/start.sh
```

| Flag | What it does |
|---|---|
| `--setup-db` | Create the database user/DB, apply the schema, seed users and demo cameras |
| `--stop` / `--restart` | Stop every service / stop then start |
| `--status` | Health-check every service |
| `--logs <svc>` | Tail one log: `api`, `frontend`, `mediamtx`, `mtxsync`, `stream_manager`, `sidecar`, `indexer` |
| `--clean` | Wipe `/storage/recordings` and `/storage/hls` |

Prerequisites and a walkthrough: **[docs/QUICK_START.md](docs/QUICK_START.md)**.

---

## What runs

```
      Cameras (RTSP / ONVIF)
              │
              ▼
      ┌───────────────┐      ┌──────────────────┐
      │   MediaMTX    │◄─────│  mediamtx-sync   │  cameras in DB → stream paths
      │ RTSP/HLS/WebRTC│     └──────────────────┘
      └───────┬───────┘
              │ rtsp://localhost:8554/cam_<id>
    ┌─────────┼───────────────┐
    ▼         ▼               ▼
┌────────┐ ┌──────────┐  ┌─────────────┐
│ stream │ │ indexer  │─►│ AI sidecar  │
│ manager│ │ (search) │  │ YOLO + CLIP │
└───┬────┘ └────┬─────┘  └─────────────┘
    │ SQL       │ HTTP
    ▼           ▼
┌──────────────────┐  HTTP / WS   ┌────────────┐
│   PostgreSQL     │◄─────────────│  Node API  │◄──── Frontend (Vite :8080)
└──────────────────┘              │   :3001    │
                                  └────────────┘
```

| Component | Port | Where |
|---|---|---|
| Frontend (React + Vite) | 8080 | `frontend/` |
| REST + WebSocket API (Node/Express) | 3001 | `backend/api/` |
| AI sidecar (YOLO + CLIP, FastAPI) | 8000 | `backend/ai/sidecar.py` |
| Smart Search indexer | – | `backend/ai/indexer.py` |
| Stream manager (ffmpeg live view + recording) | – | `backend/stream-manager/` |
| MediaMTX + DB→MediaMTX sync | 8554 / 8888 / 8889 / 9997 | `backend/mediamtx/` |
| PostgreSQL | 5432 | `database/` |

How they fit together: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Repository layout

```
.
├── frontend/              React + TypeScript operator console
│   └── src/ pages/ components/ hooks/ contexts/ lib/
├── backend/
│   ├── api/               Node.js REST + WebSocket API
│   │   └── src/ routes/ services/ middleware/ config/
│   ├── ai/                sidecar.py (YOLO + CLIP) and indexer.py
│   ├── stream-manager/    ffmpeg live-view + recording pipeline
│   └── mediamtx/          MediaMTX config + mediamtx-sync.py
├── database/
│   ├── schema.sql         Full schema for fresh installs
│   └── migrations/        Numbered, idempotent, re-applied on every start
├── deploy/nginx.conf      Reverse proxy for production
├── scripts/start.sh       Single-command launcher
└── docs/                  Documentation
```

---

## Screens

| Route | Screen |
|---|---|
| `/` , `/cameras` | Live camera grid (WebRTC, HLS fallback), PTZ / image / audio / stream controls, per-tile AI |
| `/dashboard` | Status cards, recent alerts (live via WebSocket) |
| `/player` | Recording playback, timeline with event markers, time-range export |
| `/search` | Recording search, plus the **Smart Search (AI)** tab |
| `/events` | Event and alarm list, acknowledge |
| `/system-info` | Host and service information, reboot / shutdown |
| `/settings` | Recording, HLS, ONVIF discovery, health thresholds, camera slots |
| `/admin/users` | User administration (ADMIN) |
| `/login`, `/register` | Authentication |

Roles: `ADMIN` (everything), `OPERATOR` (operate cameras, acknowledge events,
manage ONVIF), `VIEWER` (read-only).

---

## Documentation

| Document | Contents |
|---|---|
| [docs/QUICK_START.md](docs/QUICK_START.md) | Prerequisites, first run, first login, troubleshooting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flows, design rules, known gaps |
| [docs/API.md](docs/API.md) | Every HTTP endpoint and the WebSocket protocol |
| [docs/DATABASE.md](docs/DATABASE.md) | Every table, who reads/writes it, triggers, migrations |
| [docs/SMART_SEARCH.md](docs/SMART_SEARCH.md) | AI search setup, tuning, trade-offs |
| [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) | Security review and hardening notes |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | Where code goes, house rules, pre-PR checks |
| [docs/CLEANUP.md](docs/CLEANUP.md) | What was removed in the clean-up, and why |

Component READMEs: [`frontend/`](frontend/README.md) · [`backend/`](backend/README.md) ·
[`backend/api/`](backend/api/README.md) · [`backend/ai/`](backend/ai/README.md) ·
[`database/`](database/README.md)

---

## Configuration

| File | Purpose |
|---|---|
| `backend/api/.env` | Database credentials, JWT secret, CORS origin, storage paths, MediaMTX URLs. Created from defaults by `start.sh` on first run; template: `backend/api/.env.example` |
| `frontend/.env` | `VITE_API_URL` (auto-created by `start.sh`) |
| `backend/mediamtx/mediamtx.yml` | MediaMTX server config |
| `.env.example` (root) | Reference list of every variable across services |

Never commit real `.env` files.

## Development

```bash
cd frontend    && npm install && npm run dev      # http://localhost:8080 (proxies /api, /ws to :3001)
cd backend/api && npm install && npm run dev      # http://localhost:3001
cd frontend    && npm run lint && npm test && npm run build
```
