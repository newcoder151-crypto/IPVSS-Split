-- =====================================================================
-- CMS migration 003 - live updates (low latency)
-- Every change to the tables the dashboards show fires pg_notify('cms_events', ...).
-- Both servers (CMS console, RPF dashboard) LISTEN on that channel and push the change to
-- open browsers over Server-Sent Events, so a screen updates within milliseconds of the write,
-- whichever process (NVR ingest, operator action, RPF officer, background worker) made it.
-- Payload is tiny and carries no business data: {t: table, op, id, z: zone, p: post, n: nvr}.
-- Idempotent.
-- =====================================================================
CREATE OR REPLACE FUNCTION cms_notify_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE zid bigint; pid bigint; nid bigint; rid bigint; tbl text;
BEGIN
    -- alert is partitioned: the trigger fires on the monthly partition (alert_2026_10), report it as 'alert'
    tbl := regexp_replace(TG_TABLE_NAME, '^alert_[0-9]{4}_[0-9]{2}$', 'alert');
    CASE tbl
        WHEN 'alert' THEN zid := NEW.zone_id; pid := NEW.assigned_post_id; nid := NEW.nvr_id;
        WHEN 'alert_delivery' THEN pid := NEW.post_id;
        WHEN 'incident' THEN pid := NEW.post_id;
        WHEN 'video_request' THEN pid := NEW.post_id;
        WHEN 'delivered_footage' THEN SELECT r.post_id INTO pid FROM video_request r WHERE r.id = NEW.video_request_id;
        WHEN 'evidence_flag' THEN SELECT r.post_id INTO pid FROM delivered_footage f JOIN video_request r ON r.id = f.video_request_id WHERE f.id = NEW.footage_id;
        WHEN 'notification' THEN zid := NEW.zone_id; pid := NEW.post_id;
        WHEN 'video_segment' THEN zid := NEW.zone_id; nid := NEW.nvr_id;
        WHEN 'nvr_command' THEN nid := NEW.nvr_id;
        WHEN 'nvr_unit' THEN zid := NEW.current_zone_id; nid := NEW.id;
        ELSE NULL;
    END CASE;
    IF zid IS NULL AND pid IS NOT NULL THEN SELECT zone_id INTO zid FROM rpf_post WHERE id = pid; END IF;
    IF zid IS NULL AND nid IS NOT NULL THEN SELECT current_zone_id INTO zid FROM nvr_unit WHERE id = nid; END IF;
    rid := NEW.id;
    PERFORM pg_notify('cms_events', json_build_object('t', tbl, 'op', TG_OP, 'id', rid, 'z', zid, 'p', pid, 'n', nid)::text);
    RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['alert','alert_delivery','incident','video_request','delivered_footage','evidence_flag','notification','video_segment','nvr_command'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_live ON %I', t);
        EXECUTE format('CREATE TRIGGER trg_live AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION cms_notify_change()', t);
    END LOOP;
END $$;

-- NVR registry changes (status, zone) but NOT the heartbeat's last_seen/last position
-- (that would be one event per unit every few seconds); the fleet view polls for those.
DROP TRIGGER IF EXISTS trg_live ON nvr_unit;
CREATE TRIGGER trg_live AFTER UPDATE OF status, current_zone_id, name, train_no ON nvr_unit FOR EACH ROW EXECUTE FUNCTION cms_notify_change();

-- A unit that was offline for a long time may report an event older than the oldest monthly partition.
-- Create the partition for that month on demand (the ingest path calls this) instead of failing the alert.
CREATE OR REPLACE FUNCTION ensure_partition_for(ts timestamptz) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE tbl text; m date; nxt date; part text;
BEGIN
    m := date_trunc('month', ts)::date; nxt := (m + interval '1 month')::date;
    FOREACH tbl IN ARRAY ARRAY['alert','gps_point'] LOOP
        IF to_regclass('public.' || tbl) IS NULL THEN CONTINUE; END IF;
        part := format('%s_%s', tbl, to_char(m, 'YYYY_MM'));
        BEGIN
            IF to_regclass('public.' || part) IS NULL THEN
                EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', part, tbl, m, nxt);
            END IF;
        EXCEPTION WHEN invalid_object_definition OR duplicate_table THEN NULL;
        END;
    END LOOP;
END $$;

INSERT INTO schema_migration (version) VALUES ('003_live') ON CONFLICT DO NOTHING;
