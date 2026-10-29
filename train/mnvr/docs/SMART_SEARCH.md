# Smart Search — what changed & how to run it

## What was added
- `person_detections` table (`database/migrations/005_person_search_index.sql`, also in `database/schema.sql`)
- `backend/ai/sidecar.py` — new `/embed-image` and `/embed-text` CLIP endpoints
- `backend/ai/indexer.py` — new service: samples each camera's live stream, detects people, embeds crops, pushes to the API
- `backend/api/src/routes/ai.js` — `POST /api/ai/index-detection` (the only route left in this file; it is now mounted in `index.js` — previously the router was never mounted, so the indexer's POSTs returned 404 and `person_detections` stayed empty)
- `backend/api/src/routes/smart-search.js` — new `POST /api/search/smart`, `GET /api/search/smart/thumbnail/:id`
- Frontend: a **"Smart Search (AI)" tab inside `frontend/src/pages/SearchPage.tsx`**
  at the existing `/search` route — not a separate page or route.

## Before you run it
1. **GPU (optional)**: everything here also runs on CPU, just slower — the
   only knob worth turning is `SAMPLE_INTERVAL_SECS` (raise it if the CPU
   can't keep up with the sampling rate). There is currently no Docker
   deployment in this repo (see `docs/QUICK_START.md`), so the GPU-passthrough
   steps that used to live here (NVIDIA Container Toolkit, a `docker-compose.yml`
   `deploy.resources.reservations.devices` block) don't apply — if you're
   running this bare-metal on a box with a real GPU, install the matching
   CUDA-enabled `torch` build for your driver instead of the CPU wheel in
   `backend/ai/requirements.txt`.
2. **Migration**: if this is an existing deployment (schema already applied
   before Smart Search existed), run `database/migrations/005_person_search_index.sql`
   against your database — `scripts/start.sh` also re-applies every
   migration on every run, so a normal restart picks it up automatically.
   Fresh installs get it via `database/schema.sql` directly.

## How it behaves
- The `indexer` service polls `/api/cameras` every 30s for `ACTIVE` cameras, opens each one's live (already-watermarked) stream at `rtsp://localhost:8554/cam_<id>`, and samples a frame every 2s (`SAMPLE_INTERVAL_SECS`).
- Every person YOLO finds in a sampled frame gets cropped, embedded via CLIP, and pushed to `person_detections` with a thumbnail.
- `POST /api/search/smart` with `{ "prompt": "person in a red t-shirt between 2 and 4pm" }` parses the time range, embeds the descriptive text, and ranks indexed detections by cosine similarity in that window.
- Each result's "Download clip" button reuses the **existing** `/api/streaming/recordings/export` endpoint (no new video-extraction code) — it stitches/trims the actual recording segments around the detection's timestamp.

## Known trade-offs / things to tune
- **Attribute vocabulary**: `_COLORS`/`_CLOTHING` in `sidecar.py` are a starting list (red/blue/.../shirt/jacket/...). The embedding-based ranking works for anything you type, but the human-readable `caption`/`colors`/`clothing` tags shown in the UI are only as good as that phrase bank — extend it if your fleet needs other categories (e.g. "helmet", "high-vis vest").
- **Similarity floor** (`SIMILARITY_FLOOR = 0.18` in `smart-search.js`): CLIP cosine similarities for this kind of query typically land in the 0.2–0.35 range for a real match. If you're getting too many/few results, this is the first knob to turn.
- **Sampling rate vs. cost**: every sampled frame costs one YOLO call + one CLIP call per detected person. `SAMPLE_INTERVAL_SECS=2` and `INDEXER_MAX_PEOPLE_PER_FRAME=5` are conservative defaults — raise the interval if the GPU is saturated with many cameras.
- **Retention**: nothing currently prunes old rows/thumbnails from `person_detections`. Pair it with whatever job already prunes old recordings so the index doesn't outlive the footage it points to.
- The ingest endpoint was verified against a real PostgreSQL (201 and a row in `person_detections`), but the sidecar, models and live cameras were not available when this was last checked; smoke-test with a live camera before relying on it.
