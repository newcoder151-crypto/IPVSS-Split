-- Run as the postgres superuser on the M-NVR's database:  psql -d mnvr -f scripts/grant_readonly.sql
-- Creates a read-only login for the bridge. Change the password first.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mnvr_bridge') THEN
    CREATE ROLE mnvr_bridge LOGIN PASSWORD 'bridgepass';
  END IF;
END $$;
GRANT CONNECT ON DATABASE mnvr TO mnvr_bridge;
GRANT USAGE ON SCHEMA public TO mnvr_bridge;
GRANT SELECT ON recordings, cameras, events, gps_track_log, camera_health, system_health, recording_settings, system_config TO mnvr_bridge;
