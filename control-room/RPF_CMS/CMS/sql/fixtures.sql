-- Dev/demo fixtures only. NOT for production seeding.
-- Reference data (zones, posts, NVR units) is safe to insert directly.
-- Alerts and incidents are NOT here on purpose - see scripts/seed_demo_data.sh,
-- which creates them through the backend API so the real dispatch logic
-- (routing, composite FKs, partitioned alert table) is exercised correctly
-- instead of re-implemented by hand in SQL.

INSERT INTO zone (name) VALUES ('Zone 1') ON CONFLICT (name) DO NOTHING;
INSERT INTO zone (name) VALUES ('Zone 2') ON CONFLICT (name) DO NOTHING;

INSERT INTO rpf_post (zone_id, name, location)
SELECT z.id, v.name, ST_SetSRID(ST_MakePoint(v.lon, v.lat), 4326)::geography
FROM (VALUES
    ('Zone 1', 'Post A', 80.10, 26.00),
    ('Zone 1', 'Post B', 81.50, 26.20),
    ('Zone 2', 'Post C', 77.20, 28.60)
) AS v(zone_name, name, lon, lat)
JOIN zone z ON z.name = v.zone_name
WHERE NOT EXISTS (
    SELECT 1 FROM rpf_post p WHERE p.zone_id = z.id AND p.name = v.name
);

INSERT INTO nvr_unit (name, cert_fingerprint, current_zone_id)
SELECT v.name, v.fp, z.id
FROM (VALUES
    ('nvr-1', 'fp-demo-1', 'Zone 1'),
    ('nvr-2', 'fp-demo-2', 'Zone 1'),
    ('nvr-3', 'fp-demo-3', 'Zone 2')
) AS v(name, fp, zone_name)
JOIN zone z ON z.name = v.zone_name
ON CONFLICT (cert_fingerprint) DO NOTHING;

-- Three cameras per unit (coach positions), plus a train number per unit.
INSERT INTO camera (nvr_id, name, mount_position)
SELECT n.id, v.cam, v.pos
FROM nvr_unit n
CROSS JOIN (VALUES ('cam-1', 'Coach C1 - vestibule'), ('cam-2', 'Coach C2 - corridor'), ('cam-3', 'Loco cab')) AS v(cam, pos)
WHERE n.name IN ('nvr-1', 'nvr-2', 'nvr-3')
  AND NOT EXISTS (SELECT 1 FROM camera c WHERE c.nvr_id = n.id AND c.name = v.cam);

UPDATE camera SET mount_position = 'Coach C1 - vestibule' WHERE name = 'cam-1' AND mount_position IS NULL;

UPDATE nvr_unit SET train_no = CASE name WHEN 'nvr-1' THEN '12301 Rajdhani' WHEN 'nvr-2' THEN '12419 Gomti Exp' WHEN 'nvr-3' THEN '12002 Shatabdi' END
 WHERE name IN ('nvr-1','nvr-2','nvr-3') AND train_no IS NULL;

-- Zone assignment history: every unit starts with one open assignment.
INSERT INTO nvr_zone_assignment (nvr_id, zone_id, assigned_from)
SELECT n.id, n.current_zone_id, now() - interval '90 days'
FROM nvr_unit n
WHERE n.current_zone_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM nvr_zone_assignment a WHERE a.nvr_id = n.id);

-- Demo CMS console logins (password: cms-demo-123). Dev only.
INSERT INTO users (zone_id, post_id, role, username, password_hash)
SELECT z.id, NULL, v.role::user_role, v.username, '$2a$10$Y7B5gLuq1INfg7tazNcfeuKJvpCm3kmtVbiV9lAQsU2oeuR/yTwXi'
FROM (VALUES ('Zone 1','operator','cms-operator'), ('Zone 1','zone_admin','cms-zone1-admin'), ('Zone 2','operator','cms-operator-z2')) AS v(zone_name, role, username)
JOIN zone z ON z.name = v.zone_name
ON CONFLICT (username) DO NOTHING;
INSERT INTO users (zone_id, post_id, role, username, password_hash)
VALUES (NULL, NULL, 'super_admin', 'cms-super', '$2a$10$Y7B5gLuq1INfg7tazNcfeuKJvpCm3kmtVbiV9lAQsU2oeuR/yTwXi')
ON CONFLICT (username) DO NOTHING;
