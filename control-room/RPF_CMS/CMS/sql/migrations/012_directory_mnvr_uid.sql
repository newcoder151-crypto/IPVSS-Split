-- =====================================================================
-- CMS migration 012 - (1) every CMS finds the others by itself, (2) every M-NVR gets a unique id from the CMS,
--                     (3) evidence copies that are byte-identical to the delivered file.
-- Idempotent: safe to re-run. Applied by the launchers on every start.
--
-- (1) cms_identity   who THIS CMS is: a unique id (CMS-3F9A2C), a name and a place. Made once, on the first start. LOCAL (never replicated).
--     cms_directory  every CMS this one has heard of on the network (found by broadcast, by other CMS, or by an address in the config),
--                    when it was last seen and what it reported. LOCAL.
--
-- (2) nvr_unit.mnvr_uid  the unique id of an M-NVR, given by the CMS when the unit is first registered: M-<CMS code>-<number>,
--                        e.g. M-3F9A2C-0007. It is never taken from the M-NVR, never changes (a trigger refuses it) and never repeats,
--                        also not between CMS (the CMS code is part of it). Every way of creating a unit - the enrol call, the console, the
--                        bridge writing into the database - gets one from the trigger below. nvr_unit.id stays the numeric key the
--                        other tables point to; mnvr_uid is the key people and the other CMS use.
--
-- (3) evidence_flag.copy_kind  'whole' = the CMS archive copy and the post's copy are byte-for-byte copies of the delivered file (their
--                        SHA-256 are the same as the delivered file's); the flagged section is kept as start / end markers and cut on
--                        demand. 'section' = the older way: a new shorter file (its SHA-256 can never equal the whole file's).
-- =====================================================================

-- ---------------------------------------------------------------------
-- (1) identity + directory
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cms_identity (
    id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    cms_uid     text NOT NULL UNIQUE,
    cms_uuid    uuid NOT NULL,
    name        text,
    location    text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cms_identity (id, cms_uid, cms_uuid)
SELECT 1, 'CMS-' || upper(substr(replace(u::text, '-', ''), 1, 6)), u
  FROM (SELECT gen_random_uuid() AS u) g
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS cms_directory (
    cms_uid       text PRIMARY KEY,
    cms_uuid      uuid,
    name          text,
    location      text,
    url           text,
    host          text,
    version       text,
    source        text NOT NULL DEFAULT 'broadcast',   -- broadcast | gossip | config
    learned_from  text,
    first_seen    timestamptz NOT NULL DEFAULT now(),
    last_seen     timestamptz,                         -- last time anything was heard from it
    last_ok_at    timestamptz,                         -- last time it answered over HTTP
    last_check_at timestamptz,
    reachable     boolean NOT NULL DEFAULT false,
    rtt_ms        integer,
    skew_ms       integer,
    error         text,
    stats         jsonb NOT NULL DEFAULT '{}'::jsonb,
    trains        jsonb NOT NULL DEFAULT '[]'::jsonb,
    forgotten_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_cms_directory_seen ON cms_directory (last_seen DESC);

-- ---------------------------------------------------------------------
-- (2) unique M-NVR ids
-- ---------------------------------------------------------------------
ALTER TABLE nvr_unit ADD COLUMN IF NOT EXISTS mnvr_uid text;

CREATE OR REPLACE FUNCTION cms_make_mnvr_uid(p_id bigint) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT 'M-' || substr(cms_uid, 5) || '-' || lpad(p_id::text, 4, '0') FROM cms_identity WHERE id = 1
$$;

-- units that exist already get theirs now, oldest first
UPDATE nvr_unit SET mnvr_uid = cms_make_mnvr_uid(id) WHERE mnvr_uid IS NULL;

CREATE OR REPLACE FUNCTION cms_nvr_uid_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- the CMS gives the id; whatever a caller put there is ignored
        NEW.mnvr_uid := cms_make_mnvr_uid(NEW.id);   -- (rows that arrive by replication do not fire this trigger: they keep the id the other CMS gave)
    ELSIF NEW.mnvr_uid IS DISTINCT FROM OLD.mnvr_uid THEN
        RAISE EXCEPTION 'the M-NVR id % cannot be changed (it was given by the CMS and is permanent)', OLD.mnvr_uid USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_nvr_uid ON nvr_unit;
CREATE TRIGGER trg_nvr_uid BEFORE INSERT OR UPDATE ON nvr_unit FOR EACH ROW EXECUTE FUNCTION cms_nvr_uid_guard();

ALTER TABLE nvr_unit ALTER COLUMN mnvr_uid SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_nvr_unit_mnvr_uid ON nvr_unit (mnvr_uid);

-- (delivered_footage is insert-only, so it is not touched here: lists get the unit's id by joining nvr_unit.)

-- ---------------------------------------------------------------------
-- (3) evidence copies
-- ---------------------------------------------------------------------
ALTER TABLE evidence_flag ADD COLUMN IF NOT EXISTS copy_kind text;
-- flags made before this version were cut as sections (when a section was flagged) - keep saying so
UPDATE evidence_flag SET copy_kind = CASE WHEN section_start_s IS NULL THEN 'whole' ELSE 'section' END WHERE copy_kind IS NULL;
ALTER TABLE evidence_flag ALTER COLUMN copy_kind SET DEFAULT 'whole';
ALTER TABLE evidence_flag DROP CONSTRAINT IF EXISTS chk_evidence_copy_kind;
ALTER TABLE evidence_flag ADD CONSTRAINT chk_evidence_copy_kind CHECK (copy_kind IN ('whole', 'section'));
