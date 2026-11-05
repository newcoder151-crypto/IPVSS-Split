-- =====================================================================
-- CMS migration 005 - requests BY TRAIN NUMBER (train -> M-NVR unit -> camera), without any new "train" or "camera" table
-- Idempotent: safe to re-run. Apply as the database owner after 002..004 (the launchers do this on every start).
--
-- The hierarchy is read from what the M-NVRs already report - nothing is copied into a table of its own:
--   a TRAIN         = the train number on its M-NVR units (nvr_unit.train_no, from the M-NVR's own "train_number" setting)
--   an M-NVR UNIT   = nvr_unit            (+ unit_no   = the M-NVR's number inside the train, from its "mnvr_number" setting / MNVR_NO)
--   a CAMERA        = camera              (+ mnvr_camera_id = the camera's own id inside the M-NVR; this IS the camera number)
-- The bridge reads the cameras directly from the M-NVR database and pushes them to the CMS every time it connects.
--
-- Requests
--   train_request   what an RPF officer asks for: a TRAIN NUMBER + a time window. On approval CMS expands it into one
--                   video_request per active camera of every M-NVR unit of the train (video_request.train_request_id), so the
--                   per-camera machinery (upload commands, resumable upload, stitching, delivery) is reused unchanged.
--   nvr_command.train_request_id groups the per-camera upload commands of one train request.
--
-- Naming (CMS/backend/src/services/naming.js):   <TRAIN>_M<nn>_C<nn>_<start>_<end>.mp4
-- =====================================================================

ALTER TABLE nvr_unit ADD COLUMN IF NOT EXISTS unit_no integer;
ALTER TABLE camera   ADD COLUMN IF NOT EXISTS mnvr_camera_id integer;

ALTER TABLE nvr_unit DROP CONSTRAINT IF EXISTS chk_unit_no;
ALTER TABLE nvr_unit ADD  CONSTRAINT chk_unit_no CHECK (unit_no IS NULL OR unit_no BETWEEN 1 AND 99);
ALTER TABLE camera   DROP CONSTRAINT IF EXISTS chk_mnvr_camera_id;
ALTER TABLE camera   ADD  CONSTRAINT chk_mnvr_camera_id CHECK (mnvr_camera_id IS NULL OR mnvr_camera_id BETWEEN 1 AND 999);

-- Units that already exist get their number inside the train, oldest first (the bridge sets it from the M-NVR's own setting afterwards).
DO $$
DECLARE r record;
BEGIN
    FOR r IN SELECT id, train_no FROM nvr_unit WHERE unit_no IS NULL AND train_no IS NOT NULL AND btrim(train_no) <> '' ORDER BY id LOOP
        UPDATE nvr_unit SET unit_no = (SELECT COALESCE(MAX(x.unit_no), 0) + 1 FROM nvr_unit x WHERE lower(btrim(x.train_no)) = lower(btrim(r.train_no)))
         WHERE id = r.id AND unit_no IS NULL;
    END LOOP;
END $$;

-- one M-NVR number per train, one camera number per M-NVR
CREATE UNIQUE INDEX IF NOT EXISTS uq_unit_no_in_train ON nvr_unit (lower(btrim(train_no)), unit_no) WHERE train_no IS NOT NULL AND unit_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_camera_no_in_unit ON camera (nvr_id, mnvr_camera_id) WHERE mnvr_camera_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nvr_unit_train_no ON nvr_unit (lower(btrim(train_no)));

-- ---------------------------------------------------------------------
-- train_request: one officer request for a whole train
-- status  submitted        waiting for a CMS operator (or auto-approve)
--         approved         expanded into per-camera requests; commands queued for the M-NVR units
--         awaiting_upload  at least one camera's footage is still on the train
--         fulfilled        every camera's footage delivered
--         partial          finished, some cameras delivered and some failed / expired / were cancelled
--         rejected | failed | expired | cancelled
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS train_request (
    id                 bigserial PRIMARY KEY,
    train_no           text   NOT NULL,                         -- as it was when requested
    post_id            bigint NOT NULL REFERENCES rpf_post(id),
    zone_id            bigint NOT NULL REFERENCES zone(id),
    requested_by       bigint NOT NULL REFERENCES users(id),
    alert_id           bigint,
    alert_event_time   timestamptz,
    incident_id        bigint REFERENCES incident(id),
    window_start       timestamptz NOT NULL,
    window_end         timestamptz NOT NULL,
    orig_window_start  timestamptz,
    orig_window_end    timestamptz,
    reason             text,
    status             text NOT NULL DEFAULT 'submitted'
                       CHECK (status IN ('submitted','approved','awaiting_upload','fulfilled','partial','rejected','failed','expired','cancelled')),
    operator_id        bigint REFERENCES users(id),
    decided_at         timestamptz,
    decision_note      text,
    expanded_at        timestamptz,
    units_total        integer NOT NULL DEFAULT 0,
    cameras_total      integer NOT NULL DEFAULT 0,
    cameras_fulfilled  integer NOT NULL DEFAULT 0,
    cameras_open       integer NOT NULL DEFAULT 0,
    cameras_failed     integer NOT NULL DEFAULT 0,
    skipped            jsonb,                                   -- units / cameras left out at fan-out, and why
    failure_reason     text,
    fulfilled_at       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (window_end > window_start)
);
CREATE INDEX IF NOT EXISTS idx_train_request_post   ON train_request(post_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_train_request_train  ON train_request(lower(btrim(train_no)), window_start, window_end);
CREATE INDEX IF NOT EXISTS idx_train_request_status ON train_request(status) WHERE status IN ('submitted','approved','awaiting_upload');

ALTER TABLE video_request ADD COLUMN IF NOT EXISTS train_request_id bigint REFERENCES train_request(id);
CREATE INDEX IF NOT EXISTS idx_video_request_train_request ON video_request(train_request_id);
-- one child per camera per train request
CREATE UNIQUE INDEX IF NOT EXISTS uq_video_request_train_camera ON video_request(train_request_id, camera_id) WHERE train_request_id IS NOT NULL;

ALTER TABLE nvr_command ADD COLUMN IF NOT EXISTS train_request_id bigint REFERENCES train_request(id);
CREATE INDEX IF NOT EXISTS idx_nvr_command_train_request ON nvr_command(train_request_id);

-- ---------------------------------------------------------------------
-- What identifies a recording, stored with it (delivered_footage is insert-only: old rows keep NULL here and are
-- resolved through their camera / unit instead).
-- ---------------------------------------------------------------------
ALTER TABLE delivered_footage
    ADD COLUMN IF NOT EXISTS train_request_id bigint REFERENCES train_request(id),
    ADD COLUMN IF NOT EXISTS train_no         text,
    ADD COLUMN IF NOT EXISTS nvr_id           bigint REFERENCES nvr_unit(id),
    ADD COLUMN IF NOT EXISTS unit_no          integer,
    ADD COLUMN IF NOT EXISTS camera_id        bigint REFERENCES camera(id),
    ADD COLUMN IF NOT EXISTS camera_no        integer,
    ADD COLUMN IF NOT EXISTS file_name        text;
CREATE INDEX IF NOT EXISTS idx_delivered_footage_train_request ON delivered_footage(train_request_id);

ALTER TABLE video_segment
    ADD COLUMN IF NOT EXISTS source_file_name  text,          -- the file name on the M-NVR
    ADD COLUMN IF NOT EXISTS mnvr_recording_id bigint;        -- the M-NVR's own recording id

-- ---------------------------------------------------------------------
-- live updates: train_request changes reach the dashboards like every other table
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cms_notify_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE zid bigint; pid bigint; nid bigint; rid bigint; tbl text;
BEGIN
    tbl := regexp_replace(TG_TABLE_NAME, '^alert_[0-9]{4}_[0-9]{2}$', 'alert');
    CASE tbl
        WHEN 'alert' THEN zid := NEW.zone_id; pid := NEW.assigned_post_id; nid := NEW.nvr_id;
        WHEN 'alert_delivery' THEN pid := NEW.post_id;
        WHEN 'incident' THEN pid := NEW.post_id;
        WHEN 'video_request' THEN pid := NEW.post_id;
        WHEN 'train_request' THEN pid := NEW.post_id; zid := NEW.zone_id;
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

DROP TRIGGER IF EXISTS trg_live ON train_request;
CREATE TRIGGER trg_live AFTER INSERT OR UPDATE ON train_request FOR EACH ROW EXECUTE FUNCTION cms_notify_change();

-- A footage request waits for its M-NVR however long it takes (0 = never give up). A stored value of the old default (25 days) is replaced;
-- a different value an administrator chose on purpose is left alone.
DELETE FROM setting WHERE key = 'request_expiry_days' AND value::text IN ('25', '"25"');

INSERT INTO schema_migration (version) VALUES ('005_train_fleet') ON CONFLICT DO NOTHING;
