-- =====================================================================
-- CMS migration 010 - the console's bell (notices for CMS operators / administrators)
--   The RPF dashboard has a bell for the post; this is the same for the CMS console. A row is written by a database
--   trigger when something happens that the control room should look at, whichever process caused it (VMS ingest,
--   an RPF officer, a CMS operator, a background job):
--     * an alert is waiting in the queue / an alert was escalated (nobody at the post acknowledged it)
--     * a post opened an incident
--     * a post asked for footage by train number (waiting for a decision)
--     * a post flagged footage as evidence / asked for a LONGER retention / an evidence archive failed
--   A notice is shared by the zone's console users: acknowledging it (or opening what it is about) clears it for everybody.
--   The trigger can never block the business write it watches: any problem in it is swallowed. Idempotent.
-- =====================================================================
CREATE TABLE IF NOT EXISTS console_notice (
    id          bigserial PRIMARY KEY,
    zone_id     bigint REFERENCES zone(id),
    post_id     bigint REFERENCES rpf_post(id),
    kind        text NOT NULL,                 -- alert | incident | request | evidence | retention | error
    title       text NOT NULL,
    body        text,
    ref_entity  text,                          -- alert | incident | train_request | evidence_flag
    ref_id      bigint,
    created_at  timestamptz NOT NULL DEFAULT now(),
    read_at     timestamptz,
    read_by     bigint REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_console_notice_zone   ON console_notice(zone_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_console_notice_unread ON console_notice(id DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_console_notice_ref    ON console_notice(ref_entity, ref_id) WHERE read_at IS NULL;

CREATE OR REPLACE FUNCTION console_notice_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE tbl text; zid bigint; pid bigint; pname text; k text; t text; b text; ent text; rid bigint; nm text; trn text;
BEGIN
  BEGIN
    tbl := regexp_replace(TG_TABLE_NAME, '^alert_[0-9]{4}_[0-9]{2}$', 'alert');
    IF tbl = 'alert' THEN
      IF TG_OP = 'INSERT' AND NEW.status::text = 'new' THEN
        SELECT name, train_no INTO nm, trn FROM nvr_unit WHERE id = NEW.nvr_id;
        k := 'alert'; ent := 'alert'; rid := NEW.id; zid := NEW.zone_id;
        t := 'Alert waiting in the queue: ' || replace(NEW.alert_type, '_', ' ') || ' (priority ' || NEW.priority || ')';
        b := coalesce(nm, 'M-NVR') || CASE WHEN trn IS NOT NULL THEN ' - train ' || trn ELSE '' END;
      ELSIF TG_OP = 'UPDATE' AND NEW.status::text = 'escalated' AND OLD.status::text IS DISTINCT FROM 'escalated' THEN
        SELECT name, train_no INTO nm, trn FROM nvr_unit WHERE id = NEW.nvr_id;
        SELECT name INTO pname FROM rpf_post WHERE id = NEW.assigned_post_id;
        k := 'error'; ent := 'alert'; rid := NEW.id; zid := NEW.zone_id; pid := NEW.assigned_post_id;
        t := 'Alert #' || NEW.id || ' escalated - nobody acknowledged it';
        b := replace(NEW.alert_type, '_', ' ') || ' - ' || coalesce(nm, 'M-NVR') || CASE WHEN trn IS NOT NULL THEN ' - train ' || trn ELSE '' END || CASE WHEN pname IS NOT NULL THEN ' (sent to ' || pname || ')' ELSE '' END;
      ELSE RETURN NULL; END IF;
    ELSIF tbl = 'incident' THEN
      IF TG_OP <> 'INSERT' THEN RETURN NULL; END IF;
      SELECT name, zone_id INTO pname, zid FROM rpf_post WHERE id = NEW.post_id;
      k := 'incident'; ent := 'incident'; rid := NEW.id; pid := NEW.post_id;
      t := 'New incident #' || NEW.id || ' at ' || coalesce(pname, 'a post');
      b := NEW.title;
    ELSIF tbl = 'train_request' THEN
      IF TG_OP <> 'INSERT' THEN RETURN NULL; END IF;
      SELECT name INTO pname FROM rpf_post WHERE id = NEW.post_id;
      k := 'request'; ent := 'train_request'; rid := NEW.id; pid := NEW.post_id; zid := NEW.zone_id;
      t := 'Footage request #' || NEW.id || ' from ' || coalesce(pname, 'a post') || ' - train ' || NEW.train_no;
      b := 'Waiting for your decision';
    ELSIF tbl = 'evidence_flag' THEN
      SELECT r.post_id INTO pid FROM delivered_footage f JOIN video_request r ON r.id = f.video_request_id WHERE f.id = NEW.footage_id;
      SELECT name, zone_id INTO pname, zid FROM rpf_post WHERE id = pid;
      ent := 'evidence_flag'; rid := NEW.id;
      IF TG_OP = 'INSERT' THEN
        k := 'evidence'; t := 'Evidence flagged by ' || coalesce(pname, 'a post') || ' (flag #' || NEW.id || ')'; b := left(NEW.justification, 200);
      ELSIF NEW.ext_status = 'pending' AND OLD.ext_status IS DISTINCT FROM 'pending' THEN
        k := 'retention'; t := coalesce(pname, 'A post') || ' asks for a longer retention (flag #' || NEW.id || ')'; b := left(NEW.ext_justification, 200);
      ELSIF NEW.archive_status = 'failed' AND OLD.archive_status IS DISTINCT FROM 'failed' THEN
        k := 'error'; t := 'Evidence archive failed (flag #' || NEW.id || ')'; b := coalesce(pname, '');
      ELSE RETURN NULL; END IF;
    ELSE RETURN NULL; END IF;
    INSERT INTO console_notice (zone_id, post_id, kind, title, body, ref_entity, ref_id) VALUES (zid, pid, k, t, nullif(b, ''), ent, rid);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a notice problem must never fail the write it describes
  END;
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['alert','incident','train_request','evidence_flag'] LOOP
        IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
        EXECUTE format('DROP TRIGGER IF EXISTS trg_console_notice ON %I', t);
        EXECUTE format('CREATE TRIGGER trg_console_notice AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION console_notice_event()', t);
    END LOOP;
END $$;

INSERT INTO schema_migration (version) VALUES ('010_console_notices') ON CONFLICT DO NOTHING;
