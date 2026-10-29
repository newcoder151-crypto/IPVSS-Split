-- =====================================================================
-- CMS Database (single central database, v0.1)
-- Postgres 15+ with PostGIS
--
-- Design notes:
--   * All zones share one database. Zone isolation is enforced by a
--     zone_id column on every zone-scoped table, plus foreign keys
--     and check constraints. Row-Level Security policies are provided
--     (commented) to enforce isolation at the database level, not just
--     in application code.
--   * alert and gps_point are the highest-volume tables and are
--     RANGE-partitioned by month. Create new partitions ahead of time
--     (via cron or pg_partman) before each month starts.
--   * Video files are assumed to live in per-zone/per-region object
--     storage; this database stores only the metadata and the pointer
--     (storage_region + object_key) to reach the object.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- for gen_random_uuid() if needed later

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------

CREATE TYPE user_role       AS ENUM ('super_admin', 'zone_admin', 'operator', 'post_user');
CREATE TYPE nvr_status      AS ENUM ('active', 'inactive', 'suspended');
CREATE TYPE alert_status    AS ENUM ('new', 'routed', 'acknowledged', 'escalated', 'dismissed', 'resolved');
CREATE TYPE routing_mode    AS ENUM ('auto', 'manual');
CREATE TYPE upload_status   AS ENUM ('pending', 'partial', 'complete', 'failed');
CREATE TYPE request_status  AS ENUM ('submitted', 'approved', 'rejected', 'amended', 'fulfilled', 'cancelled');

-- =====================================================================
-- REGISTRY
-- =====================================================================

CREATE TABLE zone (
    id          bigserial PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rpf_post (
    id           bigserial PRIMARY KEY,
    zone_id      bigint NOT NULL REFERENCES zone(id),
    name         text NOT NULL,
    location     geography(Point, 4326) NOT NULL,
    jurisdiction geography(Polygon, 4326),          -- optional, for future jurisdiction-based routing
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_rpf_post_zone ON rpf_post(zone_id);
CREATE INDEX idx_rpf_post_location ON rpf_post USING gist(location);

CREATE TABLE users (
    id            bigserial PRIMARY KEY,
    zone_id       bigint REFERENCES zone(id),        -- null only for super_admin
    post_id       bigint REFERENCES rpf_post(id),     -- set only for post_user
    role          user_role NOT NULL,
    username      text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    status        text NOT NULL DEFAULT 'active',
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chk_user_scope CHECK (
        (role = 'super_admin' AND zone_id IS NULL AND post_id IS NULL)
        OR (role IN ('zone_admin', 'operator') AND zone_id IS NOT NULL AND post_id IS NULL)
        OR (role = 'post_user' AND zone_id IS NOT NULL AND post_id IS NOT NULL)
    )
);
CREATE INDEX idx_users_zone ON users(zone_id);
CREATE INDEX idx_users_post ON users(post_id);

CREATE TABLE nvr_unit (
    id               bigserial PRIMARY KEY,
    name             text NOT NULL,
    cert_fingerprint text NOT NULL UNIQUE,
    current_zone_id  bigint REFERENCES zone(id),
    status           nvr_status NOT NULL DEFAULT 'active',
    last_seen        timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_nvr_unit_zone ON nvr_unit(current_zone_id);

-- History of which zone a unit belonged to, over time. Exactly one row
-- per unit has assigned_until IS NULL (the current assignment).
CREATE TABLE nvr_zone_assignment (
    id              bigserial PRIMARY KEY,
    nvr_id          bigint NOT NULL REFERENCES nvr_unit(id),
    zone_id         bigint NOT NULL REFERENCES zone(id),
    assigned_from   timestamptz NOT NULL,
    assigned_until  timestamptz          -- null = currently active assignment
);
CREATE INDEX idx_vza_nvr_time ON nvr_zone_assignment(nvr_id, assigned_from);
-- Only one open (current) assignment per unit at a time:
CREATE UNIQUE INDEX uq_vza_open_assignment
    ON nvr_zone_assignment(nvr_id)
    WHERE assigned_until IS NULL;

CREATE TABLE camera (
    id             bigserial PRIMARY KEY,
    nvr_id         bigint NOT NULL REFERENCES nvr_unit(id),
    name           text NOT NULL,
    mount_position text,               -- e.g. coach number / position
    onvif_ref      text,
    active         boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_camera_nvr ON camera(nvr_id);

-- =====================================================================
-- ALERTS  (partitioned by month on event_time)
-- =====================================================================

CREATE TABLE alert (
    id              bigserial,
    nvr_id          bigint NOT NULL REFERENCES nvr_unit(id),
    nvr_event_id    text NOT NULL,          -- id assigned by the NVR; makes retries idempotent
    camera_id       bigint REFERENCES camera(id),
    zone_id         bigint NOT NULL REFERENCES zone(id),   -- zone that owned the unit at event_time
    alert_type      text NOT NULL,
    priority        smallint NOT NULL,
    event_time      timestamptz NOT NULL,   -- when it happened, per the NVR
    received_time   timestamptz NOT NULL DEFAULT now(),
    location        geography(Point, 4326) NOT NULL,   -- GPS at point of event
    fix_age_s       integer,
    fix_quality     text,
    status          alert_status NOT NULL DEFAULT 'new',
    routing_mode    routing_mode NOT NULL,
    assigned_post_id bigint REFERENCES rpf_post(id),

    PRIMARY KEY (id, event_time),
    UNIQUE (nvr_id, nvr_event_id, event_time)
) PARTITION BY RANGE (event_time);

CREATE INDEX idx_alert_zone_time ON alert(zone_id, event_time);
CREATE INDEX idx_alert_post ON alert(assigned_post_id);
CREATE INDEX idx_alert_location ON alert USING gist(location);
CREATE INDEX idx_alert_nvr_time ON alert(nvr_id, event_time);

-- Example monthly partitions -- create ahead of need, automate via cron/pg_partman
CREATE TABLE alert_2026_09 PARTITION OF alert
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE alert_2026_10 PARTITION OF alert
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE TABLE alert_delivery (
    id              bigserial PRIMARY KEY,
    alert_id        bigint NOT NULL,
    alert_event_time timestamptz NOT NULL,   -- carried along to match the partitioned alert PK
    post_id         bigint NOT NULL REFERENCES rpf_post(id),
    sent_at         timestamptz NOT NULL DEFAULT now(),
    ack_at          timestamptz,
    ack_by          bigint REFERENCES users(id),
    escalated_from  bigint REFERENCES alert_delivery(id),

    FOREIGN KEY (alert_id, alert_event_time) REFERENCES alert(id, event_time),
    UNIQUE (id, post_id)    -- FK target for incident, keeps incident.post_id consistent with the delivery
);
CREATE INDEX idx_alert_delivery_alert ON alert_delivery(alert_id);
CREATE INDEX idx_alert_delivery_post ON alert_delivery(post_id);

CREATE TABLE alert_history (
    id                bigserial PRIMARY KEY,
    alert_id          bigint NOT NULL,
    alert_event_time  timestamptz NOT NULL,
    changed_by        bigint REFERENCES users(id),
    from_status       alert_status,
    to_status         alert_status NOT NULL,
    changed_at        timestamptz NOT NULL DEFAULT now(),
    note              text,

    FOREIGN KEY (alert_id, alert_event_time) REFERENCES alert(id, event_time)
);
CREATE INDEX idx_alert_history_alert ON alert_history(alert_id);

-- =====================================================================
-- VIDEO
-- =====================================================================

CREATE TABLE video_segment (
    id             bigserial PRIMARY KEY,
    nvr_id         bigint NOT NULL REFERENCES nvr_unit(id),
    camera_id      bigint NOT NULL REFERENCES camera(id),
    zone_id        bigint NOT NULL REFERENCES zone(id),   -- zone that owned the unit when recorded
    start_time     timestamptz NOT NULL,
    end_time       timestamptz NOT NULL,
    storage_region text NOT NULL,          -- which object store this lives in
    object_key     text NOT NULL,
    size_bytes     bigint,
    sha256         text,
    upload_status  upload_status NOT NULL DEFAULT 'pending',
    start_location geography(Point, 4326),
    end_location   geography(Point, 4326),
    created_at     timestamptz NOT NULL DEFAULT now(),

    CHECK (end_time > start_time)
);
CREATE INDEX idx_video_segment_camera_time ON video_segment(camera_id, start_time, end_time);
CREATE INDEX idx_video_segment_zone_time ON video_segment(zone_id, start_time);
CREATE INDEX idx_video_segment_status ON video_segment(upload_status) WHERE upload_status <> 'complete';

CREATE TABLE upload_session (
    id               bigserial PRIMARY KEY,
    segment_id       bigint NOT NULL UNIQUE REFERENCES video_segment(id),
    bytes_received   bigint NOT NULL DEFAULT 0,
    total_bytes      bigint,
    last_chunk_index integer,
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- GPS TRACK  (partitioned by month, highest row-count table)
-- =====================================================================

CREATE TABLE gps_point (
    nvr_id      bigint NOT NULL REFERENCES nvr_unit(id),
    ts          timestamptz NOT NULL,
    location    geography(Point, 4326) NOT NULL,
    speed_mps   real,
    fix_quality text,

    PRIMARY KEY (nvr_id, ts)
) PARTITION BY RANGE (ts);

CREATE TABLE gps_point_2026_09 PARTITION OF gps_point
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE gps_point_2026_10 PARTITION OF gps_point
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE INDEX idx_gps_point_location ON gps_point USING gist(location);

-- =====================================================================
-- VIDEO REQUESTS
-- =====================================================================

CREATE TABLE video_request (
    id             bigserial PRIMARY KEY,
    post_id        bigint NOT NULL REFERENCES rpf_post(id),
    requested_by   bigint NOT NULL REFERENCES users(id),
    alert_id       bigint,                 -- optional link; not a hard FK (see note below)
    alert_event_time timestamptz,
    camera_id      bigint NOT NULL REFERENCES camera(id),
    window_start   timestamptz NOT NULL,
    window_end     timestamptz NOT NULL,
    reason         text,
    status         request_status NOT NULL DEFAULT 'submitted',
    operator_id    bigint REFERENCES users(id),
    decided_at     timestamptz,
    decision_note  text,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CHECK (window_end > window_start)
);
CREATE INDEX idx_video_request_post ON video_request(post_id);
CREATE INDEX idx_video_request_status ON video_request(status) WHERE status = 'submitted';
CREATE INDEX idx_video_request_camera_window ON video_request(camera_id, window_start, window_end);

-- Note: video_request.alert_id deliberately has no FK to alert. A request
-- can be raised well after the alert's partition context is gone, and
-- video may exist without a matching alert. Match by camera_id + time
-- window in queries instead of relying on a hard foreign key.

CREATE TABLE video_access_grant (
    id          bigserial PRIMARY KEY,
    request_id  bigint NOT NULL REFERENCES video_request(id),
    user_id     bigint NOT NULL REFERENCES users(id),
    token_hash  text NOT NULL,
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz
);
CREATE INDEX idx_video_access_grant_request ON video_access_grant(request_id);
CREATE UNIQUE INDEX uq_video_access_grant_token ON video_access_grant(token_hash);

-- =====================================================================
-- INCIDENTS AND EVIDENCE
-- =====================================================================

-- An incident is raised by a person about one specific delivery of an
-- alert to a post. It anchors on alert_delivery only: the alert is
-- reached through alert_delivery (alert_id + alert_event_time), and the
-- composite FK below guarantees incident.post_id can never disagree
-- with the delivery's own post_id.
-- alert_type / location / occurred_at are write-once snapshots so the
-- incident record stays complete even if the alert row is archived.
-- status values are text + CHECK (not enums) because they are provisional
-- and CHECK constraints are easy to change later.
CREATE TABLE incident (
    id                bigserial PRIMARY KEY,
    alert_delivery_id bigint NOT NULL,
    post_id           bigint NOT NULL,
    alert_type        text NOT NULL,
    location          geography(Point, 4326) NOT NULL,
    occurred_at       timestamptz NOT NULL,
    status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'under_review', 'closed')),
    raised_by         bigint NOT NULL REFERENCES users(id),
    created_at        timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (alert_delivery_id, post_id) REFERENCES alert_delivery(id, post_id)
);
CREATE INDEX idx_incident_delivery ON incident(alert_delivery_id);
CREATE INDEX idx_incident_post ON incident(post_id);
CREATE INDEX idx_incident_open ON incident(status) WHERE status <> 'closed';

-- One row per footage file actually handed to a post. delivered_at is an
-- addition (not in the original field list) for chain of custody.
CREATE TABLE delivered_footage (
    id               bigserial PRIMARY KEY,
    video_request_id bigint NOT NULL REFERENCES video_request(id),
    storage_path     text NOT NULL,
    format           text NOT NULL,
    sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    file_size_bytes  bigint NOT NULL CHECK (file_size_bytes > 0),
    delivered_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_delivered_footage_request ON delivered_footage(video_request_id);

-- Delivered footage is evidence: rows are insert-only. A trigger is used
-- instead of REVOKE because triggers also apply to the table owner,
-- whereas privileges cannot be revoked from an owner.
CREATE FUNCTION forbid_row_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% on % is not allowed: rows are insert-only', TG_OP, TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER delivered_footage_insert_only
    BEFORE UPDATE OR DELETE ON delivered_footage
    FOR EACH ROW EXECUTE FUNCTION forbid_row_modification();

-- Marks delivered footage that must be kept beyond normal retention.
-- Assumes "footing_id" in the field list meant footage_id.
CREATE TABLE evidence_flag (
    id            bigserial PRIMARY KEY,
    footage_id    bigint NOT NULL REFERENCES delivered_footage(id),
    retain_from   timestamptz NOT NULL,
    retain_to     timestamptz NOT NULL,
    justification text NOT NULL,
    flagged_by    bigint NOT NULL REFERENCES users(id),
    flagged_at    timestamptz NOT NULL DEFAULT now(),
    status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'archived', 'released')),

    CHECK (retain_to > retain_from),
    CHECK (length(trim(justification)) > 0)
);
CREATE INDEX idx_evidence_flag_footage ON evidence_flag(footage_id);
CREATE INDEX idx_evidence_flag_active ON evidence_flag(status) WHERE status = 'active';

-- =====================================================================
-- AUDIT LOG  (append-only)
-- =====================================================================

CREATE TABLE audit_log (
    id          bigserial PRIMARY KEY,
    actor_id    bigint REFERENCES users(id),
    action      text NOT NULL,
    entity      text NOT NULL,
    entity_id   bigint,
    zone_id     bigint REFERENCES zone(id),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    details     jsonb
);
CREATE INDEX idx_audit_log_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_log_zone_time ON audit_log(zone_id, occurred_at);

-- Enforce append-only at the database level: no role should be able to
-- UPDATE or DELETE audit rows, including the application's own DB user.
-- REVOKE UPDATE, DELETE ON audit_log FROM app_role;

-- =====================================================================
-- ROW-LEVEL SECURITY (recommended, not yet enabled)
--
-- Enforces zone isolation at the database level instead of trusting
-- every query in the application to filter by zone_id correctly.
-- The application sets a session variable per connection after
-- authenticating the user, e.g.:
--   SET app.current_zone_id = '3';
--   SET app.is_super_admin  = 'false';
-- =====================================================================

-- ALTER TABLE rpf_post ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY rpf_post_zone_isolation ON rpf_post
--     USING (
--         current_setting('app.is_super_admin', true) = 'true'
--         OR zone_id = current_setting('app.current_zone_id', true)::bigint
--     );

-- ALTER TABLE alert ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY alert_zone_isolation ON alert
--     USING (
--         current_setting('app.is_super_admin', true) = 'true'
--         OR zone_id = current_setting('app.current_zone_id', true)::bigint
--     );

-- Repeat the same pattern for: users, nvr_unit, camera, video_segment,
-- video_request, audit_log. Cross-zone video requests (section 5.6 of the
-- architecture doc) will need a narrow, explicit exception rather than a
-- blanket policy -- flagging this so it isn't forgotten when RLS is turned on.