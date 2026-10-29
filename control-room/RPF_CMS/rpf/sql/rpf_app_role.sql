-- =====================================================================
-- OPTIONAL: least-privilege database role for the RPF dashboard.
--
-- RPF shares the CMS database and creates no tables. This file only
-- creates a login role and GRANTs it the minimum RPF needs, so RPF does
-- not have to connect as the schema owner (the open item in
-- CMS_Architecture_v0.2.md section 8). It does not alter any CMS table.
--
-- Run once, as a Postgres superuser:
--   psql -d cms -v rpf_password='choose-a-strong-password' -f sql/rpf_app_role.sql
-- Then set DB_USER=rpf_app and DB_PASSWORD in RPF's .env and run:
--   npm run check-db
--
-- Notes
--  * RPF has no DELETE anywhere, and no UPDATE/DELETE on audit_log or
--    delivered_footage, so the append-only rules hold for this role even
--    before CMS moves them from triggers to revoked privileges.
--  * UPDATE is granted per column: only the status/ack columns RPF changes.
--  * Privileges on the partitioned `alert` parent cover all its monthly
--    partitions, including ones CMS creates later.
--  * SELECT on users is table-wide because login needs password_hash.
--  * scripts/seed_demo.js and scripts/simulate_cms.js are dev tools that
--    write CMS-owned data; run them with the CMS owner credentials, e.g.
--      DB_USER=cms DB_PASSWORD=... npm run simulate-cms -- watch
-- =====================================================================

SELECT format('CREATE ROLE rpf_app LOGIN PASSWORD %L', :'rpf_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rpf_app')
\gexec

GRANT USAGE ON SCHEMA public TO rpf_app;

-- Read
GRANT SELECT ON
    zone, rpf_post, users, nvr_unit, camera,
    alert, alert_delivery, alert_history, incident,
    video_request, video_access_grant, delivered_footage, evidence_flag,
    audit_log, notification
TO rpf_app;

-- Create
GRANT INSERT ON
    rpf_post, users,                       -- first-run registration of this dashboard's post and its officer login
    incident, alert_history, video_request,
    video_access_grant, evidence_flag, audit_log
TO rpf_app;

-- Change (column-limited)
GRANT UPDATE (status)           ON alert          TO rpf_app;  -- acknowledged / resolved
GRANT UPDATE (ack_at, ack_by)   ON alert_delivery TO rpf_app;  -- acknowledgement
GRANT UPDATE (status, closed_at, closed_by, closing_note, updated_at) ON incident TO rpf_app;  -- open -> under_review -> closed
GRANT UPDATE (local_path, local_sha256, local_size_bytes, local_saved_at, local_error) ON evidence_flag TO rpf_app;  -- RPF records its own local copy
GRANT UPDATE (read_at, read_by) ON notification TO rpf_app;  -- officer marks notices read
GRANT UPDATE (status)           ON video_request  TO rpf_app;  -- officer cancels a request
GRANT UPDATE (password_hash, status) ON users TO rpf_app;  -- officer changes own password / forgot-password / team reset and enable-disable

-- Ids for the inserts above
GRANT USAGE ON SEQUENCE
    rpf_post_id_seq, users_id_seq, incident_id_seq, alert_history_id_seq, video_request_id_seq,
    video_access_grant_id_seq, evidence_flag_id_seq, audit_log_id_seq
TO rpf_app;
