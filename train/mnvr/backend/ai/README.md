# AI Services

Two Python processes that power object detection and Smart Search.

| File | Role |
|---|---|
| `sidecar.py` | FastAPI HTTP service — YOLO detection + CLIP embeddings |
| `indexer.py` | Long-running worker — samples live camera streams and populates the search index |

## Running

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Sidecar — must use the venv's own interpreter (see "Gotchas" below)
.venv/bin/python -m uvicorn sidecar:app --host 0.0.0.0 --port 8000

# Indexer — separate process
.venv/bin/python indexer.py
```

`bash ../../scripts/start.sh` starts both, creating and verifying the venv
automatically.

## Sidecar endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | Status, device (`cpu`/`cuda`), loaded models |
| `POST /detect` | YOLO detection on a frame → labels, confidences, bounding boxes |
| `POST /embed-image` | CLIP embedding of a person crop + derived attribute tags |
| `POST /embed-text` | CLIP embedding of a search phrase |

`/embed-image` and `/embed-text` produce vectors in the **same space**, so
cosine similarity between them scores how well a crop matches a description.
That is the entire ranking mechanism behind Smart Search.

Models load lazily on first use — a deployment that only calls `/detect` never
pays CLIP's load cost.

## Indexer

One thread per active camera. Every `SAMPLE_INTERVAL_SECS` it grabs a frame
from `rtsp://<MEDIAMTX_RTSP>/cam_<id>`, detects people, crops each one, embeds
it, saves a thumbnail under `STORAGE_PATH/search_thumbs/<camera_id>/`, and
POSTs the result to `/api/ai/index-detection`.

It never touches PostgreSQL directly — all writes go through the authenticated
API, so the API remains the single point of validation.

| Variable | Default | Purpose |
|---|---|---|
| `API_URL` | `http://localhost:3001` | Node API |
| `API_USER` / `API_PASS` | `admin` / `Admin@123` | Service account login |
| `YOLO_SIDECAR_URL` | `http://localhost:8000` | Sidecar address |
| `MEDIAMTX_RTSP` | `localhost:8554` | MediaMTX RTSP host:port |
| `STORAGE_PATH` | `./storage` | Must match the API's storage root |
| `SAMPLE_INTERVAL_SECS` | `2` | Seconds between sampled frames per camera |
| `POLL_CAMERAS_SECS` | `30` | How often the active-camera list is refreshed |
| `INDEXER_DETECT_CONF` | `0.45` | YOLO confidence threshold |
| `INDEXER_MAX_PEOPLE_PER_FRAME` | `5` | Cap on embeddings per sampled frame |

## Gotchas

- **Always launch via `.venv/bin/python -m uvicorn`,** never a bare `uvicorn`.
  A system-wide `uvicorn` (e.g. from `apt install uvicorn`) runs against the
  *system* Python, which has none of these dependencies — producing a
  confusing `ModuleNotFoundError: No module named 'fastapi'` even though the
  venv is fully installed.
- **`requirements.txt` pins the CPU-only torch build** (`torch==2.5.1+cpu`).
  A plain `pip install torch` pulls the CUDA bundle, dragging in a dozen large
  NVIDIA packages regardless of whether a GPU is present. For GPU use, install
  a CUDA torch into `.venv` explicitly, then delete
  `.venv/.requirements.sha256` so `start.sh` re-verifies once.
- **First CLIP call downloads model weights** (a few hundred MB) and caches
  them. On a slow link that first `/embed-*` request can exceed the API's
  15-second timeout, which looks identical to the service being down — check
  `logs/sidecar.log` to tell the difference.
- **Never copy a `.venv` between folders.** A venv's `bin/pip` has its creation
  path baked into its shebang; a copied venv silently executes the *original*
  interpreter. `start.sh` detects this and rebuilds, but it's worth avoiding.

Tuning and troubleshooting: [`../../docs/SMART_SEARCH.md`](../../docs/SMART_SEARCH.md)

## Analytics worker (`analytics/`) — a third process
Runs the per-camera analytics (`fall_lean`, `crowd`, `smoke`, `rail_obstacle`) and raises events through the API. It has its
own venv, its own `requirements.txt` (a newer `ultralytics` than the sidecar's, for YOLO26) and its own README:
**[analytics/README.md](analytics/README.md)**. `bash ../../scripts/start.sh` starts it (needs `ANALYTICS_USER` /
`ANALYTICS_PASS` in `analytics/.env`; skipped with a message if they are missing).

Switch an analytic on or off for a camera (token from `/api/auth/login`; no worker restart needed, it picks the change up
within 30 s):
```bash
curl -sS -w "  HTTP %{http_code}\n" -X PUT localhost:3001/api/analytics/cameras/<camera_id>/<analytic> \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"enabled":true}'     # or false
```
`<analytic>` is one of `fall_lean`, `crowd`, `smoke`, `rail_obstacle`. All-four loops, the database alternative that needs no
token, and how to read the result are in [analytics/README.md](analytics/README.md#turning-analytics-on-and-off).
