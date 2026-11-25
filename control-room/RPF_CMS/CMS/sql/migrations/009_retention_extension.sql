-- =====================================================================
-- CMS migration 009 - asking CMS for a longer retention
--   An RPF officer can ask to keep a flagged recording longer ("extend by N days", "until a new date",
--   "make it permanent") with a justification. A CMS administrator approves (optionally with another date)
--   or rejects it. Only the CURRENT / LAST request lives on the flag (ext_* columns); every request and
--   decision is also written to the append-only audit_log, which is the history.
--   No new table. Idempotent.
-- =====================================================================
ALTER TABLE evidence_flag
    ADD COLUMN IF NOT EXISTS ext_status        text,          -- NULL (never asked) | 'pending' | 'approved' | 'rejected'
    ADD COLUMN IF NOT EXISTS ext_retention     text,          -- what was asked for: 'timed' | 'permanent'
    ADD COLUMN IF NOT EXISTS ext_retain_to     timestamptz,   -- the new end date asked for (NULL when permanent)
    ADD COLUMN IF NOT EXISTS ext_justification text,
    ADD COLUMN IF NOT EXISTS ext_requested_by  bigint REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS ext_requested_at  timestamptz,
    ADD COLUMN IF NOT EXISTS ext_decided_by    bigint REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS ext_decided_at    timestamptz,
    ADD COLUMN IF NOT EXISTS ext_decision_note text;

ALTER TABLE evidence_flag DROP CONSTRAINT IF EXISTS chk_flag_ext_status;
ALTER TABLE evidence_flag ADD  CONSTRAINT chk_flag_ext_status
    CHECK (ext_status IS NULL OR ext_status IN ('pending','approved','rejected'));
ALTER TABLE evidence_flag DROP CONSTRAINT IF EXISTS chk_flag_ext_retention;
ALTER TABLE evidence_flag ADD  CONSTRAINT chk_flag_ext_retention
    CHECK (ext_retention IS NULL OR (ext_retention = 'permanent' AND ext_retain_to IS NULL) OR (ext_retention = 'timed' AND ext_retain_to IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_evidence_flag_ext_pending ON evidence_flag(ext_status) WHERE ext_status = 'pending';
-- the retention register is searched by end date
CREATE INDEX IF NOT EXISTS idx_evidence_flag_retain_to ON evidence_flag(retain_to) WHERE status = 'active';

-- The RPF server's least-privilege role (sql/rpf_app_role.sql) may only WRITE the request half of the columns.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rpf_app') THEN
        GRANT UPDATE (ext_status, ext_retention, ext_retain_to, ext_justification, ext_requested_by, ext_requested_at) ON evidence_flag TO rpf_app;
    END IF;
END $$;

INSERT INTO schema_migration (version) VALUES ('009_retention_extension') ON CONFLICT DO NOTHING;
