-- =====================================================================
-- CMS migration 011 - several CMS that work together (N+1 redundancy, several locations)
--
--   cms_node            the registry of every CMS of the cluster (REPLICATED, so every CMS knows all the others).
--                       A CMS writes only its OWN row.
--   cms_cluster_config  who THIS CMS is: cluster id, its node uuid and its node number (LOCAL, never replicated)
--   cms_peer_status     what this CMS sees of the others: reachable, round trip, last answer (LOCAL)
--   cluster_event       log of nodes coming / going, take-overs, joins (LOCAL)
--
--   Unique ids: every CMS gets its own range of ids (node 1 = 1..1999999999, node N = N*1e9 .. N*1e9+999999999), so rows made on
--   different CMS never collide and the CMS that made a row is known from its id. cms_assign_id_space() sets the ranges.
--
--   Who does the background work: cms_owns(id) / cms_owns_strict(id) / cms_owns_nvr(nvr_id). A CMS that is NOT clustered owns
--   everything (nothing changes for a single CMS). In a cluster a CMS works on what it made; if that CMS is down the lowest
--   numbered CMS that is alive takes over the database-only work (alerts, notifications). Work that needs the video files
--   stays with the CMS that holds the files.
--
--   No existing table changes except nvr_unit.home_node (the CMS the M-NVR is currently connected to). Idempotent.
-- =====================================================================
CREATE TABLE IF NOT EXISTS cms_node (
    node_uuid   uuid PRIMARY KEY,
    node_no     integer NOT NULL UNIQUE CHECK (node_no > 0),
    name        text NOT NULL,
    location    text,
    url         text,                                   -- how the other CMS (and posts) reach this one, e.g. http://10.1.2.3:7080
    role        text NOT NULL DEFAULT 'active' CHECK (role IN ('active', 'standby')),
    version     text,
    started_at  timestamptz,
    last_seen   timestamptz,
    stats       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    removed_at  timestamptz
);

CREATE TABLE IF NOT EXISTS cms_cluster_config (
    id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    cluster_id  uuid NOT NULL,
    node_uuid   uuid NOT NULL,
    node_no     integer NOT NULL CHECK (node_no > 0)
);

CREATE TABLE IF NOT EXISTS cms_peer_status (
    node_uuid     uuid PRIMARY KEY,
    reachable     boolean NOT NULL DEFAULT false,
    rtt_ms        integer,
    last_ok_at    timestamptz,
    last_check_at timestamptz,
    skew_ms       integer,
    error         text,
    info          jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS cluster_event (
    id       bigserial PRIMARY KEY,
    at       timestamptz NOT NULL DEFAULT now(),
    kind     text NOT NULL,
    node_no  integer,
    message  text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cluster_event_at ON cluster_event (at DESC);

ALTER TABLE nvr_unit ADD COLUMN IF NOT EXISTS home_node integer;   -- the CMS this M-NVR last talked to (NULL = the CMS that enrolled it)

-- ---------------------------------------------------------------------------------------------------------------
-- who is alive / who owns what
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cms_node_alive(n integer) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM cms_node x
         WHERE x.node_no = n AND x.removed_at IS NULL
           AND (x.last_seen > now() - interval '45 seconds'
                OR EXISTS (SELECT 1 FROM cms_peer_status p WHERE p.node_uuid = x.node_uuid AND p.last_ok_at > now() - interval '45 seconds')
                OR x.node_uuid = (SELECT node_uuid FROM cms_cluster_config WHERE id = 1)));
$$;

/** The CMS that made a row, from its id (ids below 2e9 belong to the first CMS: the one that existed before the cluster). */
CREATE OR REPLACE FUNCTION cms_id_node(rid bigint) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
    SELECT GREATEST(1, (rid / 1000000000)::integer);
$$;

/** The work on this row is mine: I made it - or the CMS that made it is down and I am the lowest numbered CMS that is alive. */
CREATE OR REPLACE FUNCTION cms_owns(rid bigint) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE me integer; owner integer; succ integer;
BEGIN
    SELECT node_no INTO me FROM cms_cluster_config WHERE id = 1;
    IF me IS NULL OR rid IS NULL THEN RETURN true; END IF;                -- not clustered: everything is mine
    owner := cms_id_node(rid);
    IF owner = me THEN RETURN true; END IF;
    IF cms_node_alive(owner) THEN RETURN false; END IF;
    SELECT min(node_no) INTO succ FROM cms_node WHERE removed_at IS NULL AND node_no <> owner AND cms_node_alive(node_no);
    RETURN succ = me;
END $$;

/** Work that needs the FILES of this row: only the CMS that made it (no take-over - the files are on its disk). */
CREATE OR REPLACE FUNCTION cms_owns_strict(rid bigint) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE me integer;
BEGIN
    SELECT node_no INTO me FROM cms_cluster_config WHERE id = 1;
    IF me IS NULL OR rid IS NULL THEN RETURN true; END IF;
    RETURN cms_id_node(rid) = me;
END $$;

/** Work for an M-NVR belongs to the CMS it is connected to now. */
CREATE OR REPLACE FUNCTION cms_owns_nvr(nvr bigint) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE me integer; home integer;
BEGIN
    SELECT node_no INTO me FROM cms_cluster_config WHERE id = 1;
    IF me IS NULL OR nvr IS NULL THEN RETURN true; END IF;
    SELECT COALESCE(home_node, cms_id_node(id)) INTO home FROM nvr_unit WHERE id = nvr;
    RETURN COALESCE(home, cms_id_node(nvr)) = me;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- replication helpers (the application / scripts call these; nothing happens until a CMS joins a cluster)
-- ---------------------------------------------------------------------------------------------------------------
/** Give this CMS its own range of ids. Node 1 keeps what it has and is capped at 1999999999; node N starts at N*1e9. */
CREATE OR REPLACE FUNCTION cms_assign_id_space(n integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE r record; k integer := 0; lo bigint := n::bigint * 1000000000; hi bigint := (n::bigint + 1) * 1000000000 - 1;
BEGIN
    FOR r IN
        SELECT format('%I.%I', ns.nspname, s.relname) AS seq
          FROM pg_class s JOIN pg_namespace ns ON ns.oid = s.relnamespace
          JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
          JOIN pg_class t ON t.oid = d.refobjid
         WHERE s.relkind = 'S' AND ns.nspname = 'public' AND t.relname <> 'cluster_event'
    LOOP
        IF n = 1 THEN
            EXECUTE format('ALTER SEQUENCE %s MAXVALUE %s', r.seq, 1999999999);
        ELSE
            EXECUTE format('ALTER SEQUENCE %s MINVALUE %s MAXVALUE %s START WITH %s RESTART WITH %s', r.seq, lo, hi, lo, lo);
        END IF;
        k := k + 1;
    END LOOP;
    RETURN k;
END $$;

/** Tables that are shared by every CMS. Not shared: this CMS's own migration list, job status, PostGIS data, cluster bookkeeping. */
CREATE OR REPLACE FUNCTION cms_shared_tables() RETURNS SETOF text LANGUAGE sql STABLE AS $$
    SELECT format('public.%I', c.relname)
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND c.relname NOT IN ('schema_migration', 'job_status', 'spatial_ref_sys', 'cms_cluster_config', 'cms_peer_status', 'cluster_event')
     ORDER BY c.relname;
$$;

/** (Re)build the publication that carries every shared table to the other CMS. Returns how many tables it carries. */
CREATE OR REPLACE FUNCTION cms_refresh_publication() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE list text; n integer;
BEGIN
    SELECT string_agg(t, ', '), count(*) INTO list, n FROM cms_shared_tables() t;
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'cms_pub') THEN
        EXECUTE 'ALTER PUBLICATION cms_pub SET TABLE ' || list;
    ELSE
        EXECUTE 'CREATE PUBLICATION cms_pub FOR TABLE ' || list || ' WITH (publish_via_partition_root = true)';
    END IF;
    RETURN n;
END $$;

/** Rows that arrive by replication do not fire ordinary triggers. The "live" trigger must, so the console of THIS CMS refreshes too. */
CREATE OR REPLACE FUNCTION cms_enable_live_triggers() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE r record; k integer := 0;
BEGIN
    FOR r IN SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
              WHERE ns.nspname = 'public' AND t.tgname = 'trg_live' AND NOT c.relispartition AND NOT t.tgisinternal
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER trg_live', r.relname);
        k := k + 1;
    END LOOP;
    RETURN k;
END $$;

/** Alert / GPS partitions for every month between two dates (a CMS that joins must have a place for the older rows it receives). */
CREATE OR REPLACE FUNCTION ensure_partitions_between(d_from date, d_to date) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE tbl text; m date; nxt date; part text; made integer := 0;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['alert', 'gps_point'] LOOP
        IF to_regclass('public.' || tbl) IS NULL THEN CONTINUE; END IF;
        m := date_trunc('month', d_from)::date;
        WHILE m <= d_to LOOP
            nxt := (m + interval '1 month')::date;
            part := format('%s_%s', tbl, to_char(m, 'YYYY_MM'));
            BEGIN
                IF to_regclass('public.' || part) IS NULL THEN
                    EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', part, tbl, m, nxt);
                    made := made + 1;
                END IF;
            EXCEPTION WHEN invalid_object_definition OR duplicate_table THEN NULL;
            END;
            m := nxt;
        END LOOP;
    END LOOP;
    RETURN made;
END $$;

INSERT INTO schema_migration (version) VALUES ('011_cluster') ON CONFLICT DO NOTHING;
