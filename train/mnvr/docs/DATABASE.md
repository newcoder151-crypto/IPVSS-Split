# Database

PostgreSQL 14+, database `mnvr`. `database/schema.sql` builds a fresh install
(22 tables, 3 triggers); `database/migrations/` holds numbered, idempotent
changes that `scripts/start.sh` re-applies on every run. Every table below is
used by running code; nothing else is defined.

## Who touches what

| Table | Purpose | Written by | Read by |
|---|---|---|---|
| `users` | Accounts, bcrypt hashes, role, lockout, `must_change_password` | API (auth, users), seed | API |
| `system_config` | Key/value system configuration | API (`/api/config`) | API |
| `cameras` | Camera registry: URLs, credentials, AI settings, status, `last_seen_at` | API (cameras), trigger | API, stream-manager, mediamtx-sync |
| `cameras_config_details` | Camera slots configured in Settings | API (`/api/settings/cameras`) | API, mediamtx-sync |
| `camera_health` | Online/recording heartbeat, one row per camera per ~10 s | stream-manager | API (latest row per camera) |
| `camera_media_profiles` | ONVIF stream profiles | API (ONVIF) | API |
| `camera_ptz_presets` | PTZ presets | API (ONVIF) | API |
| `camera_ptz_status` | Last known PTZ position | API (ONVIF) | API |
| `camera_image_settings` | Brightness, contrast, IR cut, etc. | API (ONVIF) | API |
| `camera_audio_settings` | Audio encoding, bitrate | API (ONVIF) | API |
| `camera_onvif_capabilities` | Capability snapshot per camera | API (ONVIF) | API, frontend |
| `recordings` | One row per recorded segment | stream-manager | API (list, stream, export) |
| `events` | Alarms and alerts | API (`POST /api/events`) | API, frontend |
| `gps_track_log` | GPS fixes for the overlay and recording metadata | *nothing in this repo* (see note) | stream-manager |
| `storage_devices` | Storage volumes and capacity | *nothing in this repo* (trigger updates existing rows) | API (`/api/config/status`) |
| `system_health` | Latest host health sample | *nothing in this repo* (see note) | API (`/api/config/status`) |
| `health_monitor_settings` | Health poll interval and thresholds | API (`/api/settings/health`) | API |
| `recording_settings` | Storage path, retention, segment size, audio, watermark | API (`/api/settings/recording`) | API, stream-manager |
| `hls_settings` | HLS base path, segment length, window | API (`/api/settings/hls`) | API, stream-manager |
| `onvif_settings` | WS-Discovery multicast and timing | API (`/api/settings/onvif`) | API |
| `person_detections` | Smart Search index: embedding, bbox, thumbnail path, attributes | API (`/api/ai/index-detection`) | API (`/api/search/smart`) |
| `microphones` | Audio source registry. Kept only because `recordings.audio_stream_id` references it | – | – |

> **Tables with no writer in this repository.** `gps_track_log`, `system_health`
> and `storage_devices` are read by running code (GPS overlay, status cards,
> storage summary) but were only ever populated by the removed C daemon
> (`mnvrd`), which was already disabled in the default stack. Until an external
> feed inserts rows they are empty and those readers fall back to empty
> values. Behaviour is the same as before the clean-up.

## Triggers

| Trigger | Table | Effect |
|---|---|---|
| `trg_update_camera_last_seen` | `camera_health` | Sets `cameras.last_seen_at` from the new heartbeat |
| `trg_finalize_recording` | `recordings` | Stamps `end_timestamp` and `duration_seconds` when a segment completes |
| `trg_update_storage_metrics` | `recordings` | Adds the segment size to the matching `storage_devices` row |

## Conventions

- **Timestamps are timezone-naive** (`TIMESTAMP`, not `TIMESTAMPTZ`) and are
  compared against naive local wall-clock strings. Never convert to UTC in a
  query window.
- **`person_detections.embedding`** is a JSON array of floats (CLIP), not a
  `pgvector` column, so a stock PostgreSQL install works. Rows are always
  narrowed by time and camera before the similarity pass.
- **Retention:** recordings are pruned by stream-manager from
  `recording_settings`. Nothing prunes `person_detections` or its thumbnails.
- **Seeded accounts** (`schema.sql`): `admin` with `must_change_password = 1`.
  `backend/api/seed.js` resets passwords and adds demo cameras for development.

## Migrations

Add `migrations/00N_short_description.sql` (next free number), make it safe to
re-run (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`), explain *why* in a header
comment, and mirror the change into `schema.sql`.

| File | Adds |
|---|---|
| `001_onvif_profile_s.sql` | ONVIF Profile S capability, profile, PTZ, image and audio tables |
| `002_ai_model_config.sql` | Per-camera AI model, threshold, enable flag |
| `003_third_rtsp_url.sql` | Third RTSP URL per camera |
| `004_log_retention.sql` | `recording_settings.log_retention_days` |
| `005_person_search_index.sql` | `person_detections` (Smart Search) |

## Manual setup

```bash
sudo -u postgres psql -c "CREATE USER mnvr WITH PASSWORD '<password>';"
sudo -u postgres psql -c "CREATE DATABASE mnvr OWNER mnvr ENCODING 'UTF8';"
PGPASSWORD=<password> psql -h localhost -U mnvr -d mnvr -f database/schema.sql
for m in database/migrations/*.sql; do PGPASSWORD=<password> psql -h localhost -U mnvr -d mnvr -f "$m"; done
```
