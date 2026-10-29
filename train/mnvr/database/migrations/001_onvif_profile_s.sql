
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

VACUUM ANALYZE;
