-- ============================================================================
-- SMART SEARCH — PERSON DETECTION INDEX
-- Backs POST /api/search/smart. Populated in near-real-time by
-- server/ai/indexer.py, which samples each camera's live stream, runs YOLO
-- person detection + a CLIP embedding on each detected person crop, and
-- pushes the result to POST /api/ai/index-detection.
--
-- Search works by embedding the free-text part of the user's prompt with
-- the same CLIP text tower (sidecar's /embed-text) and ranking rows in this
-- table by cosine similarity against `embedding` within the requested time
-- window — this is what makes "person in a red t-shirt" match footage even
-- though nothing ever explicitly tagged "red t-shirt" ahead of time.
--
-- `embedding` is stored as a JSON array of floats rather than a pgvector
-- column so this works on a stock postgres:16 image with no extra
-- extension to install. Candidate rows are always narrowed by the
-- occurred_at/camera_id WHERE clause first, so the in-app cosine-similarity
-- pass only ever runs over a bounded window, not the whole table.
-- Idempotent, matches the style of the other files in this directory.
-- ============================================================================

CREATE TABLE IF NOT EXISTS person_detections (
    detection_id   SERIAL PRIMARY KEY,
    camera_id      INTEGER NOT NULL REFERENCES cameras(camera_id) ON DELETE CASCADE,
    occurred_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Bounding box of the detected person within the sampled frame (pixels).
    bbox_x1        DOUBLE PRECISION,
    bbox_y1        DOUBLE PRECISION,
    bbox_x2        DOUBLE PRECISION,
    bbox_y2        DOUBLE PRECISION,
    confidence     DOUBLE PRECISION,

    -- Relative path under STORAGE_PATH/search_thumbs, e.g. "3/<uuid>.jpg".
    thumbnail_path TEXT NOT NULL,

    -- JSON array of floats — CLIP image-embedding of the person crop.
    embedding      TEXT NOT NULL,

    -- JSON object with quick human-readable tags the indexer derived via
    -- CLIP zero-shot scoring against a small attribute bank, e.g.
    -- {"colors":["red"],"clothing":["shirt"],"caption":"a person in a red shirt"}
    -- Not authoritative for ranking (the embedding is), but cheap to show
    -- in the UI and useful as a keyword fallback/boost.
    attributes     TEXT DEFAULT '{}',

    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_person_detections_time
    ON person_detections(occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_person_detections_camera_time
    ON person_detections(camera_id, occurred_at DESC);

-- Housekeeping: nothing here enforces retention on its own — pair this with
-- the same retention job/cron that already prunes old recordings, deleting
-- rows (and their thumbnail files) past RETENTION_DAYS, so the index doesn't
-- outlive the footage it points at.
