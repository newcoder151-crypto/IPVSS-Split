#!/usr/bin/env python3
"""
mediamtx-sync.py — Syncs camera RTSP URLs from PostgreSQL → MediaMTX API.

How it works:
  1. Reads ACTIVE cameras from the DB (rtsp_url for the live-view source,
     rec_rtsp_url for the recording source — see "dual-profile" below —
     plus credentials from cameras_config_details, same join
     stream_manager.py uses)
  2. For each camera, creates TWO independent MediaMTX paths, each pulling
     directly from the camera over TCP using MediaMTX's own mature RTSP
     client and reconnect logic — this is the ONLY thing that ever opens
     an RTSP connection to a physical camera:
       cam_<id>_raw     ← rtsp_url      (live-view source profile)
       cam_<id>_rec_raw ← rec_rtsp_url, or rtsp_url if unset (recording
                          source profile — falls back to the live profile
                          for cameras that only expose a single stream,
                          so this is backward compatible with a
                          single-profile camera)
     This fleet's firmware appears to cap concurrent RTSP sessions per
     camera, and letting multiple independent home-grown ffmpeg processes
     each open their own connection caused unpredictable "one purpose
     connects, the other gets refused" failures — but MediaMTX opening
     TWO of its own well-behaved sessions (one per profile) has not shown
     that problem, since it's MediaMTX's own mature client both times,
     not a race between two different tools.
  2b. If a camera also has third_rtsp_url set (the ONVIF "ThirdStream"
      profile — typically a low-res analytics/mobile feed), a third,
      independent path cam_<camera_id>_third pulls straight from it too.
  3. stream_manager.py then reads ONLY these local paths (never the camera
     directly): cam_<id>_raw to burn in the watermark and produce the
     live-view cam_<id> path, cam_<id>_rec_raw to burn in the same
     watermark and produce the recorded segments — independently, so each
     can use whichever camera profile is actually suited to it (e.g. a
     camera's "unicaststream/1" tuned for low-latency live view,
     "unicaststream/4" tuned for high-quality archival). cam_<id>_third is
     a plain passthrough — stream_manager.py never touches it, it's just
     published as-is.
  4. Removes paths for cameras that are deleted/inactive, or that had
     their third_rtsp_url cleared
  5. Re-runs every SYNC_INTERVAL_SECS to pick up new cameras automatically

Path naming:
  cam_<id>_raw      — local-only, MediaMTX pulling the LIVE profile straight
                       from the camera (rtsp_url)
  cam_<id>_rec_raw  — local-only, MediaMTX pulling the RECORDING profile
                       straight from the camera (rec_rtsp_url, or rtsp_url
                       if the camera only has one profile configured)
  cam_<id>_third    — local-only passthrough of the camera's third profile
                       (only created if third_rtsp_url is set)
  cam_<id>          — final, watermarked, what the frontend/WebRTC/HLS use
    WebRTC URL:  http://localhost:8889/cam_<id>/whep   (browser)
    RTSP URL:    rtsp://localhost:8554/cam_<id>          (VLC / ffplay)
    HLS URL:     http://localhost:8888/cam_<id>/index.m3u8
  cam_<id>_third WebRTC URL: http://localhost:8889/cam_<id>_third/whep
"""
import os, sys, time, logging, requests, psycopg2, psycopg2.extras
from urllib.parse import urlparse, urlunparse

# ── Config ─────────────────────────────────────────────────────────────────────
MEDIAMTX_API    = os.environ.get("MEDIAMTX_API",    "http://localhost:9997")
DB_HOST         = os.environ.get("DB_HOST",         "localhost")
DB_PORT         = int(os.environ.get("DB_PORT",     "5432"))
DB_NAME         = os.environ.get("DB_NAME",         "mnvr")
DB_USER         = os.environ.get("DB_USER",         "mnvr")
DB_PASSWORD     = os.environ.get("DB_PASSWORD",     "mnvr")
SYNC_INTERVAL   = int(os.environ.get("SYNC_INTERVAL_SECS", "15"))
PATH_PREFIX     = os.environ.get("PATH_PREFIX",     "cam_")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [MTX-SYNC] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("sync")

# ── DB ──────────────────────────────────────────────────────────────────────────
def get_db():
    for attempt in range(30):
        try:
            conn = psycopg2.connect(
                host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
                user=DB_USER, password=DB_PASSWORD,
                connect_timeout=5,
            )
            return conn
        except Exception as e:
            log.warning(f"DB connect attempt {attempt+1}/30: {e}")
            time.sleep(5)
    raise RuntimeError("Cannot connect to PostgreSQL")

# ── MediaMTX API ───────────────────────────────────────────────────────────────
def mtx_get(path: str) -> dict | None:
    try:
        r = requests.get(f"{MEDIAMTX_API}{path}", timeout=5)
        return r.json() if r.ok else None
    except Exception as e:
        log.debug(f"mtx_get {path}: {e}")
        return None

def mtx_add_path(path_name: str, rtsp_url: str) -> bool:
    """Create or update a MediaMTX path that pulls from an RTSP source."""
    payload = {
        "sourceProtocol": "tcp",
        "source": rtsp_url,
        "sourceOnDemand": False,
        "maxReaders": 64,
        "fallback": "",
        "record": False,
    }
    try:
        # Try add first; if exists, update
        r = requests.post(f"{MEDIAMTX_API}/v3/config/paths/add/{path_name}",
                          json=payload, timeout=5)
        if r.status_code in (200, 201):
            log.info(f"[MTX] Added path /{path_name} → {rtsp_url.split('@')[-1]}")
            return True
        # This MediaMTX build reports a duplicate path as 400 with
        # {"error":"path already exists"} rather than 409 — check the body,
        # not just the status code, before falling back to patch.
        already_exists = (
            r.status_code == 409
            or (r.status_code == 400 and "already exists" in r.text.lower())
        )
        if already_exists:
            r2 = requests.patch(f"{MEDIAMTX_API}/v3/config/paths/patch/{path_name}",
                                json=payload, timeout=5)
            if r2.ok:
                log.debug(f"[MTX] Patched path /{path_name}")
                return True
        log.warning(f"[MTX] add/patch failed {r.status_code}: {r.text[:120]}")
        return False
    except Exception as e:
        log.warning(f"[MTX] add_path error: {e}")
        return False

def mtx_remove_path(path_name: str) -> bool:
    try:
        r = requests.delete(f"{MEDIAMTX_API}/v3/config/paths/delete/{path_name}", timeout=5)
        if r.ok:
            log.info(f"[MTX] Removed path /{path_name}")
        return r.ok
    except Exception as e:
        log.debug(f"[MTX] remove_path {path_name}: {e}")
        return False

def mtx_list_paths() -> set[str]:
    data = mtx_get("/v3/config/paths/list")
    if not data:
        return set()
    return {item.get("name","") for item in data.get("items", []) if item.get("name","").startswith(PATH_PREFIX)}

def log_unready_paths(wanted_names: set[str]):
    """Config add/patch returning 200 only means MediaMTX accepted the
    config — it says nothing about whether MediaMTX can actually reach or
    authenticate to the camera. Poll the RUNTIME path list (/v3/paths/list,
    not /v3/config/paths/list) and log MediaMTX's own lastError for any
    managed path that isn't ready, so an auth failure, refused connection,
    timeout, etc. shows up here immediately instead of only being visible
    via a manual curl against MediaMTX while live view/recording are both
    silently down."""
    data = mtx_get("/v3/paths/list")
    if not data:
        return
    by_name = {item.get("name", ""): item for item in data.get("items", [])}
    for name in sorted(wanted_names):
        item = by_name.get(name)
        if item is None:
            log.warning(f"[MTX] {name}: not in runtime path list yet (still starting?)")
            continue
        if not item.get("ready"):
            err = item.get("lastError") or "(no error reported yet)"
            log.warning(f"[MTX] {name}: NOT READY — {err}")


def wait_for_mediamtx():
    log.info(f"Waiting for MediaMTX API at {MEDIAMTX_API} ...")
    for i in range(120):
        try:
            r = requests.get(f"{MEDIAMTX_API}/v3/paths/list", timeout=3)
            if r.ok:
                log.info("✓ MediaMTX API ready")
                return
        except Exception:
            pass
        if i % 6 == 0 and i > 0:
            log.info(f"  ...still waiting ({i*2}s)")
        time.sleep(2)
    log.error("MediaMTX API not responding after 240s — continuing anyway")


def build_rtsp_url_with_creds(rtsp_url: str, user: str | None, passwd: str | None) -> str:
    """Same percent-encoding approach as stream_manager.py's build_authed_url
    — never raw string concatenation, that's what caused the credential-
    doubling bug for passwords containing '@' fixed earlier in this project."""
    if not user or not passwd:
        return rtsp_url
    from urllib.parse import quote
    p = urlparse(rtsp_url)
    if p.username:
        return rtsp_url
    netloc = f"{quote(user, safe='')}:{quote(passwd, safe='')}@{p.hostname}"
    if p.port:
        netloc += f":{p.port}"
    return urlunparse((p.scheme, netloc, p.path, p.params, p.query, p.fragment))


def fetch_active_cameras_full(conn):
    """Like fetch_active_cameras() but also pulls rec_rtsp_url/third_rtsp_url
    and the cameras_config_details-joined credentials — same query shape as
    stream_manager.py's fetch_active_cameras(), kept in sync deliberately.

    NOTE: rtsp_password intentionally does NOT fall back to c.password_hash.
    That column is a login hash (bcrypt/etc.), not a usable RTSP password —
    handing it to MediaMTX as a real password causes every RTSP pull for
    that camera to fail auth silently (no exception here, no error in this
    script's own logs — the failure only shows up as sourceReady=false /
    "401 Unauthorized" deep in MediaMTX's own path status). Since both
    cam_<id>_raw and cam_<id>_rec_raw are built from the same credentials,
    that one bad fallback is enough to kill live view AND recording for a
    camera at the same time. Better to pull with no credentials (which
    fails loudly and obviously) than with a wrong one that fails silently.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT c.camera_id, c.camera_name, c.rtsp_url, c.rec_rtsp_url,
                   c.third_rtsp_url,
                   cd.rtsp_username,
                   cd.rtsp_password
            FROM cameras c
            LEFT JOIN cameras_config_details cd
                   ON host(cd.ip_address) = c.ip_address
            WHERE c.status = 'ACTIVE'
              AND c.rtsp_url IS NOT NULL AND c.rtsp_url != ''
            ORDER BY c.camera_id
        """)
        rows = cur.fetchall()
        for row in rows:
            if not row["rtsp_username"] or not row["rtsp_password"]:
                log.warning(
                    f"[DB] camera {row['camera_id']} ({row['camera_name']}) has no "
                    f"matching cameras_config_details row (join on host(ip_address) "
                    f"found nothing) — pulling with NO credentials. If this camera "
                    f"needs auth, its _raw/_rec_raw MediaMTX paths will fail to "
                    f"connect until cameras_config_details.ip_address is fixed to "
                    f"match cameras.ip_address for this camera."
                )
        return rows


# ── Main sync loop ─────────────────────────────────────────────────────────────
def sync_once(conn):
    cameras = fetch_active_cameras_full(conn)

    # MediaMTX pulls directly from each camera's LIVE profile (rtsp_url)
    # into a "_raw" path, and independently from the RECORDING profile
    # (rec_rtsp_url, falling back to rtsp_url for a single-profile camera)
    # into a "_rec_raw" path — using MediaMTX's OWN mature RTSP client and
    # reconnect logic rather than a hand-rolled one, for both. This is why
    # only MediaMTX ever opens RTSP sessions to a given camera (two of its
    # own, one per profile) rather than several different tools each
    # opening their own — this fleet's firmware appears to enforce a
    # concurrent-session cap, and it's specifically *different* tools
    # racing each other for that budget that caused "one purpose connects
    # fine, the other gets refused" — not the number of sessions itself.
    # stream_manager.py then only ever touches these two local, already-
    # stable paths — it never opens its own connection to a physical
    # camera at all anymore.
    #
    # Cameras that also expose a third ONVIF profile (third_rtsp_url —
    # typically a low-res analytics/mobile stream) get a third, independent
    # MediaMTX path "_third" pulling straight from that profile. It's a
    # plain passthrough (no watermark stage — stream_manager.py never
    # touches it), published at cam_<id>_third for anything that wants the
    # lighter-weight feed directly (WebRTC: /cam_<id>_third/whep).
    wanted: dict[str, str] = {}
    wanted_rec: dict[str, str] = {}
    wanted_third: dict[str, str] = {}
    for cam in cameras:
        raw_path = f"{PATH_PREFIX}{cam['camera_id']}_raw"
        wanted[raw_path] = build_rtsp_url_with_creds(
            cam["rtsp_url"],
            cam["rtsp_username"], cam["rtsp_password"])

        rec_raw_path = f"{PATH_PREFIX}{cam['camera_id']}_rec_raw"
        wanted_rec[rec_raw_path] = build_rtsp_url_with_creds(
            cam["rec_rtsp_url"] or cam["rtsp_url"],
            cam["rtsp_username"], cam["rtsp_password"])

        if cam["third_rtsp_url"]:
            third_path = f"{PATH_PREFIX}{cam['camera_id']}_third"
            wanted_third[third_path] = build_rtsp_url_with_creds(
                cam["third_rtsp_url"],
                cam["rtsp_username"], cam["rtsp_password"])

    existing = mtx_list_paths()
    existing_raw = {p for p in existing if p.endswith("_raw") and not p.endswith("_rec_raw")}
    existing_rec_raw = {p for p in existing if p.endswith("_rec_raw")}
    existing_third = {p for p in existing if p.endswith("_third")}
    for path_name, rtsp_url in wanted.items():
        mtx_add_path(path_name, rtsp_url)
    for path_name, rtsp_url in wanted_rec.items():
        mtx_add_path(path_name, rtsp_url)
    for path_name, rtsp_url in wanted_third.items():
        mtx_add_path(path_name, rtsp_url)
    for path_name in existing_raw - set(wanted.keys()):
        mtx_remove_path(path_name)
    for path_name in existing_rec_raw - set(wanted_rec.keys()):
        mtx_remove_path(path_name)
    for path_name in existing_third - set(wanted_third.keys()):
        mtx_remove_path(path_name)

    if cameras:
        log.info(f"Sync: {len(cameras)} active camera(s) — "
                 f"{len(wanted)} live raw path(s), "
                 f"{len(wanted_rec)} recording raw path(s), "
                 f"{len(wanted_third)} third-stream path(s) managed in MediaMTX")
        log_unready_paths(set(wanted) | set(wanted_rec) | set(wanted_third))
    else:
        log.warning("No active cameras with RTSP URLs found in DB")

def main():
    log.info("=" * 60)
    log.info("  MediaMTX Sync — Railway mNVR")
    log.info(f"  MediaMTX : {MEDIAMTX_API}")
    log.info(f"  DB       : {DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME}")
    log.info(f"  Interval : {SYNC_INTERVAL}s")
    log.info("=" * 60)

    wait_for_mediamtx()

    conn = get_db()
    log.info("✓ Connected to PostgreSQL")

    while True:
        try:
            conn.poll()         # keep-alive / reconnect if needed
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            conn = get_db()

        try:
            sync_once(conn)
        except Exception as e:
            log.error(f"sync_once error: {e}")

        time.sleep(SYNC_INTERVAL)

if __name__ == "__main__":
    main()