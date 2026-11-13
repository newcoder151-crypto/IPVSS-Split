-- =====================================================================
-- CMS migration 006 - removing an M-NVR from the fleet
-- Idempotent: safe to re-run (the launchers apply every migration on each start).
-- A unit that has footage / alerts behind it cannot be deleted without losing that history, so "Delete" in Fleet retires it: status
-- 'removed' hides it from the fleet and blocks its certificate (it can no longer connect or enrol again by itself). Units with no history
-- at all are deleted for real.
-- =====================================================================
ALTER TYPE nvr_status ADD VALUE IF NOT EXISTS 'removed';
