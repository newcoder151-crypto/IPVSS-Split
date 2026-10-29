# Backend

Every server-side component. Each subdirectory is an independently runnable
process; `scripts/start.sh` launches them in dependency order.

| Directory | Language | Process | Purpose |
|---|---|---|---|
| `api/` | Node.js | `:3001` | REST + WebSocket API: auth, validation, camera/ONVIF control, search |
| `ai/` | Python | `:8000` + worker | `sidecar.py` (YOLO detection, CLIP embeddings) and `indexer.py` (Smart Search indexing) |
| `stream-manager/` | Python | worker | ffmpeg live view push, segmented recording, retention, GPS overlay, camera health |
| `mediamtx/` | Config + Python | `:8554/:8888/:8889` | Media server config, plus the DB → MediaMTX path sync helper |

## Data flow

Cameras are pulled once by **stream-manager** and published into **MediaMTX**,
which exposes `rtsp://localhost:8554/cam_<id>`, WebRTC and HLS. Browsers and the
AI indexer consume those paths, not the cameras.

Two workers read/write PostgreSQL directly (so they don't depend on the API
being up): stream-manager (`recordings`, `camera_health`) and mediamtx-sync
(reads `cameras`). Everything else goes through the API, including the indexer,
which logs in and POSTs detections.

## Python environments

Two separate virtualenvs, deliberately:

- **`backend/.venv`**: stream-manager, mediamtx-sync. Light (`requests`, `psycopg2-binary`).
- **`backend/ai/.venv`**: the AI services only. Heavy (torch, ultralytics, open_clip, opencv).

Keeping them apart stops torch's dependency tree from being resolved against the
lightweight workers.

See each subdirectory's README or header comments for details, and
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the whole picture.
