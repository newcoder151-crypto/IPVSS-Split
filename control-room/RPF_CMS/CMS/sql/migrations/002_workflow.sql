-- =====================================================================
-- CMS migration 002 - end-to-end workflow  (M-NVR -> CMS -> RPF)
-- Idempotent: safe to re-run. Apply as the database owner AFTER schema.sql:
--   psql -d cms -f sql/migrations/002_workflow.sql
-- (run without -1 / --single-transaction: ALTER TYPE ... ADD VALUE.)
--
-- What it adds
--   * request_status: awaiting_upload / failed / expired
--   * incident: manual-raise path (no alert needed), source, title, camera ...
--   * alert_delivery: how the alert reached the post (auto / operator / escalation)
--   * video_request: link to incident, original window kept when amended
--   * nvr_command  : CMS -> M-NVR commands (upload-now) delivered on heartbeat
--   * nvr_unit     : train number, last known position, health
--   * video_segment: no-duplicate-ingest index
--   * delivered_footage: real start/end/duration of the stitched file
--   * evidence_flag: flagged SECTION, permanent / timed retention, archive state
--   * video_access_grant: clip range and flag-archive access
--   * notification, setting, job_status, ensure_partitions()
-- =====================================================================

ALTER TYPE request_status ADD VALUE IF NOT EXISTS 'awaiting_upload';
ALTER TYPE request_status ADD VALUE IF NOT EXISTS 'failed';
ALTER TYPE request_status ADD VALUE IF NOT EXISTS 'expired';

-- ---------------------------------------------------------------------
-- incident: can now be raised by an officer with no alert behind it
-- ---------------------------------------------------------------------
ALTER TABLE incident ALTER COLUMN alert_delivery_id DROP NOT NULL;
ALTER TABLE incident
    ADD COLUMN IF NOT EXISTS source       text NOT NULL DEFAULT 'auto',
    ADD COLUMN IF NOT EXISTS title        text,
    ADD COLUMN IF NOT EXISTS description  text,
    ADD COLUMN IF NOT EXISTS priority     smallint,
    ADD COLUMN IF NOT EXISTS nvr_id       bigint REFERENCES nvr_unit(id),
    ADD COLUMN IF NOT EXISTS camera_id    bigint REFERENCES camera(id),
    ADD COLUMN IF NOT EXISTS closed_at    timestamptz,
    ADD COLUMN IF NOT EXISTS closed_by    bigint REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS closing_note text,
    ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now();

-- source: auto     = CMS auto-dispatched a high-priority alert
--         operator = a CMS operator promoted a low-priority alert
--         officer  = an RPF officer raised it from an alert delivered to the post
--         manual   = an RPF officer raised it with no alert (complaint, patrol, ...)
ALTER TABLE incident DROP CONSTRAINT IF EXISTS chk_incident_source;
ALTER TABLE incident ADD  CONSTRAINT chk_incident_source CHECK (source IN ('auto','operator','officer','manual'));
ALTER TABLE incident DROP CONSTRAINT IF EXISTS chk_incident_anchor;
ALTER TABLE incident ADD  CONSTRAINT chk_incident_anchor
    CHECK (alert_delivery_id IS NOT NULL OR (source = 'manual' AND nvr_id IS NOT NULL));

UPDATE incident i
   SET nvr_id = a.nvr_id, camera_id = COALESCE(i.camera_id, a.camera_id), priority = COALESCE(i.priority, a.priority)
  FROM alert_delivery d JOIN alert a ON a.id = d.alert_id AND a.event_time = d.alert_event_time
 WHERE i.alert_delivery_id = d.id AND i.nvr_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_incident_nvr ON incident(nvr_id);

-- ---------------------------------------------------------------------
-- alert_delivery: how it reached the post
-- ---------------------------------------------------------------------
ALTER TABLE alert_delivery
    ADD COLUMN IF NOT EXISTS mode         text NOT NULL DEFAULT 'auto',
    ADD COLUMN IF NOT EXISTS forwarded_by bigint REFERENCES users(id);
ALTER TABLE alert_delivery DROP CONSTRAINT IF EXISTS chk_delivery_mode;
ALTER TABLE alert_delivery ADD  CONSTRAINT chk_delivery_mode CHECK (mode IN ('auto','operator','escalation'));
CREATE INDEX IF NOT EXISTS idx_alert_delivery_unacked ON alert_delivery(sent_at) WHERE ack_at IS NULL;

-- ---------------------------------------------------------------------
-- video_request
-- ---------------------------------------------------------------------
ALTER TABLE video_request
    ADD COLUMN IF NOT EXISTS incident_id          bigint REFERENCES incident(id),
    ADD COLUMN IF NOT EXISTS orig_window_start    timestamptz,
    ADD COLUMN IF NOT EXISTS orig_window_end      timestamptz,
    ADD COLUMN IF NOT EXISTS upload_requested_at  timestamptz,
    ADD COLUMN IF NOT EXISTS fulfilled_at         timestamptz,
    ADD COLUMN IF NOT EXISTS failure_reason       text;
CREATE INDEX IF NOT EXISTS idx_video_request_incident ON video_request(incident_id);
CREATE INDEX IF NOT EXISTS idx_video_request_status_all ON video_request(status);

-- ---------------------------------------------------------------------
-- nvr_unit: train, last position, health (heartbeat)
-- ---------------------------------------------------------------------
ALTER TABLE nvr_unit
    ADD COLUMN IF NOT EXISTS train_no        text,
    ADD COLUMN IF NOT EXISTS firmware        text,
    ADD COLUMN IF NOT EXISTS last_lat        double precision,
    ADD COLUMN IF NOT EXISTS last_lon        double precision,
    ADD COLUMN IF NOT EXISTS last_speed_mps  real,
    ADD COLUMN IF NOT EXISTS health          jsonb;

-- ---------------------------------------------------------------------
-- CMS -> M-NVR commands. The unit is not always reachable (tunnels, no
-- coverage), so commands wait here until the unit's next heartbeat.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nvr_command (
    id            bigserial PRIMARY KEY,
    nvr_id        bigint NOT NULL REFERENCES nvr_unit(id),
    kind          text   NOT NULL CHECK (kind IN ('upload_now','sync_clock','ping')),
    camera_id     bigint REFERENCES camera(id),
    window_start  timestamptz,
    window_end    timestamptz,
    request_id    bigint REFERENCES video_request(id),
    status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sent','acked','done','failed','cancelled')),
    created_by    bigint REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    sent_at       timestamptz,
    acked_at      timestamptz,
    completed_at  timestamptz,
    result        jsonb
);
CREATE INDEX IF NOT EXISTS idx_nvr_command_open ON nvr_command(nvr_id, status) WHERE status IN ('queued','sent','acked');
CREATE INDEX IF NOT EXISTS idx_nvr_command_request ON nvr_command(request_id);

-- ---------------------------------------------------------------------
-- video_segment: the same camera never has two segments with one start
-- (Cl. 3.14 no duplicate ingestion) - makes NVR upload retries safe.
-- ---------------------------------------------------------------------
ALTER TABLE video_segment
    ADD COLUMN IF NOT EXISTS uploaded_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS uq_video_segment_cam_start ON video_segment(camera_id, start_time);

-- ---------------------------------------------------------------------
-- delivered_footage: what the stitched file actually covers. (ADD COLUMN
-- does not fire the insert-only trigger; only new rows carry values.)
-- ---------------------------------------------------------------------
ALTER TABLE delivered_footage
    ADD COLUMN IF NOT EXISTS start_time    timestamptz,
    ADD COLUMN IF NOT EXISTS end_time      timestamptz,
    ADD COLUMN IF NOT EXISTS duration_s    real,
    ADD COLUMN IF NOT EXISTS segment_count integer;

-- ---------------------------------------------------------------------
-- evidence_flag: a flagged SECTION of footage + how long to keep it
--   section_*   which part of the footage is evidence (offsets in the
--               delivered file, plus the absolute times they map to)
--   retain_from / retain_to  the retention period (retain_to NULL = for life)
--   archive_*   the clip copied to permanent storage by CMS
-- ---------------------------------------------------------------------
ALTER TABLE evidence_flag ALTER COLUMN retain_to DROP NOT NULL;
ALTER TABLE evidence_flag
    ADD COLUMN IF NOT EXISTS section_start_s    real,
    ADD COLUMN IF NOT EXISTS section_end_s      real,
    ADD COLUMN IF NOT EXISTS section_from       timestamptz,
    ADD COLUMN IF NOT EXISTS section_to         timestamptz,
    ADD COLUMN IF NOT EXISTS retention          text NOT NULL DEFAULT 'timed',
    ADD COLUMN IF NOT EXISTS incident_id        bigint REFERENCES incident(id),
    ADD COLUMN IF NOT EXISTS archive_status     text NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS archive_path       text,
    ADD COLUMN IF NOT EXISTS archive_sha256     text,
    ADD COLUMN IF NOT EXISTS archive_size_bytes bigint,
    ADD COLUMN IF NOT EXISTS archived_at        timestamptz,
    ADD COLUMN IF NOT EXISTS archive_error      text,
    ADD COLUMN IF NOT EXISTS released_by        bigint REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS released_at        timestamptz,
    ADD COLUMN IF NOT EXISTS release_note       text;

ALTER TABLE evidence_flag DROP CONSTRAINT IF EXISTS chk_flag_retention;
ALTER TABLE evidence_flag ADD  CONSTRAINT chk_flag_retention
    CHECK ((retention = 'permanent' AND retain_to IS NULL) OR (retention = 'timed' AND retain_to IS NOT NULL));
ALTER TABLE evidence_flag DROP CONSTRAINT IF EXISTS chk_flag_section;
ALTER TABLE evidence_flag ADD  CONSTRAINT chk_flag_section
    CHECK ((section_start_s IS NULL AND section_end_s IS NULL)
        OR (section_start_s >= 0 AND section_end_s > section_start_s));
ALTER TABLE evidence_flag DROP CONSTRAINT IF EXISTS chk_flag_archive_status;
ALTER TABLE evidence_flag ADD  CONSTRAINT chk_flag_archive_status
    CHECK (archive_status IN ('pending','archived','failed','purged','not_requested'));
CREATE INDEX IF NOT EXISTS idx_evidence_flag_archive ON evidence_flag(archive_status) WHERE archive_status IN ('pending','failed');

-- ---------------------------------------------------------------------
-- video_access_grant: what a link may serve (whole file, a section, or
-- the archived clip of a flag)
-- ---------------------------------------------------------------------
ALTER TABLE video_access_grant
    ADD COLUMN IF NOT EXISTS footage_id   bigint REFERENCES delivered_footage(id),
    ADD COLUMN IF NOT EXISTS flag_id      bigint REFERENCES evidence_flag(id),
    ADD COLUMN IF NOT EXISTS clip_start_s real,
    ADD COLUMN IF NOT EXISTS clip_end_s   real,
    ADD COLUMN IF NOT EXISTS purpose      text NOT NULL DEFAULT 'view';

-- ---------------------------------------------------------------------
-- notification: in-app notices for posts (footage delivered, request
-- rejected, new alert ...). Cl. 3.15.8; email/SMS channels hang off CMS.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification (
    id          bigserial PRIMARY KEY,
    zone_id     bigint REFERENCES zone(id),
    post_id     bigint REFERENCES rpf_post(id),
    kind        text NOT NULL,
    title       text NOT NULL,
    body        text,
    ref_entity  text,
    ref_id      bigint,
    created_at  timestamptz NOT NULL DEFAULT now(),
    read_at     timestamptz,
    read_by     bigint REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_notification_post ON notification(post_id, id DESC);

-- ---------------------------------------------------------------------
-- setting / job_status
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS setting (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_by bigint REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_status (
    name        text PRIMARY KEY,
    last_run_at timestamptz,
    last_ok     boolean,
    last_ms     integer,
    last_message text,
    runs        bigint NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- Monthly partitions for alert and gps_point: call from cron / the CMS
-- scheduler. Returns how many partitions it created.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_partitions(months_ahead int DEFAULT 3) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    tbl text; m date; nxt date; part text; i int; made int := 0;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['alert','gps_point'] LOOP
        IF to_regclass('public.' || tbl) IS NULL THEN CONTINUE; END IF;
        FOR i IN 0..months_ahead LOOP
            m   := (date_trunc('month', now()) + make_interval(months => i))::date;
            nxt := (m + interval '1 month')::date;
            part := format('%s_%s', tbl, to_char(m, 'YYYY_MM'));
            BEGIN
                IF to_regclass('public.' || part) IS NULL THEN
                    EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', part, tbl, m, nxt);
                    made := made + 1;
                END IF;
            EXCEPTION WHEN invalid_object_definition OR duplicate_table THEN
                NULL; -- that month is already covered by a differently named partition
            END;
        END LOOP;
    END LOOP;
    RETURN made;
END $$;

CREATE TABLE IF NOT EXISTS schema_migration (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migration (version) VALUES ('002_workflow') ON CONFLICT DO NOTHING;
