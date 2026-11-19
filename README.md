# IPVSS control room - OFFLINE package (CMS + RPF)

Everything the control-room PC needs is **inside this folder**: Node.js, the npm packages, PostgreSQL 16 + PostGIS, ffmpeg, curl,
Python and every other Ubuntu package they depend on. **No internet is used - not for installing, not for running.**

This package is the **control room only** (CMS + RPF + database). The train software is not part of it.

---------------------------------------------------------------------------------------------------------------------
## 1. Requirements

| | |
|---|---|
| PC | 64-bit Intel/AMD (amd64), **Ubuntu 24.04 LTS** (desktop or server) |
| User | a normal user that has **sudo** (the password is asked once, to install the packages) |
| Disk | about **2 GB free** plus room for footage |
| Internet | **not needed** |

## 2. Install and run - step by step

**1. Copy `IPVSS-Split-offline.zip` to the PC** (USB stick is fine) and unpack it into your home folder:

    cd ~
    unzip -q IPVSS-Split-offline.zip          # no unzip?  right-click the zip -> "Extract Here"
    cd IPVSS-Split-main
    ls                                        # you must see:  control-room  run-offline.sh  README.md

**2. (Optional) check what is already installed - this changes nothing:**

    bash run-offline.sh check

**3. Install and start - one command:**

    bash run-offline.sh                       # or:  bash run-offline.sh --demo-data   (also loads demo zones / posts / logins)

What it does by itself, in this order (the first start takes 3-6 minutes):

1. Checks the files of the package (checksums) - stops with a message if something is damaged or missing.
2. Asks **which of this PC's addresses the train PCs should use** - press Enter to accept the suggestion.
3. Installs the missing Ubuntu packages from `control-room/offline/apt-repo` (sudo password prompt). Node.js and npm come from the package itself.
4. Creates the database `cms` (with PostGIS), applies the schema and migrations, and starts **CMS** and **RPF**.
5. Opens the database and the firewall (ufw, if active) for the train network, and prints the addresses.

It ends with:

      CMS + RPF are running.
        CMS     http://<this-pc-ip>:<CMS_PORT>/console/
        RPF     http://<this-pc-ip>:<RPF_PORT>
      On each train PC:              bash start.sh --cms <this-pc-ip>

(`CMS_PORT`, `RPF_PORT` and the database settings are in `control-room/config/control-room.conf`.)

**4. Open the pages** from this PC or any PC on the same network (use the IP, not `localhost`, from other PCs):

* **RPF** - the Thana / Post registration form opens on first visit.
* **CMS console** - `.../console/`. The CMS needs at least one zone: create it in the console, or start with `--demo-data`.
* **All logins are `Admin@123`** after the first start. **Change them.** With `--demo-data` the demo users (`cms-super`, `cms-operator`,
  `cms-zone1-admin`, ...) also get `Admin@123`. CMS accounts sign in to the CMS console, RPF post accounts to the RPF page.

**5. Connect a train PC:** on the train PC run `bash start.sh --cms <this-pc-ip>` (from its own software; not part of this package).

## 3. Every day

Run these in `IPVSS-Split-main/` (after a reboot PostgreSQL starts by itself; run `bash run-offline.sh` to bring CMS + RPF up):

| Do | Command |
|---|---|
| start | `bash run-offline.sh` |
| stop | `bash run-offline.sh stop` |
| restart | `bash run-offline.sh restart` |
| status | `bash run-offline.sh status` |
| logs | `bash run-offline.sh logs cms`   /   `bash run-offline.sh logs rpf` |
| which trains are connected | `bash run-offline.sh trains` |
| let one more train PC / network in | `bash run-offline.sh allow-train <ip>`   /   `<network/bits>` |
| change the address trains use | `bash run-offline.sh choose-ip` |
| reset all logins to `Admin@123` | `bash run-offline.sh reset-passwords` |
| install the system packages only | `bash run-offline.sh install` |
| all options | `bash run-offline.sh help` |

(`cd control-room && bash start.sh ...` does the same; `run-offline.sh` just adds the package check and the offline install.)

## 4. What is in this folder

| Path | What it is |
|---|---|
| `run-offline.sh` | the one command to install + run (above) |
| `control-room/start.sh` | the real launcher (database, CMS, RPF); also works on its own |
| `control-room/config/control-room.conf` | all settings: ports, hosts, database, offline switches - nothing is hard-coded in the scripts |
| `control-room/RPF_CMS/` | the CMS and RPF programs, with their `node_modules` already installed |
| `control-room/offline/apt-repo/` | all Ubuntu 24.04 packages as `.deb` files (a local apt repository) |
| `control-room/offline/runtime/node/` | Node.js + npm |
| `control-room/offline/npm-cache/` | npm packages (to rebuild `node_modules` without internet) |
| `control-room/offline/install-offline.sh` | installs the Ubuntu packages from `apt-repo` using only this folder |
| `control-room/offline/rebuild-bundle.sh` | refreshes the whole offline bundle - on an Ubuntu 24.04 PC *with* internet |
| `control-room/README-OFFLINE.md` | more detail (settings, troubleshooting) |
| `train-footage-request-api.docx` | API description of the train footage request |

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `bundle is incomplete` / `a file of the bundle is damaged` | the zip was not unpacked completely - unpack `IPVSS-Split-offline.zip` again into a new folder |
| `Permission denied` | always start with `bash run-offline.sh` (zip files can lose the executable bit) |
| `could not read the offline repository` | the folder is on a read-only or `noexec` USB stick - copy it to the PC's disk (e.g. your home folder) |
| apt error about broken packages | `sudo dpkg --configure -a`, then `bash run-offline.sh install` |
| PostgreSQL not answering | `sudo systemctl status postgresql`; `pg_lsclusters` should show `16 main ... online`; then `bash run-offline.sh` |
| CMS/RPF do not start | `bash run-offline.sh logs cms` / `rpf`; also `control-room/logs/` |
| train PC cannot connect | on this PC `bash run-offline.sh allow-train <train-ip>`; with a firewall other than ufw open the CMS, RPF and database ports of `control-room.conf` |
| `node_modules` damaged | delete `control-room/RPF_CMS/rpf/node_modules` and `control-room/RPF_CMS/CMS/backend/node_modules`, run `bash run-offline.sh` - they are rebuilt from the bundle without internet |
| other PCs cannot open the pages | use the PC's IP (not `localhost`) and open the firewall for the CMS and RPF ports |

## 6. Good to know

* Only the "open on map" link in the dashboards needs internet (it opens openstreetmap.org). Everything else works on an isolated network.
* **E-mail and SMS alerts** (optional): CMS console -> Administration -> **E-mail & SMS** (connect a provider, set each post's e-mail / mobile, switch on,
  test) - see `control-room/docs/ALERT-CHANNELS.md`. Sending needs the provider to be reachable (internet); everything else works offline.
* The Ubuntu packages are a snapshot of Ubuntu 24.04 (with updates) from the day the package was built. To refresh them on a PC *with*
  internet: `sudo bash control-room/offline/rebuild-bundle.sh`, then copy the new `control-room/offline/` folder over the old one.
* On other Ubuntu versions the installer only warns; 24.04 LTS is what was tested. It refuses non-amd64 PCs.
