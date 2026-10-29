-- ============================================================================
-- Railway mNVR - PostgreSQL schema
-- ============================================================================
-- Database : PostgreSQL 14+   Encoding: UTF-8
--
-- Single source of truth for fresh installs. Used by backend/api (Node),
-- backend/stream-manager, backend/mediamtx-sync and the Smart Search indexer,
-- which all connect to the same "mnvr" database. Only tables that the running
-- system reads or writes are defined here (see docs/DATABASE.md).
--
-- IMPORT
-- ------
-- 1. As the postgres superuser:
--      CREATE USER mnvr WITH PASSWORD 'your_password_here';
--      CREATE DATABASE mnvr OWNER mnvr ENCODING 'UTF8';
-- 2. Import (scripts/start.sh --setup-db does this for you):
--      PGPASSWORD=... psql -h localhost -U mnvr -d mnvr -f database/schema.sql
-- 3. Verify:
--      psql -h localhost -U mnvr -d mnvr -c "\dt"
--
-- IDEMPOTENCY
-- -----------
-- All CREATE TABLE / CREATE INDEX statements use IF NOT EXISTS and all seed
-- INSERTs use ON CONFLICT DO NOTHING, so the file can be re-run safely.
-- Later changes live in database/migrations/ (also idempotent; start.sh
-- re-applies them on every run). Mirror every migration into this file.
--
-- RECOMMENDED postgresql.conf SETTINGS (embedded NVR use)
-- --------------------------------------------------------
-- shared_buffers = 256MB, work_mem = 4MB, synchronous_commit = off,
-- wal_level = minimal, max_wal_size = 1GB, log_min_duration_statement = 1000
-- ============================================================================

-- Set client encoding
SET client_encoding = 'UTF8';

-- Use public schema
SET search_path = public;

BEGIN;

-- ============================================================================
-- SECTION 1: SYSTEM CONFIGURATION
-- ============================================================================

-- Device identification and system configuration
CREATE TABLE IF NOT EXISTS system_config (
    id SERIAL PRIMARY KEY,
    config_key TEXT NOT NULL UNIQUE,
    config_value TEXT NOT NULL,
    config_type TEXT NOT NULL DEFAULT 'STRING', -- STRING, INTEGER, BOOLEAN, JSON
    description TEXT,
    is_readonly INTEGER DEFAULT 0, -- 1 for system-managed, 0 for user-configurable
    last_modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_modified_by TEXT,
    CONSTRAINT chk_config_type CHECK (config_type IN ('STRING', 'INTEGER', 'BOOLEAN', 'JSON'))
);

-- Default system configuration entries
INSERT INTO system_config (config_key, config_value, config_type, description, is_readonly) VALUES
('device_id', '', 'STRING', 'Unique MNVR device identifier (serial number)', 0),
('device_name', 'MNVR-001', 'STRING', 'Human-readable device name', 0),
('firmware_version', '1.0.0', 'STRING', 'Current firmware version', 1),
('installation_date', '', 'STRING', 'Date of system installation', 0),
('coach_number', '', 'STRING', 'Train coach number', 0),
('train_number', '', 'STRING', 'Train identification number', 0),
('recording_retention_days', '30', 'INTEGER', 'Number of days to retain recordings', 0),
('storage_path', '/storage/recordings', 'STRING', 'Base path for video storage', 1),
('max_storage_gb', '4000', 'INTEGER', 'Maximum storage capacity in GB', 0),
('enable_audio', '1', 'BOOLEAN', 'Enable audio recording', 0),
('enable_gps', '1', 'BOOLEAN', 'Enable GPS tracking', 0),
('enable_watermark', '1', 'BOOLEAN', 'Enable video watermarking', 0),
('enable_face_detection', '1', 'BOOLEAN', 'Enable face detection/cropping', 0),
('time_sync_method', 'PTP', 'STRING', 'Primary time sync: PTP, NTP, GPS', 0),
('ptp_domain', '0', 'INTEGER', 'PTP domain number', 0),
('ntp_server', 'pool.ntp.org', 'STRING', 'NTP server address', 0),
('api_server_port', '8443', 'INTEGER', 'HTTPS API server port', 0),
('rtsp_server_port', '554', 'INTEGER', 'RTSP streaming port', 0)
ON CONFLICT (config_key) DO NOTHING;

-- ============================================================================
-- SECTION 2: CAMERA MANAGEMENT
-- ============================================================================

-- Camera configuration and status
CREATE TABLE IF NOT EXISTS cameras (
    camera_id SERIAL PRIMARY KEY,
    camera_name TEXT NOT NULL,
    camera_type TEXT NOT NULL, -- INTERIOR, EXTERIOR, DOOR, DRIVER_CAB
    onvif_device_id TEXT UNIQUE,
    ip_address TEXT NOT NULL,
    rtsp_url TEXT NOT NULL,
    -- Dedicated recording-profile RTSP URL (see nvr_core's onvif_module.c
    -- dual-profile selection). NULL/empty = same as rtsp_url.
    rec_rtsp_url TEXT,
    -- Third ONVIF media profile (a.k.a. "ThirdStream" — most cameras in
    -- this fleet expose Main/Sub/Third profiles, see
    -- onvif_profile_s_extensions.sql). Typically a low-res CIF/QVGA feed
    -- used for analytics or a mobile/bandwidth-constrained view.
    -- NULL/empty = camera doesn't expose one / not configured.
    third_rtsp_url TEXT,
    rtsp_port INTEGER DEFAULT 554,
    username TEXT,
    password_hash TEXT,
    manufacturer TEXT,
    model TEXT,
    firmware_version TEXT,
    resolution_width INTEGER DEFAULT 1920,
    resolution_height INTEGER DEFAULT 1080,
    target_fps INTEGER DEFAULT 25, -- 25 for interior, 45 for exterior
    video_codec TEXT DEFAULT 'H.265',
    location_description TEXT, -- e.g., "Front entrance door", "Passenger area rear"
    physical_position TEXT, -- GPS coordinates or coach position
    ptz_supported INTEGER DEFAULT 0,
    audio_supported INTEGER DEFAULT 0,
    status TEXT DEFAULT 'ACTIVE', -- ACTIVE, INACTIVE, FAULTY, MAINTENANCE
    is_ptp_synced INTEGER DEFAULT 0,
    is_ntp_synced INTEGER DEFAULT 0,
    last_seen_at TIMESTAMP,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Output paths (set by application at provisioning time)
    rec_output_dir TEXT,                         -- MP4 recording output directory, e.g. /storage/recordings/cam_1
    hls_output_dir TEXT,                         -- HLS segments output directory,  e.g. /storage/hls/cam_1
    hls_playlist_url TEXT,                       -- Public HLS playlist URL,         e.g. /hls/cam_1/stream.m3u8
    -- Per-camera AI configuration (see server/migrations/002_ai_model_config.sql)
    ai_model TEXT NOT NULL DEFAULT 'yolov8n.pt',            -- YOLO weights used for this camera's detections
    ai_confidence_threshold NUMERIC(3,2) NOT NULL DEFAULT 0.35,
    ai_detection_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT chk_camera_type CHECK (camera_type IN ('INTERIOR', 'EXTERIOR', 'DOOR', 'DRIVER_CAB')),
    CONSTRAINT chk_camera_status CHECK (status IN ('ACTIVE', 'INACTIVE', 'FAULTY', 'MAINTENANCE')),
    CONSTRAINT chk_video_codec CHECK (video_codec IN ('H.264', 'H.265', 'H.265+'))
);

-- Camera health metrics
CREATE TABLE IF NOT EXISTS camera_health (
    health_id SERIAL PRIMARY KEY,
    camera_id INTEGER NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_online INTEGER DEFAULT 1,
    is_recording INTEGER DEFAULT 1,
    frame_rate_actual DOUBLE PRECISION,
    bitrate_kbps INTEGER,
    packet_loss_percent DOUBLE PRECISION DEFAULT 0.0,
    latency_ms INTEGER,
    temperature_celsius DOUBLE PRECISION,
    uptime_seconds INTEGER,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    FOREIGN KEY (camera_id) REFERENCES cameras(camera_id) ON DELETE CASCADE
);

-- ============================================================================
-- SECTION 3: AUDIO MANAGEMENT
-- ============================================================================

-- Microphone configuration
-- Kept only because recordings.audio_stream_id references it.
CREATE TABLE IF NOT EXISTS microphones (
    mic_id SERIAL PRIMARY KEY,
    mic_name TEXT NOT NULL,
    ip_address TEXT,
    rtsp_url TEXT,
    audio_codec TEXT DEFAULT 'AAC', -- AAC, G.711, G.722, G.726
    sample_rate INTEGER DEFAULT 48000,
    channels INTEGER DEFAULT 2, -- 1=mono, 2=stereo
    bitrate_kbps INTEGER DEFAULT 128,
    location_description TEXT,
    status TEXT DEFAULT 'ACTIVE',
    is_ptp_synced INTEGER DEFAULT 0,
    is_ntp_synced INTEGER DEFAULT 0,
    last_seen_at TIMESTAMP,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_audio_codec CHECK (audio_codec IN ('AAC', 'G.711', 'G.722', 'G.726')),
    CONSTRAINT chk_mic_status CHECK (status IN ('ACTIVE', 'INACTIVE', 'FAULTY', 'MAINTENANCE'))
);

-- ============================================================================
-- SECTION 4: RECORDINGS MANAGEMENT
-- ============================================================================

-- Master recordings table
CREATE TABLE IF NOT EXISTS recordings (
    recording_id SERIAL PRIMARY KEY,
    camera_id INTEGER NOT NULL,
    audio_stream_id INTEGER, -- References mic_id from microphones table
    file_path TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    file_size_bytes INTEGER,
    duration_seconds INTEGER,
    start_timestamp TIMESTAMP NOT NULL,
    end_timestamp TIMESTAMP,
    
    -- Video properties
    video_codec TEXT DEFAULT 'H.265',
    resolution_width INTEGER DEFAULT 1920,
    resolution_height INTEGER DEFAULT 1080,
    fps_actual DOUBLE PRECISION,
    video_bitrate_kbps INTEGER,
    
    -- Audio properties
    has_audio INTEGER DEFAULT 0,
    audio_codec TEXT,
    audio_sample_rate INTEGER,
    audio_channels INTEGER,
    audio_bitrate_kbps INTEGER,
    
    -- Synchronization metadata
    time_source TEXT DEFAULT 'PTP', -- PTP, NTP, GPS, SYSTEM
    ptp_offset_ns INTEGER, -- PTP clock offset in nanoseconds
    ntp_offset_ms INTEGER, -- NTP clock offset in milliseconds
    sync_quality_ms DOUBLE PRECISION, -- Overall sync quality estimate
    audio_sync_offset_ms INTEGER, -- Applied audio latency correction
    
    -- GPS metadata
    gps_latitude DOUBLE PRECISION,
    gps_longitude DOUBLE PRECISION,
    gps_altitude DOUBLE PRECISION,
    gps_speed_kmh DOUBLE PRECISION,
    gps_heading DOUBLE PRECISION,
    gps_satellites INTEGER,
    gps_fix_quality TEXT, -- NO_FIX, 2D, 3D, DGPS
    
    -- Security and integrity
    watermark_enabled INTEGER DEFAULT 0,
    watermark_hash TEXT, -- SHA-256 hash of embedded watermark
    file_integrity_hash TEXT, -- SHA-256 hash of entire file
    is_tampered INTEGER DEFAULT 0,
    
    -- Recording metadata
    recording_mode TEXT DEFAULT 'CONTINUOUS', -- CONTINUOUS, MOTION, ALARM, MANUAL
    trigger_event_id INTEGER, -- References events table if alarm-triggered
    segment_number INTEGER, -- For splitmuxsink 10-minute segments
    
    -- HLS live-view output (populated by HLS module after MP4->TS conversion)
    hls_ts_file_path TEXT,           -- MPEG-TS file produced from this segment, e.g. /storage/hls/cam_1/seg_00001.ts
    hls_ts_file_size_bytes INTEGER,  -- Size of the .ts file in bytes
    hls_segment_duration_sec DOUBLE PRECISION, -- Actual .ts segment duration measured by GStreamer
    hls_playlist_path TEXT,          -- Path to the m3u8 playlist updated after this segment
    hls_conversion_status TEXT DEFAULT 'PENDING', -- PENDING, COMPLETED, FAILED
    hls_converted_at TIMESTAMP,      -- When the .ts was produced

    -- Status
    status TEXT DEFAULT 'RECORDING', -- RECORDING, COMPLETED, EXPORTED, ARCHIVED, DELETED
    is_uploaded_to_cloud INTEGER DEFAULT 0,
    cloud_upload_timestamp TIMESTAMP,
    is_backed_up_to_chm INTEGER DEFAULT 0,
    chm_backup_timestamp TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (camera_id) REFERENCES cameras(camera_id) ON DELETE CASCADE,
    FOREIGN KEY (audio_stream_id) REFERENCES microphones(mic_id) ON DELETE SET NULL,
    -- trigger_event_id FK to events added below via ALTER TABLE (events table defined later)
    
    CONSTRAINT chk_recording_status CHECK (status IN ('RECORDING', 'COMPLETED', 'EXPORTED', 'ARCHIVED', 'DELETED')),
    CONSTRAINT chk_recording_mode CHECK (recording_mode IN ('CONTINUOUS', 'MOTION', 'ALARM', 'MANUAL')),
    CONSTRAINT chk_gps_fix CHECK (gps_fix_quality IN ('NO_FIX', '2D', '3D', 'DGPS', NULL)),
    CONSTRAINT chk_hls_status CHECK (hls_conversion_status IN ('PENDING', 'COMPLETED', 'FAILED'))
);

-- Index for performance optimization
CREATE INDEX IF NOT EXISTS idx_recordings_camera_timestamp ON recordings(camera_id, start_timestamp);
CREATE INDEX IF NOT EXISTS idx_recordings_timestamp ON recordings(start_timestamp);
CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
CREATE INDEX IF NOT EXISTS idx_recordings_hls_status ON recordings(hls_conversion_status, camera_id);

-- ============================================================================
-- SECTION 5: TIME SYNCHRONIZATION
-- ============================================================================

-- GPS tracking breadcrumb trail
CREATE TABLE IF NOT EXISTS gps_track_log (
    track_id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    altitude DOUBLE PRECISION,
    speed_kmh DOUBLE PRECISION,
    heading DOUBLE PRECISION, -- 0-360 degrees
    satellites INTEGER,
    fix_quality TEXT,
    hdop DOUBLE PRECISION,
    vdop DOUBLE PRECISION,
    pdop DOUBLE PRECISION,
    CONSTRAINT chk_gps_fix_log CHECK (fix_quality IN ('NO_FIX', '2D', '3D', 'DGPS'))
);

CREATE INDEX IF NOT EXISTS idx_gps_track_timestamp ON gps_track_log(timestamp);

-- ============================================================================
-- SECTION 6: EVENTS AND ALARMS
-- ============================================================================

-- Unified events table for all system events
CREATE TABLE IF NOT EXISTS events (
    event_id SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL, -- ALARM, PANIC_BUTTON, ETBU, TAMPERING, RECORDING_FAILURE, SYSTEM_ERROR, etc.
    event_subtype TEXT, -- Specific classification
    severity TEXT DEFAULT 'INFO', -- INFO, WARNING, ERROR, CRITICAL, EMERGENCY
    source_device_type TEXT, -- CAMERA, MICROPHONE, GPS, RDAS, CHM, SYSTEM, PANIC_BUTTON, ETBU
    source_device_id INTEGER,
    
    -- Event details
    title TEXT NOT NULL,
    description TEXT,
    event_data TEXT, -- JSON format for additional data
    
    -- Location information
    camera_id INTEGER,
    coach_location TEXT,
    gps_latitude DOUBLE PRECISION,
    gps_longitude DOUBLE PRECISION,
    
    -- Status and handling
    status TEXT DEFAULT 'ACTIVE', -- ACTIVE, ACKNOWLEDGED, RESOLVED, DISMISSED
    is_acknowledged INTEGER DEFAULT 0,
    acknowledged_by TEXT,
    acknowledged_at TIMESTAMP,
    resolution_notes TEXT,
    resolved_at TIMESTAMP,
    
    -- Associated media
    snapshot_path TEXT,
    video_clip_path TEXT,
    audio_clip_path TEXT,
    
    -- Timestamps
    occurred_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (camera_id) REFERENCES cameras(camera_id) ON DELETE SET NULL,
    
    CONSTRAINT chk_event_severity CHECK (severity IN ('INFO', 'WARNING', 'ERROR', 'CRITICAL', 'EMERGENCY')),
    CONSTRAINT chk_event_status CHECK (status IN ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'))
);

CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);

-- Add FK from recordings.trigger_event_id -> events (deferred because events is defined after recordings)
ALTER TABLE recordings DROP CONSTRAINT IF EXISTS fk_recordings_trigger_event;
ALTER TABLE recordings ADD CONSTRAINT fk_recordings_trigger_event
    FOREIGN KEY (trigger_event_id) REFERENCES events(event_id) ON DELETE SET NULL;

-- ============================================================================
-- SECTION 7: ADDITIONAL CAMERA COLUMNS
-- ============================================================================
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS rec_rtsp_url TEXT;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS third_rtsp_url TEXT;

-- ============================================================================
-- SECTION 10: USER MANAGEMENT AND AUTHENTICATION
-- ============================================================================

-- User accounts with role-based access control (RBAC)
CREATE TABLE IF NOT EXISTS users (
    user_id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, -- bcrypt or argon2
    full_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    
    -- Role-based access
    role TEXT NOT NULL DEFAULT 'OPERATOR', -- ADMIN, OPERATOR, MAINTENANCE, VIEWER
    
    -- Account status
    is_active INTEGER DEFAULT 1,
    is_locked INTEGER DEFAULT 0,
    failed_login_attempts INTEGER DEFAULT 0,
    last_failed_login TIMESTAMP,
    password_expires_at TIMESTAMP,
    must_change_password INTEGER DEFAULT 0,
    
    -- Audit trail
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP,
    last_login_ip TEXT,
    
    CONSTRAINT chk_user_role CHECK (role IN ('ADMIN', 'OPERATOR', 'MAINTENANCE', 'VIEWER', 'API_CLIENT'))
);

-- Default admin user (password MUST be changed on first login).
--
-- OWASP A07: shipping a fixed, publicly-documented credential in a public
-- repository is inherently risky — anyone who reads this file knows the
-- starting password. That risk is mitigated (not eliminated) by
-- must_change_password=1, which the API now actually enforces: this
-- account can log in exactly once and is blocked from every other endpoint
-- until it sets a new password (see middleware/auth.js). For a genuinely
-- production deployment, prefer generating a random one-time password at
-- provisioning time instead of using this default at all.
-- Default password: Admin@123 (bcrypt, cost 12)
INSERT INTO users (username, password_hash, full_name, role, must_change_password) VALUES
('admin', '$2a$12$tXn4iBEb.dKN8ohZ0jFGN.KBadieZmlBtwHy.Avy.iMcSftuJupBG', 'System Administrator', 'ADMIN', 1)
ON CONFLICT (username) DO NOTHING;

-- ============================================================================
-- SECTION 12: STORAGE MANAGEMENT
-- ============================================================================

-- Storage devices status
CREATE TABLE IF NOT EXISTS storage_devices (
    storage_id SERIAL PRIMARY KEY,
    device_name TEXT NOT NULL,
    device_path TEXT NOT NULL UNIQUE, -- Mount point
    device_type TEXT NOT NULL, -- SSD, HDD, NVME, USB, NETWORK
    
    -- Capacity metrics
    total_capacity_gb DOUBLE PRECISION NOT NULL,
    used_capacity_gb DOUBLE PRECISION DEFAULT 0,
    free_capacity_gb DOUBLE PRECISION,
    usage_percentage DOUBLE PRECISION DEFAULT 0,
    
    -- Health metrics
    health_status TEXT DEFAULT 'HEALTHY', -- HEALTHY, WARNING, CRITICAL, FAILED
    temperature_celsius DOUBLE PRECISION,
    smart_status TEXT,
    bad_blocks_count INTEGER DEFAULT 0,
    read_error_rate DOUBLE PRECISION,
    write_error_rate DOUBLE PRECISION,
    
    -- Status
    is_mounted INTEGER DEFAULT 0,
    is_writable INTEGER DEFAULT 1,
    is_primary INTEGER DEFAULT 0, -- Primary storage device
    mount_timestamp TIMESTAMP,
    
    last_health_check TIMESTAMP,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT chk_storage_type CHECK (device_type IN ('SSD', 'HDD', 'NVME', 'USB', 'NETWORK', 'CHM')),
    CONSTRAINT chk_storage_health CHECK (health_status IN ('HEALTHY', 'WARNING', 'CRITICAL', 'FAILED'))
);

-- ============================================================================
-- SECTION 13: SYSTEM HEALTH MONITORING
-- ============================================================================

-- System health metrics
CREATE TABLE IF NOT EXISTS system_health (
    health_id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- CPU metrics
    cpu_usage_percent DOUBLE PRECISION,
    cpu_temperature_celsius DOUBLE PRECISION,
    cpu_frequency_mhz INTEGER,
    
    -- Memory metrics
    memory_total_mb INTEGER,
    memory_used_mb INTEGER,
    memory_free_mb INTEGER,
    memory_usage_percent DOUBLE PRECISION,
    swap_used_mb INTEGER,
    swap_usage_percent DOUBLE PRECISION,
    
    -- Network metrics
    network_rx_bytes_per_sec INTEGER,
    network_tx_bytes_per_sec INTEGER,
    network_packet_loss_percent DOUBLE PRECISION,
    active_connections INTEGER,
    
    -- Disk I/O
    disk_read_bytes_per_sec INTEGER,
    disk_write_bytes_per_sec INTEGER,
    disk_iops INTEGER,
    
    -- Process metrics
    active_processes INTEGER,
    nvr_process_cpu_percent DOUBLE PRECISION,
    nvr_process_memory_mb INTEGER,
    api_server_cpu_percent DOUBLE PRECISION,
    api_server_memory_mb INTEGER,
    
    -- Power metrics
    power_supply_voltage DOUBLE PRECISION,
    battery_percentage INTEGER,
    is_on_battery INTEGER DEFAULT 0,
    
    -- Overall system status
    overall_health_score DOUBLE PRECISION, -- 0-100
    health_status TEXT DEFAULT 'HEALTHY',
    
    CONSTRAINT chk_system_health CHECK (health_status IN ('HEALTHY', 'WARNING', 'CRITICAL', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_system_health_time ON system_health(timestamp);

-- ============================================================================
-- SECTION 19: TRIGGERS FOR AUTOMATED TASKS
-- ============================================================================

-- Trigger: Update camera timestamp on health update

CREATE OR REPLACE FUNCTION fn_trg_update_camera_last_seen() RETURNS TRIGGER AS $$
BEGIN
UPDATE cameras 
    SET last_seen_at = NEW.timestamp,
        updated_at = NOW()
    WHERE camera_id = NEW.camera_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_camera_last_seen ON camera_health;
CREATE TRIGGER trg_update_camera_last_seen
AFTER INSERT ON camera_health
FOR EACH ROW
EXECUTE PROCEDURE fn_trg_update_camera_last_seen();

-- Trigger: Update recording on completion

CREATE OR REPLACE FUNCTION fn_trg_finalize_recording() RETURNS TRIGGER AS $$
BEGIN
UPDATE recordings
    SET end_timestamp = NOW(),
        duration_seconds = EXTRACT(EPOCH FROM (NOW() - start_timestamp))::INTEGER,
        updated_at = NOW()
    WHERE recording_id = NEW.recording_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_finalize_recording ON recordings;
CREATE TRIGGER trg_finalize_recording
AFTER UPDATE OF status ON recordings
FOR EACH ROW
WHEN (NEW.status = 'COMPLETED' AND OLD.status = 'RECORDING')
EXECUTE PROCEDURE fn_trg_finalize_recording();

-- Trigger: Update storage device metrics

CREATE OR REPLACE FUNCTION fn_trg_update_storage_metrics() RETURNS TRIGGER AS $$
BEGIN
UPDATE storage_devices
    SET used_capacity_gb = used_capacity_gb + (NEW.file_size_bytes / 1073741824.0),
        free_capacity_gb = total_capacity_gb - used_capacity_gb,
        usage_percentage = (used_capacity_gb / total_capacity_gb) * 100,
        updated_at = NOW()
    WHERE device_path = substr(NEW.file_path, 1, position('/' IN NEW.file_path) - 1);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_storage_metrics ON recordings;
CREATE TRIGGER trg_update_storage_metrics
AFTER INSERT ON recordings
FOR EACH ROW
EXECUTE PROCEDURE fn_trg_update_storage_metrics();

-- ============================================================================
-- SECTION 20: INDEXES FOR PERFORMANCE OPTIMIZATION
-- ============================================================================

-- Additional indexes for frequently queried tables
CREATE INDEX IF NOT EXISTS idx_cameras_status ON cameras(status);
CREATE INDEX IF NOT EXISTS idx_cameras_type ON cameras(camera_type);
CREATE INDEX IF NOT EXISTS idx_recordings_camera_status ON recordings(camera_id, status);
CREATE INDEX IF NOT EXISTS idx_events_camera_time ON events(camera_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_system_health_timestamp ON system_health(timestamp);

-- ============================================================================
-- POST-SCHEMA: Update cameras output paths for existing rows
-- ============================================================================

-- Schema initialization complete
-- Total tables: 50+
-- Total views: 10+
-- Total triggers: 5+
-- Total indexes: 30+

-- PostgreSQL performance settings are configured in postgresql.conf
-- Recommended: shared_buffers=256MB, work_mem=4MB,
--              synchronous_commit=off (for embedded NVR use)

-- If you already have cameras in the table without output paths set,
-- run this UPDATE to populate them based on the system_config storage paths.
-- Adjust the base paths to match your actual storage_base and hls_base.

-- UPDATE cameras
-- SET
--     rec_output_dir   = '/storage/recordings/cam_' || camera_id::TEXT,
--     hls_output_dir   = '/storage/hls/cam_'        || camera_id::TEXT,
--     hls_playlist_url = '/hls/cam_'                || camera_id::TEXT || '/stream.m3u8'
-- WHERE rec_output_dir IS NULL;

COMMIT;

-- ============================================================================
-- HEALTH MONITOR SETTINGS (single-row, managed by VMS)
-- ============================================================================

-- Run these manually after import to verify success:
--
-- \echo '--- Tables created ---'
-- SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;
--
-- \echo '--- Row counts for seeded tables ---'
-- SELECT 'system_config'       AS tbl, COUNT(*) FROM system_config
-- UNION ALL
-- SELECT 'recording_presets',          COUNT(*) FROM recording_presets
-- UNION ALL
-- SELECT 'maintenance_schedules',      COUNT(*) FROM maintenance_schedules
-- UNION ALL
-- SELECT 'users',                      COUNT(*) FROM users;
--
-- \echo '--- cameras table columns ---'
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'cameras'
-- ORDER BY ordinal_position;
-- ============================================================================

CREATE TABLE IF NOT EXISTS health_monitor_settings (
    id                      SERIAL PRIMARY KEY,
    poll_interval_sec       INTEGER  NOT NULL DEFAULT 10,
    cpu_warn_threshold      FLOAT    NOT NULL DEFAULT 85.0,
    mem_warn_threshold      FLOAT    NOT NULL DEFAULT 90.0,
    disk_warn_threshold     FLOAT    NOT NULL DEFAULT 90.0,
    cpu_critical_threshold  FLOAT    NOT NULL DEFAULT 95.0,
    mem_critical_threshold  FLOAT    NOT NULL DEFAULT 95.0,
    disk_critical_threshold FLOAT    NOT NULL DEFAULT 95.0,
    enable_alerts           BOOLEAN  NOT NULL DEFAULT TRUE,
    updated_at              TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_poll_interval
        CHECK (poll_interval_sec > 0),
    CONSTRAINT chk_cpu_warn
        CHECK (cpu_warn_threshold BETWEEN 0 AND 100),
    CONSTRAINT chk_mem_warn
        CHECK (mem_warn_threshold BETWEEN 0 AND 100),
    CONSTRAINT chk_disk_warn
        CHECK (disk_warn_threshold BETWEEN 0 AND 100)
);

-- Seed a default row
INSERT INTO health_monitor_settings (poll_interval_sec) VALUES (10)
    ON CONFLICT DO NOTHING;

-- ============================================================================
-- RECORDING SETTINGS (single-row, managed by VMS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS recording_settings (
    id                       SERIAL PRIMARY KEY,
    storage_path             TEXT     NOT NULL DEFAULT '/storage/recordings',
    recording_retention_days INTEGER  NOT NULL DEFAULT 30,
    log_retention_days       INTEGER  NOT NULL DEFAULT 30,
    segment_duration_sec     INTEGER  NOT NULL DEFAULT 120,
    segment_max_size_mb      INTEGER  NOT NULL DEFAULT 2048,
    max_storage_gb           INTEGER  NOT NULL DEFAULT 4000,
    enable_audio             BOOLEAN  NOT NULL DEFAULT TRUE,
    enable_watermark         BOOLEAN  NOT NULL DEFAULT TRUE,
    updated_at               TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_recording_retention
        CHECK (recording_retention_days > 0),
    CONSTRAINT chk_log_retention
        CHECK (log_retention_days > 0),
    CONSTRAINT chk_segment_duration
        CHECK (segment_duration_sec > 0),
    CONSTRAINT chk_segment_size
        CHECK (segment_max_size_mb > 0),
    CONSTRAINT chk_max_storage
        CHECK (max_storage_gb > 0)
);

-- Seed a default row
INSERT INTO recording_settings (storage_path) VALUES ('/storage/recordings')
    ON CONFLICT DO NOTHING;

-- ============================================================================
-- HLS SETTINGS (single-row, managed by VMS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS hls_settings (
    id                      SERIAL PRIMARY KEY,
    hls_base                TEXT     NOT NULL DEFAULT '/storage/hls',
    hls_segment_sec         INTEGER  NOT NULL DEFAULT 4,
    hls_window_size         INTEGER  NOT NULL DEFAULT 10,
    hls_delete_old_segments BOOLEAN  NOT NULL DEFAULT TRUE,
    updated_at              TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_hls_segment
        CHECK (hls_segment_sec > 0),
    CONSTRAINT chk_hls_window
        CHECK (hls_window_size > 0)
);

-- Seed a default row
INSERT INTO hls_settings (hls_base) VALUES ('/storage/hls')
    ON CONFLICT DO NOTHING;

-- ============================================================================
-- ONVIF GLOBAL SETTINGS (single-row, managed by VMS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS onvif_settings (
    id                      SERIAL PRIMARY KEY,
    multicast_ip            VARCHAR(64)  NOT NULL DEFAULT '239.255.255.250',
    multicast_port          INTEGER      NOT NULL DEFAULT 3702,
    discovery_interval_sec  INTEGER      NOT NULL DEFAULT 60,
    probe_timeout_ms        INTEGER      NOT NULL DEFAULT 3000,
    enable_discovery        BOOLEAN      NOT NULL DEFAULT TRUE,
    updated_at              TIMESTAMP    NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_multicast_port
        CHECK (multicast_port BETWEEN 1 AND 65535),
    CONSTRAINT chk_discovery_interval
        CHECK (discovery_interval_sec > 0),
    CONSTRAINT chk_probe_timeout
        CHECK (probe_timeout_ms > 0)
);

-- Seed a default row so mNVR always finds settings on first boot
INSERT INTO onvif_settings (multicast_ip) VALUES ('239.255.255.250')
    ON CONFLICT DO NOTHING;

-- ============================================================================
-- CAMERA CONFIGURATION (per-camera ONVIF/RTSP credentials, managed by VMS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS cameras_config_details (
    id               SERIAL PRIMARY KEY,
    camera_slot      INTEGER      UNIQUE NOT NULL,
    name             VARCHAR(128) NOT NULL,
    location         VARCHAR(128),
    camera_type      VARCHAR(32),
    ip_address       INET         NOT NULL UNIQUE,
    onvif_port       INTEGER      NOT NULL DEFAULT 80,
    onvif_username   VARCHAR(64),
    onvif_password   TEXT,
    rtsp_username    VARCHAR(64),
    rtsp_password    TEXT,
    manufacturer     VARCHAR(64),
    model            VARCHAR(64),
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP    NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_onvif_port
        CHECK (onvif_port BETWEEN 1 AND 65535)
);

-- ============================================================================
-- ONVIF PROFILE S EXTENSIONS
-- Adds: per-camera media profile cache (multi-stream), active-stream
-- selection, PTZ preset storage, imaging settings, and audio settings.
-- All statements are idempotent (IF NOT EXISTS / ON CONFLICT).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Cached ONVIF media profiles per camera (one row per profile/stream)
-- A camera typically exposes 2-3 profiles (e.g. "MainStream" 1080p,
-- "SubStream" 720p, "ThirdStream" CIF) — each independently configurable.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS camera_media_profiles (
    id                  SERIAL PRIMARY KEY,
    camera_id           INTEGER NOT NULL REFERENCES cameras(camera_id) ON DELETE CASCADE,
    profile_token       VARCHAR(128) NOT NULL,   -- ONVIF ProfileToken
    profile_name        VARCHAR(128),
    encoding            VARCHAR(16),              -- H264 / H265 / JPEG
    resolution_width    INTEGER,
    resolution_height   INTEGER,
    fps                 INTEGER,
    bitrate_kbps        INTEGER,
    gov_length          INTEGER,                  -- GOP / keyframe interval
    quality             NUMERIC(4,1),
    stream_uri          TEXT,                      -- cached RTSP URI for this profile
    snapshot_uri        TEXT,
    is_active_stream    BOOLEAN NOT NULL DEFAULT FALSE,  -- which profile NVR/UI currently pulls
    video_source_token  VARCHAR(128),
    audio_encoder_token VARCHAR(128),
    last_synced_at      TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_camera_profile UNIQUE (camera_id, profile_token)
);

CREATE INDEX IF NOT EXISTS idx_camera_media_profiles_camera ON camera_media_profiles(camera_id);

-- ----------------------------------------------------------------------------
-- PTZ presets (per camera). Mirrors ONVIF PTZ preset tokens so "Goto Preset"
-- on the frontend maps 1:1 to the camera's own stored preset.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS camera_ptz_presets (
    id              SERIAL PRIMARY KEY,
    camera_id       INTEGER NOT NULL REFERENCES cameras(camera_id) ON DELETE CASCADE,
    preset_token    VARCHAR(128) NOT NULL,     -- ONVIF PresetToken (may be camera-assigned)
    preset_name     VARCHAR(128) NOT NULL,
    pan             NUMERIC(8,4),
    tilt            NUMERIC(8,4),
    zoom            NUMERIC(8,4),
    is_home         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_camera_preset_token UNIQUE (camera_id, preset_token)
);

CREATE INDEX IF NOT EXISTS idx_camera_ptz_presets_camera ON camera_ptz_presets(camera_id);

-- ----------------------------------------------------------------------------
-- PTZ current position / capability cache (single row per camera)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS camera_ptz_status (
    camera_id       INTEGER PRIMARY KEY REFERENCES cameras(camera_id) ON DELETE CASCADE,
    pan             NUMERIC(8,4) DEFAULT 0,
    tilt            NUMERIC(8,4) DEFAULT 0,
    zoom            NUMERIC(8,4) DEFAULT 0,
    move_status     VARCHAR(16) DEFAULT 'IDLE',   -- IDLE / MOVING
    supports_continuous BOOLEAN DEFAULT TRUE,
    supports_relative   BOOLEAN DEFAULT TRUE,
    supports_absolute   BOOLEAN DEFAULT TRUE,
    min_pan NUMERIC(8,4) DEFAULT -1, max_pan  NUMERIC(8,4) DEFAULT 1,
    min_tilt NUMERIC(8,4) DEFAULT -1, max_tilt NUMERIC(8,4) DEFAULT 1,
    min_zoom NUMERIC(8,4) DEFAULT 0, max_zoom  NUMERIC(8,4) DEFAULT 1,
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- Imaging settings (brightness, contrast, saturation, sharpness, IR, etc.)
-- Single row per camera — mirrors ONVIF ImagingSettings20.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS camera_image_settings (
    camera_id           INTEGER PRIMARY KEY REFERENCES cameras(camera_id) ON DELETE CASCADE,
    video_source_token  VARCHAR(128),
    brightness          NUMERIC(6,2) DEFAULT 50,
    contrast            NUMERIC(6,2) DEFAULT 50,
    color_saturation    NUMERIC(6,2) DEFAULT 50,
    sharpness           NUMERIC(6,2) DEFAULT 50,
    ir_cut_filter        VARCHAR(8) DEFAULT 'AUTO',   -- AUTO / ON / OFF
    wide_dynamic_range   BOOLEAN DEFAULT TRUE,
    backlight_compensation BOOLEAN DEFAULT FALSE,
    exposure_mode        VARCHAR(8) DEFAULT 'AUTO',   -- AUTO / MANUAL
    exposure_time_us     INTEGER,                      -- only used if MANUAL
    exposure_gain_db     NUMERIC(6,2),
    white_balance_mode   VARCHAR(8) DEFAULT 'AUTO',    -- AUTO / MANUAL
    focus_mode           VARCHAR(8) DEFAULT 'AUTO',    -- AUTO / MANUAL
    -- Capability ranges reported by the camera (for UI slider bounds)
    brightness_min NUMERIC(6,2) DEFAULT 0,  brightness_max NUMERIC(6,2) DEFAULT 100,
    contrast_min   NUMERIC(6,2) DEFAULT 0,  contrast_max   NUMERIC(6,2) DEFAULT 100,
    saturation_min NUMERIC(6,2) DEFAULT 0,  saturation_max NUMERIC(6,2) DEFAULT 100,
    sharpness_min  NUMERIC(6,2) DEFAULT 0,  sharpness_max  NUMERIC(6,2) DEFAULT 100,
    last_synced_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- Audio settings (per camera audio encoder / source configuration)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS camera_audio_settings (
    camera_id            INTEGER PRIMARY KEY REFERENCES cameras(camera_id) ON DELETE CASCADE,
    audio_source_token   VARCHAR(128),
    audio_encoder_token  VARCHAR(128),
    encoding             VARCHAR(16) DEFAULT 'AAC',   -- G711 / G726 / AAC
    bitrate_kbps         INTEGER DEFAULT 64,
    sample_rate_khz      INTEGER DEFAULT 16,
    input_gain_db        NUMERIC(6,2) DEFAULT 0,
    is_enabled           BOOLEAN DEFAULT TRUE,
    last_synced_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- ONVIF capability snapshot per camera (what services/features a camera
-- actually advertises — drives which UI controls are shown/hidden)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS camera_onvif_capabilities (
    camera_id          INTEGER PRIMARY KEY REFERENCES cameras(camera_id) ON DELETE CASCADE,
    supports_media     BOOLEAN DEFAULT TRUE,
    supports_ptz       BOOLEAN DEFAULT FALSE,
    supports_imaging   BOOLEAN DEFAULT FALSE,
    supports_audio     BOOLEAN DEFAULT FALSE,
    supports_events    BOOLEAN DEFAULT FALSE,
    profile_s_conformant BOOLEAN DEFAULT FALSE,
    device_service_url TEXT,
    media_service_url  TEXT,
    ptz_service_url    TEXT,
    imaging_service_url TEXT,
    last_checked_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- Smart Search — person detection index. See migrations/005_person_search_index.sql
-- for the full rationale; kept in sync here for fresh installs.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_detections (
    detection_id   SERIAL PRIMARY KEY,
    camera_id      INTEGER NOT NULL REFERENCES cameras(camera_id) ON DELETE CASCADE,
    occurred_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    bbox_x1        DOUBLE PRECISION,
    bbox_y1        DOUBLE PRECISION,
    bbox_x2        DOUBLE PRECISION,
    bbox_y2        DOUBLE PRECISION,
    confidence     DOUBLE PRECISION,
    thumbnail_path TEXT NOT NULL,
    embedding      TEXT NOT NULL,
    attributes     TEXT DEFAULT '{}',
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_person_detections_time ON person_detections(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_person_detections_camera_time ON person_detections(camera_id, occurred_at DESC);
