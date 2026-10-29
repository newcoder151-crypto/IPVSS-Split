-- ============================================================================
-- LOG RETENTION
-- Adds recording_settings.log_retention_days — same table/pattern as the
-- existing recording_retention_days column, but governs how long files
-- under logs/ are kept rather than files under storage/recordings.
-- Idempotent. Already included inline in server/schema.sql for fresh
-- installs — this file is for existing deployments that only re-run
-- migrations/, not the full schema.sql.
-- ============================================================================
ALTER TABLE recording_settings
    ADD COLUMN IF NOT EXISTS log_retention_days INTEGER NOT NULL DEFAULT 30;

ALTER TABLE recording_settings
    DROP CONSTRAINT IF EXISTS chk_log_retention;

ALTER TABLE recording_settings
    ADD CONSTRAINT chk_log_retention CHECK (log_retention_days > 0);