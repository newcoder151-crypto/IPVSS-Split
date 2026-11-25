# Several CMS working together (N+1 redundancy, several locations)

Run more than one CMS - on different computers, in different places - as **one system**:

* **Every CMS knows everything.** Alerts, incidents, requests, evidence, users, settings, the audit trail: whatever is created on one CMS appears on all the others within seconds.
* **Every CMS can play the video of every other CMS.** A recording stays on the disk of the CMS that recorded it; when someone on another CMS plays or downloads it, it is streamed from there (seeking works). **Archived evidence is copied** to every CMS, so it survives the loss of a computer.
* **N+1.** If a CMS stops, the others notice within seconds, the lowest-numbered CMS that is alive takes over its alert / notification work, and nothing is lost. Posts (RPF) can list several CMS databases and switch by themselves.
* **A Cluster tab** shows which CMS exist, which are running, what each is doing, whether the data is in sync, and what happened.

A CMS that is not put in a cluster behaves exactly as before. Nothing changes until you create one.

## How it works

| What | How |
|---|---|
| Identity | Every CMS has a **node number** (1, 2, 3 ...), a node uuid, a name, a location and an address (the registry `cms_node`, shared by all). |
| Unique ids | Every CMS makes record numbers in **its own range** (node 1: up to 1 999 999 999, node N: N×10⁹ and up). Rows made on different CMS never collide, and a number tells which CMS made it. |
| Data sync | **PostgreSQL logical replication**, every database to every other (a mesh, both directions, no loops). Each CMS keeps its own database, so a location keeps working when the network between locations is down, and catches up afterwards. |
| Who does the background work | A CMS works on what it made / on its own M-NVRs. If the CMS that owns the work is down, the lowest-numbered live CMS takes over the database-only work (escalating unacknowledged alerts, e-mail/SMS, reminders). Work that needs the video files stays with the CMS that holds the files. |
| Heartbeat | Every 10 s each CMS stamps its row and asks every other CMS "are you there?". A CMS is "offline" after 45 s of silence. |
| Video | Played from the other CMS through your own CMS (the browser only ever talks to its own CMS). Requests between CMS are signed with the cluster secret. |
| Evidence | The archived clip of each evidence flag is copied to every other CMS and checked against its SHA-256; the copy is removed when the flag is released. |
| Posts | A post lists several CMS databases in `DB_HOST` and fails over; with `CMS_CLUSTER_SECRET` it can also play footage stored on another CMS. |

## What you need

* PostgreSQL **16 or newer** on every CMS computer (older versions cannot do two-way replication without loops).
* The CMS computers can reach each other: the **CMS port** (7080) and **PostgreSQL** (5432).
* **Clocks in sync** (NTP) on every computer. The Cluster tab warns when a clock is more than 5 s off.
* The **same CMS version** on every computer.

## Set it up

**1. Every computer** (as the postgres account), once:

    sudo -u postgres bash control-room/cluster/prepare-db.sh --allow 10.0.0.0/8
    sudo systemctl restart postgresql        # wal_level only changes on a restart

It prints the replication account and password. Keep them.

**2. The first CMS** (the one that already holds your data), in `CMS/backend`:

    node scripts/cluster.js create --name "Delhi CMS" --location "Delhi" --url http://10.1.1.10:7080

It becomes node 1, keeps its data and ids, and prints the **cluster secret**. Put these in its `.env` and restart the CMS:

    CMS_CLUSTER_SECRET=<the secret>
    CMS_PUBLIC_URL=http://10.1.1.10:7080

**3. Each further computer**: install the CMS with an **empty database** (schema only - start the CMS once, or run the schema), copy the secret into its `.env`, then:

    node scripts/cluster.js join --seed http://10.1.1.10:7080 \
      --seed-db "host=10.1.1.10 port=5432 dbname=cms user=cms_repl password=..." \
      --seed-admin-db "host=10.1.1.10 port=5432 dbname=cms user=cms password=..." \
      --my-db "host=10.2.2.20 port=5432 dbname=cms user=cms_repl password=..." \
      --name "Lucknow CMS" --location "Lucknow" --url http://10.2.2.20:7080

It gets its node number and id range, copies everything, and connects in both directions. With **more than two CMS** also link every pair that has not been linked yet:

    node scripts/cluster.js peer --node 3 --db "host=... user=cms_repl ..." --admin-db "host=... user=cms ..." --my-db "host=... user=cms_repl ..."

**4.** Open the **Cluster** tab in the CMS console: every CMS should be *online*, data sync *OK*, N+1 *Yes*.

## Posts and M-NVRs

* **Posts (RPF):** in the post's `.env` set `DB_HOST=10.1.1.10,10.2.2.20` (its own CMS first) and `CMS_CLUSTER_SECRET=...`.
* **M-NVRs:** an M-NVR talks to one CMS. Give it the addresses of the other CMS too if the M-NVR software supports a list; the CMS an M-NVR is connected to is recorded (`home_node`) and its footage work follows it.

## Day to day

* **Planned stop of a CMS:** just stop it. The others take over its alert work; its video is unavailable until it is back (evidence stays available). When it starts again it catches up by itself.
* **A CMS retired for good:** Cluster tab -> Remove (from another CMS). Its data stays everywhere.
* **A CMS is down for days:** its replication slots keep PostgreSQL log files on the other computers. Set `max_slot_wal_keep_size` in PostgreSQL (e.g. 20GB) or remove the CMS from the cluster, so a dead computer cannot fill the disk of the others.
* **Rename / move a CMS:** Cluster tab -> Edit.

## Updating the software

* Put **the same version on every CMS**. Database changes (new columns, new tables) are NOT copied by the data sync: each CMS applies them itself when it starts (`start.sh` does this). Update and restart every CMS in the same maintenance window.
* A CMS that is still on the old version cannot take rows that carry a new column: its data link stalls (shown as "errors" on the Cluster tab) and resumes by itself once it has been updated. Nothing is lost.
* New tables are added to the shared set automatically at start.

## Good to know (limits)

* **Two people creating the same unique thing on two CMS at the same moment** (the same user name, the same zone name) is a conflict: the data sync of that table stops with an error until one of them is renamed. The Cluster tab shows "errors" for that link. Create users and settings on one CMS at a time.
* **Sessions are per CMS.** A person signed in on one CMS signs in again on another (the account itself is shared).
* **Two CMS cut off from each other** (network problem) each think the other is down and each do the take-over work, so an alert can be escalated twice. It heals when the network is back. Video of a CMS that is cut off is unavailable to the others.
* **GPS history and every other table are shared** (the GPS table can be large: size the network and disk accordingly).
* The id range of a CMS holds a billion records: more than enough for decades.

## Troubleshooting

    node scripts/cluster.js status
    psql -c "select subname, subenabled from pg_subscription"
    psql -c "select * from pg_stat_subscription_stats"
    tail -f /var/log/postgresql/postgresql-16-main.log      # replication errors are logged here

* *"this CMS is not part of a cluster"* - run `create` (first CMS) or `join` (others).
* *A CMS shows "online - sync behind"* - it answers, but its heartbeat does not reach this CMS through the database: the data link towards this CMS is down or behind.
* *"the CMS ... that holds this recording is offline"* - the recording is on that CMS's disk; evidence clips are already copied everywhere.
