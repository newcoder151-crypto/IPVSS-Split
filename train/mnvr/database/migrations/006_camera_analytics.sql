-- ============================================================================
-- PER-CAMERA AI ANALYTICS (fall/lean, smoke, crowd, rail obstacle, ...)
-- One row per (camera, analytic). Read by backend/ai/analytics/worker.py via
-- GET /api/analytics/config; edited via PUT /api/analytics/cameras/:id/:analytic.
-- Disabled by default: nothing runs until an admin turns it on for a camera.
-- `params` is analytic-specific JSON (thresholds, normalized zone polygons, ...).
-- The set of valid analytic names lives in routes/analytics.js, not here, so
-- adding an analytic never needs a migration. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS camera_analytics (
    camera_id   INTEGER NOT NULL REFERENCES cameras(camera_id) ON DELETE CASCADE,
    analytic    TEXT    NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    params      JSONB   NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by  TEXT,
    PRIMARY KEY (camera_id, analytic)
);

CREATE INDEX IF NOT EXISTS idx_camera_analytics_enabled
    ON camera_analytics (camera_id) WHERE enabled;
