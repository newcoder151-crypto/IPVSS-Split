-- ============================================================================
-- THIRD STREAM URL
-- Adds cameras.third_rtsp_url — the ONVIF "ThirdStream" profile (typically
-- a low-res CIF/QVGA feed some cameras expose alongside Main/Sub, used for
-- analytics or a mobile/bandwidth-constrained view). Idempotent.
-- Already included inline in database/schema.sql (the single canonical
-- schema, shared with core/mnvrd) for fresh installs — this file is for
-- existing deployments that only re-run migrations/, not the full schema.sql.
-- ============================================================================
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS third_rtsp_url TEXT;
