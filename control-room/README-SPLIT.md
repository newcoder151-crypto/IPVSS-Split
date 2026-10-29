# IPVSS on two PCs

    control-room/   ->  PC 1 (control room):  CMS + RPF + their database + the footage folder
    train/          ->  PC 2 (train):          M-NVR + bridge + the M-NVR's database + recordings

Both PCs: Linux (Ubuntu/Debian), connected to the same network. Below, **PC1-IP** and **PC2-IP** are their addresses
(find each with `hostname -I`, e.g. 172.210.140.20 and 172.210.140.50).

---------------------------------------------------------------------------------------------------------------------
## STEP-BY-STEP

**Which address of a PC is used:** the first time you run `bash start.sh` on a PC it lists that PC's addresses and **you choose**
(Enter accepts the suggestion, `t` types another). The choice is remembered in `data/host-ip` and is what the messages and the
"connect from the train" hint show. Change it any time with `bash start.sh choose-ip` (or `--ip <address>`).

### 0. Before you start
1. Copy `control-room/` to PC 1 and `train/` to PC 2 (USB stick, or `scp -r control-room user@PC1-IP:~/`).
2. On each PC open a terminal and `cd` into its folder. Your user needs `sudo` (the launcher installs missing tools and
   creates the databases; it may ask for your password once).
3. The launchers install what is missing (Node 18+, ffmpeg, curl, PostgreSQL client, python3). PC 1 additionally needs
   **PostgreSQL 15+ with PostGIS**; if it is not installed:
   `sudo apt install -y postgresql postgis`   (PC 2 also needs a local PostgreSQL: `sudo apt install -y postgresql`).
4. Check the two PCs can see each other: from PC 2 run `ping PC1-IP`.

### 1. PC 1 (control room) - start CMS + RPF
    cd control-room
    bash start.sh                 # add  --demo-data  to also load demo zones, posts and logins
Wait until it prints "CMS + RPF are running" and shows the addresses. First run takes a few minutes (installs packages,
creates the database).

### 2. PC 1 - choose who may connect (once)
    bash start.sh allow-train
It asks which PC(s) may connect as a train: **1)** one train PC (you type its IP), **2)** a whole network (shown, taken from this
PC's own network card), or **3)** a network you type (e.g. `172.210.140.0/24`). You can also give it directly:
`bash start.sh allow-train 172.210.140.50`  or  `bash start.sh allow-train 172.210.140.0/24`.
This opens the CMS database to those addresses only. PostgreSQL restarts once (CMS and RPF keep running).
Then open the firewall on PC 1 (the command prints the lines for `ufw`; skip this if you have no firewall):

    sudo ufw allow 5432/tcp          # database login of the train bridge
    sudo ufw allow 7080/tcp          # CMS (the bridge, and operators' browsers)
    sudo ufw allow 7090/tcp          # RPF dashboard for officers' PCs

### 3. PC 2 (train) - start M-NVR + bridge
    cd train
    bash start.sh --cms PC1-IP
It remembers PC 1 in `data/train.conf`, so from now on just `bash start.sh`.
The first start is slow (it downloads the AI packages, a few GB, in the background); the M-NVR is usable meanwhile.
If you use a firewall on PC 2, open 8080 (web page) and 8889, 8888, 8554 (live video):

    sudo ufw allow 8080/tcp ; sudo ufw allow 8889/tcp ; sudo ufw allow 8888/tcp ; sudo ufw allow 8554/tcp

### 4. Check that they are connected
* PC 2, at the end of `bash start.sh`: it waits for the link and prints **"bridge is connected to the control room"**.
  If not, it prints the exact reason and what to do (see step 7); the bridge keeps retrying by itself and connects as soon as
  the cause is fixed - no restart needed.
* PC 2: `bash start.sh check-cms` repeats the test (CMS over HTTP + CMS database) with the real error text.
* PC 2: `curl http://127.0.0.1:8095/health` shows `"online": true` and, if not, `link.stage` / `link.error` say why.
* PC 1: `bash start.sh trains` lists the trains that connected and when each last reported.
* Browser: CMS console `http://PC1-IP:7080/console/` -> the train appears in the fleet with a recent contact.

### 5. First-time setup in the browsers
1. **RPF** `http://PC1-IP:7090` - on first open it shows the Thana / Post registration form: fill it in (post name, zone,
   location, officer login). The CMS needs at least one zone first: create it in the CMS console, or start PC 1 with
   `--demo-data`.
2. **CMS console** `http://PC1-IP:7080/console/`.
3. **M-NVR** `http://PC2-IP:8080` (user `admin`).
4. All logins are **Admin@123** after the first start. Change them (Account / Password) - everyone on the network can reach the
   login pages.
5. On the M-NVR set the unit name and train number in its settings (`device_name`, `train_number`); the bridge reads them.

### 6. Every day
| | PC 1 | PC 2 |
|---|---|---|
| start | `bash start.sh` | `bash start.sh` |
| stop | `bash start.sh stop` | `bash start.sh stop` |
| restart | `bash start.sh restart` | `bash start.sh restart` |
| status | `bash start.sh status` | `bash start.sh status` |
| logs | `bash start.sh logs cms` / `rpf` | `bash start.sh logs mnvr` / `bridge` |
| reset passwords to Admin@123 | `bash start.sh reset-passwords` (CMS + RPF) | `bash start.sh reset-passwords` (M-NVR) |
Start PC 1 first; but PC 2 may boot first too: the bridge keeps retrying until the control room is reachable.

### 7. If something does not work
Run on PC 2 first: `bash start.sh check-cms` - it prints the reason. Then:
| Message / symptom | Fix |
|---|---|
| "where is the control room?" | run once `bash start.sh --cms PC1-IP` (PC 1's real address: `hostname -I` on PC 1) |
| "CMS does NOT answer" | CMS not running on PC 1 (`bash start.sh status` there), wrong address, or PC 1's firewall blocks 7080 (`sudo ufw allow 7080/tcp`) |
| "no pg_hba.conf entry for host ..." | on PC 1: `bash start.sh allow-train` |
| "Connection refused" / "timed out" to port 5432 | on PC 1: `bash start.sh allow-train` (PostgreSQL then listens on the network) and `sudo ufw allow 5432/tcp` |
| "password authentication failed" | on PC 2: `bash start.sh --cms-db-password '<password>'` (default `cms`) |
| M-NVR page says "CMS bridge not running" | the bridge is not started on PC 2: `bash start.sh` there; `bash start.sh logs bridge` |
| M-NVR page says the bridge is running but CMS offline | the link to PC 1 is down: `bash start.sh check-cms` on PC 2 |
| "CMS has no zones yet" in the bridge log | create a zone in the CMS console (or `bash start.sh --demo-data` on PC 1, then `restart`) |
| Browser on another PC cannot open a page | firewall on that PC (ports in steps 2 and 3), and use the IP, not `localhost` |
| Footage delivered but file missing | on PC 1: `bash start.sh check-footage` / `diagnose-footage` |
| PC 2 time differs from PC 1 | enable NTP on both (`sudo timedatectl set-ntp true`); `clock_drift_s` in the bridge health shows it |

### 8. Running both on ONE PC (testing)
Put both folders on one machine, start `control-room` first, then in `train` run `bash start.sh --cms localhost`.
(Skip step 2 in that case.)

---------------------------------------------------------------------------------------------------------------------
## How the PCs talk (unchanged from before)
| What | How | Port on PC 1 |
|---|---|---|
| heartbeat, GPS, alerts, footage commands and upload | HTTP to the CMS (`/nvr/v1`) | 7080 |
| the bridge's self-registration rows (unit, zone assignment, cameras) | PostgreSQL, database `cms` | 5432 |
| officers' browsers | RPF dashboard | 7090 |

The bridge status (`127.0.0.1:8095`, used by the M-NVR "CMS Requests" page) stays on PC 2.

## What changed compared with the single-PC version
* The old single `start.sh` is now one `start.sh` per PC. In `bridge/` only `src/index.js` and `src/status.js` changed: the
  health page now starts first and shows why the control room cannot be reached (before, it stayed closed until the link worked,
  so the M-NVR page just said "bridge not running"). Communication itself is unchanged.
* Open network: CORS is open to any origin (M-NVR API `backend/api/src/index.js`; CMS and RPF `src/server.js` got an open CORS
  middleware), the M-NVR web server accepts any host name (`frontend/vite.config.ts`), `CORS_ORIGIN` is no longer used.
  Logins (JWT) still protect every API. `MANIFEST.md5` has a checksum of every code file (`md5sum -c MANIFEST.md5`).

## Notes
* **Database password.** The CMS role is `cms` / `cms`. Set a real one: PC 1 `CMS_DB_PASSWORD='...' bash start.sh restart`,
  PC 2 `bash start.sh --cms-db-password '...'` (only the default password was tested).
* **No coverage / PC 1 down:** alerts and GPS wait in the M-NVR database and are sent when the link returns.
* **Time zone:** the bridge runs with the same `TZ` as the M-NVR (unchanged).
* **Moving an existing install:** CMS database + old `media/` folder belong on PC 1 (put `media/` in `control-room/`);
  M-NVR database + recordings stay on PC 2. To keep the train's identity copy the old `bridge/state/` into `train/bridge/`.
* `docs/INTEGRATION.md` and the `CHANGES-*.md` files describe the application behaviour and still apply.
