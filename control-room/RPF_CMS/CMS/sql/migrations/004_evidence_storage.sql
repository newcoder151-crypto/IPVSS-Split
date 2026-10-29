-- =====================================================================
-- CMS migration 004 - where a flagged recording is kept
--   storage 'cms'   CMS archives the flagged section and keeps it beyond the 30-day limit
--   storage 'local' the RPF post keeps its own copy (saved at flag time) and CMS keeps nothing beyond the
--                   normal 30-day policy; CMS still records the flag, the section, and the retention time
--   storage 'both'  both copies
-- The time entered at the RPF (retain until / for life, and the marked section) is stored for all three.
-- Idempotent.
-- =====================================================================
ALTER TABLE evidence_flag
    ADD COLUMN IF NOT EXISTS storage          text NOT NULL DEFAULT 'cms',
    ADD COLUMN IF NOT EXISTS local_path       text,
    ADD COLUMN IF NOT EXISTS local_sha256     text,
    ADD COLUMN IF NOT EXISTS local_size_bytes bigint,
    ADD COLUMN IF NOT EXISTS local_saved_at   timestamptz,
    ADD COLUMN IF NOT EXISTS local_error      text;

ALTER TABLE evidence_flag DROP CONSTRAINT IF EXISTS chk_flag_storage;
ALTER TABLE evidence_flag ADD  CONSTRAINT chk_flag_storage CHECK (storage IN ('cms','local','both'));
ALTER TABLE evidence_flag DROP CONSTRAINT IF EXISTS chk_flag_archive_status;
ALTER TABLE evidence_flag ADD  CONSTRAINT chk_flag_archive_status
    CHECK (archive_status IN ('pending','archived','failed','purged','not_requested'));

INSERT INTO schema_migration (version) VALUES ('004_evidence_storage') ON CONFLICT DO NOTHING;

-- Housekeeping: notices for alerts that were already acknowledged must not keep counting as unread.
UPDATE notification n SET read_at = now()
 WHERE n.read_at IS NULL AND n.kind = 'alert' AND n.ref_entity = 'alert_delivery'
   AND EXISTS (SELECT 1 FROM alert_delivery d WHERE d.id = n.ref_id AND d.ack_at IS NOT NULL);
