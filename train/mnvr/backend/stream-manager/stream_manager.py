#!/usr/bin/env python3
"""
stream_manager.py — ffmpeg-based live view + recording, working from a
camera feed that MediaMTX itself pulls (never from the camera directly).

WHY THIS EXISTS (context for future maintainers):
Testing (packet captures, side-by-side comparisons) proved that
GStreamer's rtspsrc has real reliability problems against this specific
camera fleet — inconsistent SETUP failures, and in one proven case
(packet-captured) a camera that accepted PLAY with 200 OK and then sent
zero RTP data. ffmpeg's RTSP client, tested side by side against the
exact same URLs and credentials, worked cleanly every single time.
Rather than keep fighting rtspsrc, this replaces mnvrd's own camera
connections with ffmpeg subprocesses — but see the architecture history
below for how "which process actually talks to the camera" evolved.

ARCHITECTURE (2 stages per camera, this process — plus MediaMTX itself):
  0. MediaMTX pulls directly from each camera TWICE, independently
     (mediamtx-sync.py adds cam_<id>_raw from rtsp_url — the live
     profile — and cam_<id>_rec_raw from rec_rtsp_url — the recording
     profile, which can be a genuinely different stream/profile on the
     camera than the live one, e.g. a camera exposing separate
     "unicaststream/1" and "unicaststream/4" endpoints). This is the
     ONLY thing that ever opens an RTSP connection to a physical camera,
     using MediaMTX's own mature, purpose-built RTSP client and
     reconnect logic rather than anything hand-rolled in this file.
  1. WATERMARK (run_watermark): reads cam_<id>_raw (the live profile) —
     a local, already-stable MediaMTX path, never the camera itself —
     burns in the date/time + location + live GPS speed watermark,
     encodes (see "v6" below for current codec), republishes to
     cam_<id>: the path the frontend's WebRTC/HLS players actually
     watch. This path is tuned for live monitoring, not archival
     efficiency.
  2. ARCHIVE (run_archive_encode): reads cam_<id>_rec_raw (the recording
     profile — independent from the live one, see step 0) and writes it
     to segmented MP4 files with the SAME watermark burned in as the
     live path (see "v5" in the architecture history below for why this
     changed from a pure stream copy). GOP is derived from that
     profile's own current resolution/fps — see _probe_source_config()
     — so a heterogeneous fleet with different cameras/profiles on
     different frame rates still gets a sensible, matching encode with
     zero special-casing needed here. Bitrate, as of v7, targets a
     fixed ~1000-1200kbps corridor instead of mirroring the source
     (see ARCHIVE_TARGET_BITRATE_KBPS below) — a predictable recording
     size/quality regardless of what a given camera's own profile
     happens to be configured to.

ARCHITECTURE HISTORY (why it took several tries to land here):
  - v1: two totally separate ffmpeg processes, each opening its OWN
    connection to the camera (LIVE from rtsp_url via -c copy with no
    watermark, REC from rec_rtsp_url via transcode with one). This
    fleet's firmware appears to cap concurrent RTSP sessions per camera,
    so these two connections regularly fought over that budget — the
    repeated "REC connects fine, LIVE gets Connection refused" pattern.
  - v2: merged into ONE ffmpeg process reading the camera once and
    fanning out to two encoded outputs directly. Fixed the connection
    contention, but ffmpeg opens every output's header during startup
    before processing any frames — so a transient failure on the LIVE-
    publish side made the WHOLE process fail to start, taking a
    perfectly fine recording down with it too.
  - v3: split into ingest (the one real camera connection, done by THIS
    script) + two independent local relays. Fixed the fault-isolation
    problem, but the ingest process was still a hand-rolled ffmpeg
    subprocess doing the actual camera reconnect logic — which is
    exactly the kind of thing that kept surfacing new edge cases
    (dump_extra's own H.264 parser crashing one relay, 404s from
    relays starting before ingest had published, etc).
  - v4: stopped hand-rolling the camera connection entirely and let
    MediaMTX do it — that's what it's actually built and tested for.
    This script only ever touches already-stable local MediaMTX paths,
    never a physical camera. Archive was a pure `-c copy` for pixel-
    perfect fidelity to whatever the camera was configured to send, at
    the cost of no watermark on the stored file (only the live path had
    one, since it had to re-encode anyway for WebRTC compatibility).
  - v5: stored recordings now carry the same date/time + location +
    speed watermark as the live view. This trades away the v4 archive's
    byte-for-byte fidelity in exchange for the recording itself being
    self-describing evidence (when/where/how fast) without depending on
    the `recordings` table's metadata columns staying attached to the
    file. Bitrate/GOP for archive are still derived per-camera from
    _probe_source_config() rather than a single fixed constant, so this
    isn't a return to "one setting for the whole fleet" — only the
    "never re-encode" part of v4 changed.
  - v6 (this version): two independent MediaMTX pulls per camera instead
    of one shared one — live and recording can now genuinely be
    different profiles/streams on the same physical camera (the
    `rtsp_url`/`rec_rtsp_url` DB columns always supported this in
    principle; this is what actually wires it through end to end). Both
    encodes switched from H.264 to H.265/HEVC (LIVE_VIDEO_CODEC /
    ARCHIVE_VIDEO_CODEC, both env-overridable) — roughly half the
    bitrate of H.264 at equivalent quality. Archive additionally moved
    from an average-bitrate target to a CRF-driven quality target
    (ARCHIVE_CRF), specifically so the archive encode can be tuned for
    *better* quality/compression than whatever the camera's own H.265
    profile already produces, not just matching it. The one real risk
    this version accepts: WebRTC/WHEP browser support for HEVC is not as
    universal as it is for H.264 baseline — if live view goes blank in a
    browser that won't negotiate HEVC, LIVE_VIDEO_CODEC=libx264 reverts
    just that stage without touching archive.
  - v7 (this version): two fixes.
    (1) Only ONE camera's live view was ever actually staying connected
    at a time, and which one flipped between restarts with no config
    change — root cause was libx264/libx265 each grabbing every CPU
    thread on the host for their own internal thread pool, PER PROCESS,
    with no cap. 2*N software encodes (WATERMARK + ARCHIVE-ENCODE per
    camera) all fighting over the whole machine meant whichever process
    the scheduler favored kept up in real time and every other camera's
    encode starved and timed out client-side. Fixed by explicitly
    capping each process's own thread count (LIVE_ENCODE_THREADS /
    ARCHIVE_ENCODE_THREADS, see _thread_limit_args()) so the CPU is
    actually shared fairly across every camera instead of one process
    being able to claim it all.
    (2) ARCHIVE moved from an open-ended CRF quality target to an
    average-bitrate corridor (ARCHIVE_TARGET_BITRATE_KBPS/_MAX_/_MIN_,
    see _archive_rate_control_args()) so recordings land in a
    predictable ~1000-1200kbps band instead of wherever a given scene's
    CRF-driven quality target happened to put it — still scene-adaptive
    (more bits to motion, fewer to static) since that's inherent to how
    average-bitrate rate control itself allocates bits, not something
    CRF uniquely provided. ARCHIVE_RATE_MODE=crf restores the old
    open-ended behavior for anyone who prefers it.

Each stage gets its own supervisor thread running a restart-with-backoff
loop around its ffmpeg subprocess — matching the same 5s/10s/20s/30s-cap
backoff pattern used elsewhere in this project — plus a separate
recording-indexer thread (see index_recordings() below), for 3 threads
per camera, plus one shared GPS-overlay writer thread for the whole
process (GPS is a single train-wide unit, not per-camera — see
gps_overlay_writer() below).

This is the only process that opens camera RTSP connections. (The earlier
GStreamer-based C daemon, mnvrd, and the Python recorder have been removed
from the repository.)
"""
import os
import sys
import re
import json
import time
import shlex
import signal
import logging
import subprocess
import threading
from collections import deque
from pathlib import Path
from datetime import datetime, timedelta

import psycopg2
import psycopg2.extras
import requests

# ── Config (env-overridable, same pattern as mediamtx-sync.py) ─────────────
DB_HOST     = os.environ.get("DB_HOST", "localhost")
DB_PORT     = int(os.environ.get("DB_PORT", "5432"))
DB_NAME     = os.environ.get("DB_NAME", "mnvr")
DB_USER     = os.environ.get("DB_USER", "mnvr")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "mnvr")

MEDIAMTX_RTSP_HOST = os.environ.get("MEDIAMTX_RTSP_HOST", "127.0.0.1")
MEDIAMTX_RTSP_PORT = os.environ.get("MEDIAMTX_RTSP_PORT", "8554")
MEDIAMTX_API = os.environ.get("MEDIAMTX_API", "http://localhost:9997")

RECORDINGS_BASE = os.environ.get("RECORDINGS_PATH", "/storage/recordings")
# SEGMENT_SECONDS (env) is now only the FIRST-BOOT fallback, used before
# the settings-refresher thread below has done its first read of
# recording_settings.segment_duration_sec — see _current_segment_seconds()
# and settings_refresher(). The UI's Settings page writes to that DB
# column (PUT /api/settings/recording); this process polls it and applies
# it live, instead of the old behaviour of reading SEGMENT_SECONDS from
# the environment once at process start and never again, which is why
# changing the value in the UI never actually changed anything on disk.
SEGMENT_SECONDS = int(os.environ.get("SEGMENT_SECONDS", "120"))

# LIVE codec: H.265/HEVC, per requirement — end-to-end H.265 for both live
# and recording. As of Chrome 136 (May 2025) and Safari, HEVC over
# WebRTC/WHEP is supported by default; Firefox has stated it will not
# support it, and Edge (despite being Chromium-based) has not enabled it
# and has no announced plan to. Practically: any viewer on Chrome or
# Safari gets live HEVC over WebRTC directly; a viewer on Firefox/Edge (or
# a Windows machine without hardware HEVC decode — ~75% of Windows
# devices have it, not universal) will have their WebRTC negotiation
# silently fail to produce a track, and CameraGrid.tsx's 6s connect-
# timeout falls them back to HLS — which has much broader HEVC decode
# support (Chrome 107+, Firefox 134+, Edge, Safari via MSE) since it's
# just decode, not the newer WebRTC-specific negotiation feature. So this
# default is viable AS LONG AS that HLS fallback stays in place; pulling
# it back out would reintroduce the original blank-live-view bug for any
# non-Chrome/Safari viewer. Confirm your actual viewing devices/browsers
# before relying on this — override with LIVE_VIDEO_CODEC=libx264 (or
# hevc_qsv if the encoding host has Intel Quick Sync — see deployment
# notes on why software libx265 alone won't keep up with many concurrent
# streams on a low-core-count CPU) if needed.
LIVE_VIDEO_CODEC = os.environ.get("LIVE_VIDEO_CODEC", "libx265")
ARCHIVE_VIDEO_CODEC = os.environ.get("ARCHIVE_VIDEO_CODEC", "libx265")
# Archive quality: CRF-driven (rate-distortion optimized), not a flat
# average-bitrate target — this is what "compress it further with greater
# quality" than the camera's own H.265 output actually means in encoder
# terms. Lower = higher quality/larger files; 18-20 is visually
# near-transparent for x265, 23 is x265's own default. maxrate/bufsize
# below still cap it so a very high-motion scene can't blow the storage
# budget unbounded.
ARCHIVE_CRF = os.environ.get("ARCHIVE_CRF", "20")
# ── Archive bitrate corridor (v7) ───────────────────────────────────────
# Recordings should land consistently in a predictable ~1000-1200kbps
# band — enough bits that a busy/motion-heavy scene still looks clean,
# few enough that a mostly-static camera doesn't waste storage — rather
# than either (a) open CRF's "however many bits this scene's quality
# target happens to need", which can run well over 1200k for a detailed
# scene or well under 1000k for a static one with no ceiling/floor at
# all, or (b) one fixed bitrate applied identically regardless of scene
# content. This replaces the old CRF-driven archive encode: see
# _archive_rate_control_args() below, which now rate-controls off this
# corridor instead of ARCHIVE_CRF (that env var is still read, in case
# ARCHIVE_RATE_MODE=crf opts back into the old open-CRF behavior, but is
# no longer the default).
#
# ARCHIVE_TARGET_BITRATE_KBPS is the encoder's AVERAGE bitrate target.
# Average-bitrate rate control is still scene-adaptive on its own —
# x265/NVENC/QSV all allocate MORE bits to high-motion/high-complexity
# frames and FEWER to static ones to hit that average, the same
# more-for-motion/less-for-still behavior CRF gave, just anchored to a
# predictable overall number instead of an open-ended one.
#
# ARCHIVE_MAX_BITRATE_KBPS is the hard ceiling a motion burst can spike
# to (enforced via -maxrate/-bufsize VBV capping) — a real ceiling the
# encoder cannot exceed frame-to-frame.
#
# ARCHIVE_MIN_BITRATE_KBPS is the floor for how far a long static stretch
# is allowed to drop. IMPORTANT caveat: x265/NVENC/QSV rate control has
# no literal hard floor the way -maxrate is a hard ceiling — a genuinely
# static, unchanging scene can still legitimately dip below it for a few
# seconds (that's the codec correctly declining to spend bits
# re-encoding an image that isn't changing, not a bug, and forcing a true
# floor would mean padding the file with bits that improve nothing).
# ARCHIVE_MIN_BITRATE_KBPS is honored as a qpmax clamp (see
# _archive_rate_control_args) so that dip stays shallow and short instead
# of the encoder being allowed to coast all the way down to a token
# bitrate the way open CRF could.
ARCHIVE_TARGET_BITRATE_KBPS = int(os.environ.get("ARCHIVE_TARGET_BITRATE_KBPS", "1100"))
ARCHIVE_MAX_BITRATE_KBPS = int(os.environ.get("ARCHIVE_MAX_BITRATE_KBPS", "1200"))
ARCHIVE_MIN_BITRATE_KBPS = int(os.environ.get("ARCHIVE_MIN_BITRATE_KBPS", "1000"))
# "crf" opts back into the old open-ended, ARCHIVE_CRF-driven behavior
# (no corridor enforcement) for anyone who preferred that trade-off.
ARCHIVE_RATE_MODE = os.environ.get("ARCHIVE_RATE_MODE", "corridor")

# ── Per-process CPU thread cap (fixes "only one camera's live view ever
# actually works, and which one flips between runs with no config
# change") ───────────────────────────────────────────────────────────────
# Root cause: libx264/libx265 grab ALL available CPU threads for their
# own internal frame-level thread pool by default, per PROCESS, unless
# told otherwise. With N cameras each running TWO concurrent software
# encodes (WATERMARK live + ARCHIVE-ENCODE), that's up to 2*N ffmpeg
# processes all trying to claim the *entire* host's core count for
# themselves at once. Whichever process's encoder thread pool the OS
# scheduler happens to favor effectively starves every other process of
# CPU time — that process keeps up in real time (its WebRTC/HLS output
# stays live), every other camera's encode falls behind, stalls, and its
# WHEP connection times out client-side. That matches the reported
# symptom exactly: only ONE camera's live view is ever actually keeping
# up, and WHICH camera "wins" is scheduler luck, not tied to any
# per-camera setting — which is exactly why it can flip from "all
# cameras except one" to "only that one" between restarts with zero
# config changes. Explicitly capping each process's own thread count is
# what makes the CPU get shared fairly across every camera's encode
# instead of one process being able to claim all of it.
LIVE_ENCODE_THREADS = int(os.environ.get("LIVE_ENCODE_THREADS", "2"))
ARCHIVE_ENCODE_THREADS = int(os.environ.get("ARCHIVE_ENCODE_THREADS", "2"))

CAMERA_REFRESH_INTERVAL = 30  # seconds between checking the DB for camera changes
SETTINGS_REFRESH_INTERVAL = 15  # seconds between checking recording_settings for changes
MIN_SEGMENT_SECONDS = 5      # sanity clamp — guards against a bad/blank DB value
MAX_SEGMENT_SECONDS = 3600

# ── Retention cleanup (recordings + logs) ───────────────────────────────────
# recording_retention_days and log_retention_days both live on the same
# single-row recording_settings table segment_duration_sec already comes
# from (see fetch_recording_settings()/settings_refresher() above) — the
# UI's Settings page (PUT /api/settings/recording) writes both, so editing
# either there takes effect within one RETENTION_CHECK_INTERVAL, no restart
# needed. LOGS_DIR defaults to the "logs" folder next to this script
# (same path start.sh's $LOG_DIR points every service's own log at).
LOGS_DIR = Path(os.environ.get(
    "LOGS_DIR", str(Path(__file__).resolve().parent / "logs")))
RETENTION_CHECK_INTERVAL = int(os.environ.get("RETENTION_CHECK_INTERVAL_SECS", "3600"))
DEFAULT_RECORDING_RETENTION_DAYS = int(os.environ.get("RECORDING_RETENTION_DAYS", "30"))
DEFAULT_LOG_RETENTION_DAYS = int(os.environ.get("LOG_RETENTION_DAYS", "30"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [STREAM-MGR] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("stream_manager")

_shutdown = threading.Event()


def _handle_signal(signum, frame):
    log.info("Shutdown signal received, stopping all camera threads...")
    _shutdown.set()


signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT, _handle_signal)


# ── DB ───────────────────────────────────────────────────────────────────
def get_db():
    for attempt in range(30):
        try:
            return psycopg2.connect(
                host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
                user=DB_USER, password=DB_PASSWORD,
            )
        except Exception as e:
            log.warning(f"DB connect failed ({e}), retrying in 2s...")
            time.sleep(2)
    raise RuntimeError("Could not connect to PostgreSQL after 60s")


def fetch_recording_settings(conn) -> dict:
    """Reads the single-row recording_settings table that the UI's
    Settings page (PUT /api/settings/recording) writes to. Only
    segment_duration_sec is consumed today, but this returns the whole
    row so it's a one-line change to pick up more fields (retention,
    audio, watermark toggle) the same way later."""
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("SELECT * FROM recording_settings ORDER BY id LIMIT 1")
        row = cur.fetchone()
        return dict(row) if row else {}


# ── Live segment duration: DB-driven, not a fixed env snapshot ─────────────
# segment_duration_sec is read from recording_settings by settings_refresher()
# below and cached here. run_archive_encode()'s build_cmd() calls
# current_segment_seconds() fresh on every (re)start (see _run_supervised's
# `cmd() if callable(cmd) else cmd`), and settings_refresher() also force-
# restarts every camera's ARCHIVE stage the moment the DB value actually
# changes, via _ARCHIVE_RESTART — so a segment-duration edit in the UI takes
# effect within one SETTINGS_REFRESH_INTERVAL, without waiting for the next
# crash/backoff cycle.
_settings_lock = threading.Lock()
_current_segment_seconds_val = SEGMENT_SECONDS
_ARCHIVE_RESTART: dict[int, threading.Event] = {}

# ── WATERMARK stall watchdog ────────────────────────────────────────────────
# Seen in production: a WATERMARK ffmpeg process can survive indefinitely —
# never crash, never exit — while never actually completing the RTSP
# publish handshake into MediaMTX (observed cause: an audio timestamp
# jitter in that camera's live profile, logged as a "Non-monotonic DTS"
# warning storm in ffmpeg's stderr). _run_supervised()'s normal
# retry-with-backoff only ever triggers when the process actually exits,
# so a process wedged like this runs forever and the affected camera's
# live tile stays permanently blank until someone manually kills it.
# stall_watchdog() (below fetch_active_cameras()) is a second, independent
# check: if a camera's WATERMARK stage has been running longer than
# WATERMARK_STALL_GRACE_SECS and MediaMTX still doesn't show cam_<id> as
# ready, it signals a restart through the SAME clean-shutdown
# restart_event mechanism settings_refresher() already uses for
# segment-duration changes — _run_supervised() SIGTERMs the stuck process
# and starts a fresh one, exactly what fixed this manually in production.
WATERMARK_STALL_GRACE_SECS = int(os.environ.get("WATERMARK_STALL_GRACE_SECS", "45"))
WATCHDOG_INTERVAL = int(os.environ.get("WATCHDOG_INTERVAL_SECS", "15"))
_WATERMARK_RESTART: dict[int, threading.Event] = {}
_watermark_start_time: dict[int, float] = {}
_watermark_lock = threading.Lock()


def current_segment_seconds() -> int:
    with _settings_lock:
        return _current_segment_seconds_val


def settings_refresher():
    """Polls recording_settings every SETTINGS_REFRESH_INTERVAL and, when
    segment_duration_sec has actually changed, updates the shared value
    and signals every running ARCHIVE stage to restart immediately so the
    new duration applies to the very next segment rather than whenever
    that camera's ffmpeg next happens to crash/restart on its own."""
    global _current_segment_seconds_val
    conn = get_db()
    while not _shutdown.is_set():
        try:
            settings = fetch_recording_settings(conn)
            raw = settings.get("segment_duration_sec")
            if raw is not None:
                new_val = int(raw)
                new_val = max(MIN_SEGMENT_SECONDS, min(new_val, MAX_SEGMENT_SECONDS))
                with _settings_lock:
                    changed = new_val != _current_segment_seconds_val
                    old_val = _current_segment_seconds_val
                    _current_segment_seconds_val = new_val
                if changed:
                    log.info(f"segment_duration_sec changed {old_val}s -> {new_val}s "
                              f"(from recording_settings); restarting active ARCHIVE stages")
                    for ev in list(_ARCHIVE_RESTART.values()):
                        ev.set()
        except Exception as e:
            log.warning(f"settings_refresher error ({e}), reconnecting to DB...")
            try:
                conn.close()
            except Exception:
                pass
            conn = get_db()
        _shutdown.wait(SETTINGS_REFRESH_INTERVAL)


def _delete_old_recordings(conn, retention_days: int):
    """FIFO cleanup: any .mp4 under RECORDINGS_BASE whose modification time
    is older than retention_days gets deleted, oldest-first, and its row
    (if any) removed from the `recordings` table so the VideoPlayer/UI
    recordings list stops listing a file that no longer exists on disk.
    RECORDINGS_BASE is a flat directory (see CHANGES_SUMMARY.md's history
    on rec_output_dir), so this is a single non-recursive scan — same
    directory index_recordings() already reads."""
    cutoff = time.time() - retention_days * 86400
    base = Path(RECORDINGS_BASE)
    if not base.is_dir():
        return
    try:
        # Oldest-first: every file older than cutoff gets removed in this
        # same pass regardless of order, but sorting oldest-first keeps
        # this genuinely FIFO if the process is ever interrupted mid-run
        # (a partial pass still frees the oldest data first).
        candidates = sorted(base.glob("*.mp4"), key=lambda p: p.stat().st_mtime)
    except Exception as e:
        log.warning(f"[RETENTION] could not list {base}: {e}")
        return
    deleted = 0
    freed_bytes = 0
    for f in candidates:
        try:
            st = f.stat()
        except FileNotFoundError:
            continue
        if st.st_mtime >= cutoff:
            continue
        try:
            size = st.st_size
            f.unlink()
            deleted += 1
            freed_bytes += size
        except Exception as e:
            log.warning(f"[RETENTION] failed to delete {f}: {e}")
            continue
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM recordings WHERE file_path = %s", (str(f),))
            conn.commit()
        except Exception as e:
            log.warning(f"[RETENTION] deleted {f.name} but DB row cleanup failed: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
    if deleted:
        log.info(f"[RETENTION] recordings: deleted {deleted} file(s) older than "
                 f"{retention_days}d, freed {freed_bytes / (1024**3):.2f} GB")


def _delete_old_logs(retention_days: int):
    """Deletes files directly under LOGS_DIR whose modification time is
    older than retention_days. Actively-written logs (stream_manager.log,
    mtxsync.log, nvr.log, etc.) get their mtime bumped every time something
    is appended to them, so a live log never ages out on its own — this
    only ever removes genuinely stale/historical log files, never one a
    service is currently writing to."""
    cutoff = time.time() - retention_days * 86400
    if not LOGS_DIR.is_dir():
        return
    deleted = 0
    for f in LOGS_DIR.iterdir():
        if not f.is_file():
            continue
        try:
            st = f.stat()
        except FileNotFoundError:
            continue
        if st.st_mtime >= cutoff:
            continue
        try:
            f.unlink()
            deleted += 1
        except Exception as e:
            log.warning(f"[RETENTION] failed to delete log {f}: {e}")
    if deleted:
        log.info(f"[RETENTION] logs: deleted {deleted} file(s) older than "
                 f"{retention_days}d from {LOGS_DIR}")


def retention_cleanup():
    """Background thread: enforces recording_retention_days and
    log_retention_days from recording_settings — the same DB row/UI page
    segment_duration_sec already comes from — on a fixed interval, so
    changing either value in Settings takes effect within one
    RETENTION_CHECK_INTERVAL without a restart. Falls back to the
    RECORDING_RETENTION_DAYS/LOG_RETENTION_DAYS env defaults (30d each) if
    the DB read fails or the columns are somehow null."""
    conn = get_db()
    # Small initial delay so this doesn't compete with every camera thread
    # spinning up its ffmpeg processes right at boot.
    _shutdown.wait(30)
    while not _shutdown.is_set():
        try:
            settings = fetch_recording_settings(conn)
            rec_days = int(settings.get("recording_retention_days")
                           or DEFAULT_RECORDING_RETENTION_DAYS)
            log_days = int(settings.get("log_retention_days")
                           or DEFAULT_LOG_RETENTION_DAYS)
            _delete_old_recordings(conn, rec_days)
            _delete_old_logs(log_days)
        except Exception as e:
            log.warning(f"[RETENTION] cleanup pass failed ({e}), reconnecting to DB...")
            try:
                conn.close()
            except Exception:
                pass
            conn = get_db()
        _shutdown.wait(RETENTION_CHECK_INTERVAL)


def fetch_active_cameras(conn):
    """camera_id/name/rec_output_dir plus location_description — the
    human-readable per-camera label (e.g. "Coach S4 — front entrance")
    burned into that camera's watermark. This process never connects to
    a physical camera itself (see the module docstring), so it has no
    need for RTSP URLs or credentials at all; those live in
    mediamtx-sync.py, which is the thing that actually talks to cameras
    now."""
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT camera_id, camera_name, rec_output_dir, location_description
            FROM cameras
            WHERE status = 'ACTIVE'
              AND rtsp_url IS NOT NULL AND rtsp_url != ''
            ORDER BY camera_id
        """)
        return cur.fetchall()


# ── Backoff (matches the 5s/10s/20s/30s-cap pattern used in the C code) ────
def backoff_seconds(retry_count: int) -> int:
    return min(5 * (2 ** min(retry_count, 3)), 30)


def stall_watchdog(all_camera_ids_fn):
    """See the WATERMARK_STALL_GRACE_SECS block near the top of this file
    for the full story. Runs independently of every other supervision
    loop here — this is purely a second safety net for the one failure
    mode _run_supervised()'s crash/backoff loop structurally can't catch:
    a process that never exits at all.

    Deliberately conservative: only forces a restart once a camera's
    WATERMARK stage has been continuously running (no restart, no crash)
    for WATERMARK_STALL_GRACE_SECS AND MediaMTX still doesn't have
    cam_<id> ready. A camera that's simply offline/unreachable crash-loops
    every ~30s in the normal retry path instead (see backoff_seconds()),
    which resets _watermark_start_time on every attempt — so this never
    fires for that case, only for a process that's genuinely wedged."""
    while not _shutdown.is_set():
        _shutdown.wait(WATCHDOG_INTERVAL)
        if _shutdown.is_set():
            return
        for camera_id in list(all_camera_ids_fn()):
            with _watermark_lock:
                started = _watermark_start_time.get(camera_id)
            if started is None:
                continue
            running_for = time.monotonic() - started
            if running_for < WATERMARK_STALL_GRACE_SECS:
                continue
            if _path_ready(f"cam_{camera_id}"):
                continue
            ev = _WATERMARK_RESTART.get(camera_id)
            if ev is not None and not ev.is_set():
                log.warning(
                    f"[cam_{camera_id}] WATERMARK has been running "
                    f"{running_for:.0f}s straight but cam_{camera_id} still "
                    f"isn't ready in MediaMTX — forcing a restart "
                    f"(stall watchdog)")
                ev.set()


# ── Live status tracking, for report_health() below ─────────────────────────
# Nothing else in this project writes to camera_health. Without this, the
# table just sits there with stale or empty data forever, and the frontend's online/recording badges (which
# read the latest camera_health row via GET /api/cameras) end up
# completely disconnected from whether ffmpeg/MediaMTX are actually
# streaming — a camera can be recording live footage right now and still
# show "offline" in the UI, because nothing ever told the DB otherwise.
_status_lock = threading.Lock()
_camera_status: dict[int, dict[str, bool]] = {}


def _set_stage_alive(camera_id: int, stage_key: str, alive: bool):
    with _status_lock:
        _camera_status.setdefault(camera_id, {})[stage_key] = alive


# ── Shared supervisor loop: restart-with-backoff around one ffmpeg cmd ─────
def _drain_stderr(proc: subprocess.Popen, tail: deque) -> None:
    """Continuously reads (and discards, keeping only a bounded tail) an
    ffmpeg child's stderr as it's produced.

    THIS IS THE FIX for the intermittent garbled-frame / macroblock-
    corruption artifact seen across many cameras' live view AND
    recordings: every _run_supervised() process previously opened
    stderr=subprocess.PIPE but never read from it while the process was
    running — only after it exited. A PIPE has a small, fixed OS buffer
    (~64KB on Linux). Under `-loglevel warning`, an RTSP source with any
    recurring hiccup (packet loss, timestamp discontinuities, a corrupt
    frame from the camera's own encoder — exactly the kind of
    intermittent per-camera flakiness this whole pipeline is built
    around tolerating) logs warning lines continuously. Over an
    hours/days-long run that's easily enough to fill 64KB, and the
    instant it does, ffmpeg's own write() to stderr blocks — the process
    doesn't crash or exit (so none of the restart/backoff logic above
    ever triggers), it just stalls, and a decoder/encoder stalling
    mid-frame is exactly what produces a stuck run of garbled macroblock
    data until something eventually unblocks it. This thread's only job
    is to make sure that pipe is never left to fill: read it as fast as
    it's written, for the entire life of the process.
    """
    try:
        for line in proc.stderr:
            line = line.rstrip("\n")
            if line:
                tail.append(line)
    except (ValueError, OSError):
        pass  # stderr closed under us (process torn down) — nothing left to drain


def _run_supervised(camera_name: str, stage: str, cmd, camera_id: int | None = None,
                     stage_key: str | None = None, restart_event: threading.Event | None = None):
    """Runs `cmd` in a restart-with-backoff loop until shutdown. Shared by
    both stages (watermark/archive) so each is a genuinely independent
    process/thread — one stage crashing or backing off never blocks or
    kills the other, unlike having them share one ffmpeg invocation (see
    the module docstring's "v2" note for why that mattered).

    `cmd` may be a plain list[str] (a fixed command) or a zero-arg
    callable returning list[str]. The callable form is what lets a stage
    re-probe the camera's own live resolution/fps/bitrate on every
    (re)start — see build_cmd() in run_watermark()/run_archive_encode()
    below — rather than baking one snapshot of those settings in at
    process launch and never updating it again.

    If camera_id/stage_key are given, also updates _camera_status so
    report_health() can tell the DB (and therefore the UI) what's
    actually running right now, instead of the UI reading stale data."""
    retry_count = 0
    while not _shutdown.is_set():
        resolved_cmd = cmd() if callable(cmd) else cmd
        log.info(f"[{camera_name}] {stage} starting")
        start = time.monotonic()
        try:
            proc = subprocess.Popen(resolved_cmd, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.PIPE, text=True)
            # See _drain_stderr()'s docstring — this thread is load-bearing,
            # not cosmetic: without it, this process's own stderr pipe can
            # fill and silently stall ffmpeg mid-stream.
            stderr_tail: deque = deque(maxlen=25)
            drain_thread = threading.Thread(target=_drain_stderr, args=(proc, stderr_tail), daemon=True)
            drain_thread.start()
            marked_alive = False
            requested_restart = False
            while proc.poll() is None:
                if _shutdown.is_set():
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                    if camera_id is not None and stage_key:
                        _set_stage_alive(camera_id, stage_key, False)
                    return
                # A settings change (e.g. segment_duration_sec) wants this
                # stage restarted right now, rather than waiting for a
                # crash/backoff cycle — see settings_refresher(). Terminate
                # cleanly (SIGTERM, not kill) so ffmpeg closes the segment
                # it's mid-writing instead of leaving a corrupt/truncated one.
                if restart_event is not None and restart_event.is_set():
                    restart_event.clear()
                    requested_restart = True
                    log.info(f"[{camera_name}] {stage} restart requested (settings changed)")
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                    break
                # Only mark "alive" once it's survived a few seconds —
                # avoids a crash-loop briefly flashing "online" every retry.
                if not marked_alive and time.monotonic() - start > 3:
                    if camera_id is not None and stage_key:
                        _set_stage_alive(camera_id, stage_key, True)
                    marked_alive = True
                time.sleep(1)
            if camera_id is not None and stage_key:
                _set_stage_alive(camera_id, stage_key, False)
            drain_thread.join(timeout=2)  # give it a moment to catch the final lines on EOF
            stderr_text = " | ".join(stderr_tail)[-400:]
            elapsed = time.monotonic() - start
            if requested_restart:
                log.info(f"[{camera_name}] {stage} restarting now (ran {elapsed:.0f}s)")
                retry_count = 0
                continue  # skip backoff — this restart was intentional, not a failure
            log.warning(f"[{camera_name}] {stage} exited (code={proc.returncode}, "
                        f"ran {elapsed:.0f}s) {stderr_text.strip()!r}")
        except FileNotFoundError:
            log.error(f"ffmpeg not found on PATH — cannot start {stage}")
            return
        except Exception as e:
            log.error(f"[{camera_name}] {stage} error: {e}")
            elapsed = 0

        retry_count = 0 if elapsed >= 15 else retry_count + 1
        delay = backoff_seconds(retry_count)
        log.info(f"[{camera_name}] {stage} retrying in {delay}s")
        _shutdown.wait(delay)


# ── Camera-driven encode settings ───────────────────────────────────────────
def _probe_source_config(source_url: str, label: str) -> dict:
    """ffprobe's a local MediaMTX raw pull — never the camera itself — to
    discover what that specific profile is ACTUALLY configured to send
    right now: resolution, frame rate, and (when the source reports it)
    bitrate. Called fresh on every stage (re)start via that stage's
    build_cmd(), so a resolution/fps/bitrate change made on the camera's
    own web UI takes effect the next time that stage restarts — no fixed
    "one size fits all" constant to keep in sync by hand across a
    heterogeneous fleet.

    Takes an explicit source_url (rather than assuming a fixed path name)
    because live view and recording now read two INDEPENDENT camera
    profiles (cam_<id>_raw vs cam_<id>_rec_raw — see mediamtx-sync.py's
    module docstring for why), which can genuinely differ in resolution/
    fps/bitrate from each other on the same physical camera. `label` is
    just for the log line, so a probe failure in the logs says which
    profile it was ("live"/"recording"), not just a bare camera ID.

    Returns {} on any failure (source not ready yet, ffprobe timeout,
    malformed output, etc) — callers fall back to conservative defaults
    rather than fail the whole stage over a probe that didn't work this
    time; the retry loop in _run_supervised() simply probes again on the
    next restart."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-rtsp_transport", "tcp",
             "-analyzeduration", "5M", "-probesize", "5M",
             "-select_streams", "v:0", "-show_entries",
             "stream=width,height,r_frame_rate,bit_rate,codec_name:format=bit_rate",
             "-of", "json", source_url],
            capture_output=True, text=True, timeout=15,
        )
        if out.returncode != 0 or not out.stdout:
            return {}
        data = json.loads(out.stdout)
        streams = data.get("streams") or []
        if not streams:
            return {}
        v = streams[0]
        fps = None
        try:
            num, den = (v.get("r_frame_rate") or "0/1").split("/")
            if float(den):
                fps = float(num) / float(den)
        except Exception:
            fps = None
        # Stream-level bit_rate is frequently absent on live RTSP (no
        # container-level duration to derive it from) — fall back to the
        # format-level figure when present.
        bitrate = v.get("bit_rate") or (data.get("format") or {}).get("bit_rate")
        bitrate = int(bitrate) if bitrate else None
        return {
            "width": v.get("width"), "height": v.get("height"),
            "fps": fps, "bitrate": bitrate, "codec": v.get("codec_name"),
        }
    except Exception as e:
        log.warning(f"[{label}] source probe failed: {e}")
        return {}


def _is_hevc(codec: str) -> bool:
    return (codec or "").lower() in ("hevc", "h265", "libx265", "hevc_qsv", "hevc_nvenc")


def _target_bitrate(cfg: dict, target_codec: str = "libx265") -> str:
    """Prefer the camera's own configured bitrate (mirrored straight from
    the source stream) so a camera set to, say, 4Mbps on its own web UI
    gets an encoded output that actually matches it — instead of every
    camera in the fleet being flattened to the same fixed value
    regardless of resolution or how it's configured.

    Bitrate math is relative to what the OUTPUT codec needs, not just
    what the source reports — HEVC gets roughly the same perceptual
    quality as H.264 at about half the bitrate, so: source H.264 ->
    target HEVC halves it, source HEVC -> target H.264 doubles it, and
    same-family conversions mirror the source as-is. Falls back to a
    resolution-based tier (sized for HEVC output; doubled for H.264
    targets) when the source doesn't report bit_rate, which live RTSP
    frequently doesn't."""
    target_is_hevc = _is_hevc(target_codec)
    src_bps = cfg.get("bitrate")
    if src_bps and src_bps > 100_000:  # sanity floor — ignore obviously bogus values
        src_is_hevc = _is_hevc(cfg.get("codec"))
        if src_is_hevc == target_is_hevc:
            target_bps = src_bps
        elif target_is_hevc:  # H.264 source -> HEVC target
            target_bps = src_bps // 2
        else:  # HEVC source -> H.264 target
            target_bps = src_bps * 2
        return f"{min(target_bps // 1000, 6000)}k"
    height = cfg.get("height") or 0
    if height >= 2160:
        tier = 3072
    elif height >= 1080:
        tier = 2048
    elif height >= 720:
        tier = 1024
    else:
        tier = 512
    if not target_is_hevc:
        tier *= 2
    return f"{tier}k"


def _target_fps(cfg: dict) -> str:
    """Explicit output frame rate + CFR (constant frame rate) enforcement.

    WHY THIS EXISTS: with 10+ cameras each running two concurrent
    software libx265 encodes (WATERMARK + ARCHIVE-ENCODE), the CPU
    cannot always keep every encode running exactly in real time. Combined
    with -use_wallclock_as_timestamps (which stamps each frame by the
    moment it actually arrived, not a fixed clock), a momentarily CPU-
    starved encoder produces frames with UNEVEN spacing — some frames
    seconds apart, some milliseconds apart — which plays back as visibly
    "sometimes fast, sometimes slow" even though nothing crashed and the
    file/stream is technically valid. This is a frame-PACING problem, not
    a CRF quality problem — lowering/raising CRF does not fix uneven
    spacing, since CRF only controls compression quality, not timing.

    The fix: force the ENCODER's output to a fixed, constant frame rate
    with "-vsync cfr" (duplicate/drop frames as needed to land exactly on
    that rate) plus an explicit "-r" matching the source's own fps. This
    guarantees even, predictable playback regardless of how bursty the
    upstream encode timing was — the jitter gets absorbed into
    duplicated/dropped frames instead of showing up as visible speed-up/
    slow-down."""
    fps = cfg.get("fps") or 25.0
    return str(round(fps, 2))


def _target_gop(cfg: dict) -> str:
    """2-second GOP sized to the camera's own actual frame rate, instead
    of a flat "-g 50" that silently assumes every camera runs 25fps. A
    camera configured for 15fps or 30fps gets a keyframe interval that
    actually corresponds to 2 seconds of its real output rather than
    drifting off that target. This also makes archive segment cuts land
    on-time much more consistently, now that archive re-encodes (see the
    module docstring's "v5" note) instead of only being able to cut at
    whatever keyframe interval the camera itself happened to use."""
    fps = cfg.get("fps") or 25.0
    return str(max(int(round(fps * 2)), 2))



# ── GPS overlay: shared, continuously-updated text every camera reads ──────
# GPS is a single train-wide unit (see the gps_track_log table), not one
# per camera, so this is one background thread and one small text file
# for the whole process — every camera's ffmpeg drawtext=textfile=...
# :reload=1 filter just reads it. This is the "genuinely live within one
# long-running ffmpeg process" complement to _probe_source_config()
# above: that one only refreshes when a stage restarts (fine for
# resolution/bitrate, which rarely change mid-stream), whereas speed and
# position change continuously while the train is moving and restarting
# ffmpeg to reflect that would be disruptive and far too coarse.
GPS_OVERLAY_DIR = os.environ.get("GPS_OVERLAY_DIR", "/tmp/mnvr_overlay")
GPS_OVERLAY_FILE = os.path.join(GPS_OVERLAY_DIR, "gps_overlay.txt")
GPS_POLL_INTERVAL = 2       # seconds between DB polls
GPS_STALE_AFTER = 15        # seconds — older than this, treat as "no fix"


def _fetch_latest_gps(conn):
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT timestamp, latitude, longitude, speed_kmh, fix_quality
            FROM gps_track_log
            ORDER BY timestamp DESC
            LIMIT 1
        """)
        return cur.fetchone()


def _gps_overlay_text(row) -> str:
    if not row or not row["timestamp"]:
        return "GPS: NO FIX"
    age = (datetime.now() - row["timestamp"]).total_seconds()
    if age > GPS_STALE_AFTER or row["fix_quality"] in (None, "NO_FIX"):
        return "GPS: NO FIX"
    speed = row["speed_kmh"] if row["speed_kmh"] is not None else 0
    return f"{speed:.0f} km/h  |  {row['latitude']:.5f}, {row['longitude']:.5f}"


def gps_overlay_writer():
    """Polls gps_track_log for the latest fix every GPS_POLL_INTERVAL
    seconds and atomically rewrites GPS_OVERLAY_FILE, which every
    camera's watermark filter reads live via drawtext's own
    reload=1 (ffmpeg re-reads the file on every frame it draws, no
    process restart needed). Written via a temp-file + os.replace so no
    camera's ffmpeg process ever reads a half-written file mid-update."""
    os.makedirs(GPS_OVERLAY_DIR, exist_ok=True)
    # Seed a placeholder immediately so the very first ffmpeg launch
    # (which happens concurrently, from other threads) never hits a
    # missing-file error from drawtext before this thread's first poll.
    try:
        with open(GPS_OVERLAY_FILE, "w") as f:
            f.write("GPS: ACQUIRING")
    except Exception as e:
        log.warning(f"Could not seed GPS overlay file: {e}")

    conn = get_db()
    while not _shutdown.is_set():
        try:
            row = _fetch_latest_gps(conn)
            text = _gps_overlay_text(row)
            tmp = GPS_OVERLAY_FILE + ".tmp"
            with open(tmp, "w") as f:
                f.write(text)
            os.replace(tmp, GPS_OVERLAY_FILE)
        except Exception as e:
            log.warning(f"GPS overlay writer error ({e}), reconnecting to DB...")
            try:
                conn.close()
            except Exception:
                pass
            conn = get_db()
        _shutdown.wait(GPS_POLL_INTERVAL)


def _gps_near(conn, ts: datetime):
    """Closest gps_track_log row to a given timestamp — used to snapshot
    a recording segment's start-of-recording position/speed into the
    `recordings` table (see _upsert_recording() below), separate from
    the continuously-updating overlay text above."""
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT latitude, longitude, altitude, speed_kmh, heading, satellites, fix_quality
            FROM gps_track_log
            ORDER BY ABS(EXTRACT(EPOCH FROM (timestamp - %s)))
            LIMIT 1
        """, (ts,))
        return cur.fetchone()


# ── Watermark filter: date/time + location + live GPS speed/position ──────
def _escape_drawtext(text: str) -> str:
    """ffmpeg's drawtext option parser treats \\, : and ' as special —
    escape them so a location label containing any of those (or, later,
    an operator-entered string with punctuation) doesn't break filter
    parsing or get truncated."""
    return (text or "").replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def build_watermark_filter(location_label: str | None) -> str:
    """Three stacked drawtext filters, applied identically to both the
    live path (run_watermark) and the stored recording (run_archive_encode)
    so what viewers see live and what's on disk always match:
      1. Date/time, top-left — unchanged from the original design.
      2. Location, bottom-left — a static per-camera label from
         cameras.location_description (e.g. "Coach S4 — front entrance"),
         baked directly into the filter string since it doesn't change
         while this ffmpeg process runs.
      3. Speed + GPS position, bottom-left below the location line — read
         live from GPS_OVERLAY_FILE via reload=1, so it keeps updating
         for as long as the ffmpeg process runs without needing a
         restart (see gps_overlay_writer() above).

    Deliberately still using ffmpeg's default %{localtime} expansion for
    the date/time line rather than a custom strftime format string — a
    custom format requires colons to be escaped through three separate
    layers (shell, ffmpeg arg parsing, drawtext's own filter-option
    parser), which is fragile and, when tested, produced a "%{localtime}
    requires at most 1 arguments" warning even after escaping. The
    default format is a perfectly readable "YYYY-MM-DD HH:MM:SS" already.
    """
    loc = _escape_drawtext(location_label or "Location: N/A")
    return (
        "drawtext=text='%{localtime}'"
        ":fontcolor=white:fontsize=22:box=1:boxcolor=black@0.5:boxborderw=4"
        ":x=10:y=10,"
        f"drawtext=text='{loc}'"
        ":fontcolor=white:fontsize=18:box=1:boxcolor=black@0.5:boxborderw=4"
        ":x=10:y=h-48,"
        f"drawtext=textfile={GPS_OVERLAY_FILE}:reload=1"
        ":fontcolor=yellow:fontsize=18:box=1:boxcolor=black@0.5:boxborderw=4"
        ":x=10:y=h-22"
    )


def _video_codec_args(codec: str, profile_fallback: str = "main") -> list[str]:
    """Codec-specific compatibility flags. HEVC (libx265) needs the hvc1
    tag for broad MP4/QuickTime/Apple-ecosystem player compatibility
    (without it, some players see the stream as an unplayable "hev1" and
    refuse it) and uses "main" profile (H.264's "baseline" has no HEVC
    equivalent — main is HEVC's own broadly-compatible baseline). H.264
    keeps the existing baseline/no-B-frames flags this project already
    depended on for WebRTC/WHEP."""
    if codec in ("libx265", "hevc_qsv", "hevc_nvenc"):
        return ["-profile:v", profile_fallback, "-tag:v", "hvc1"]
    return ["-profile:v", "baseline"]


def _thread_limit_args(codec: str, threads: int) -> list[str]:
    """Caps THIS ffmpeg process's own encoder thread pool instead of
    letting it default to "every CPU core on the box" — see
    LIVE_ENCODE_THREADS/ARCHIVE_ENCODE_THREADS above for why that default
    is what causes only one camera's stream to ever actually keep up.

    "-threads N" is the generic ffmpeg-level cap and works for both
    libx264 and libx265. libx265 additionally maintains its OWN internal
    thread-pool sizing (separate from ffmpeg's generic -threads on some
    builds), so for libx265 specifically this also pins it directly via
    -x265-params pools=/frame-threads= — belt and suspenders, since the
    whole point is that this process's CPU footprint must NOT be allowed
    to scale with however many cores the host happens to have.

    Hardware encoders (NVENC/QSV) offload the actual encoding work to
    the GPU, not CPU thread pools, so this is a deliberate no-op for
    those — nothing to cap.
    """
    if codec == "libx265":
        return ["-threads", str(threads),
                "-x265-params", f"pools={threads}:frame-threads={threads}"]
    if codec == "libx264":
        return ["-threads", str(threads)]
    return []


def _live_rate_control_args(codec: str, bitrate: str) -> list[str]:
    """Codec-appropriate preset + rate-control flags for the LIVE
    (WATERMARK) stage, where a bounded, predictable bitrate matters more
    than raw quality — WebRTC delivery wants a steady bit rate, not a
    quality target that could spike.

    libx265 (software, CPU-bound): "-preset superfast -b:v/-maxrate/
    -bufsize <bitrate>" — CBR-ish, capped by CPU headroom, which is why
    the cheapest usable preset was chosen (see the call site's own
    comment on why superfast, not slower presets).

    hevc_nvenc (hardware): NVENC doesn't use libx265's preset names or
    rate-control model. "-rc cbr" is NVENC's actual constant-bitrate
    mode (the true hardware equivalent of what -b:v/-maxrate/-bufsize
    approximate for libx265) and "-preset p1" (fastest of NVENC's p1-p7
    scale) minimizes encode latency for live glass-to-glass delay — with
    a hardware encoder, CPU cost is no longer the constraint that forced
    a speed/quality trade-off, so the fastest preset is chosen for
    latency, not out of necessity.
    """
    if codec == "hevc_nvenc":
        return ["-preset", "p1", "-tune", "ll", "-rc", "cbr",
                "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", bitrate]
    if codec == "hevc_qsv":
        return ["-preset", "veryfast",
                "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", bitrate]
    return ["-preset", "superfast",
            "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", bitrate]


def _archive_rate_control_args(codec: str, crf_value: str,
                                target_kbps: int, max_kbps: int,
                                min_kbps: int) -> list[str]:
    """Codec-appropriate preset + rate-control flags for the ARCHIVE-
    ENCODE stage.

    Default mode (ARCHIVE_RATE_MODE=corridor, see the env var's own
    comment above for the full rationale): average-bitrate rate control
    anchored at target_kbps, hard-capped at max_kbps via VBV
    (-maxrate/-bufsize), with min_kbps applied as a qpmax clamp so a
    long static stretch can't coast all the way down to a token
    bitrate. This is still scene-adaptive — average-bitrate RC
    allocates more bits to high-motion/high-complexity frames and fewer
    to static ones on its own, same as CRF did — just anchored to a
    predictable ~1000-1200kbps band instead of an open-ended one.

    bufsize is deliberately sized at 1x target_kbps (roughly a
    1-second VBV window), NOT the more common 2x-maxrate rule of thumb
    — a wide buffer is exactly what lets the encoder drift well below
    the floor during a static stretch before rate control corrects,
    since a big buffer can "coast" on banked surplus for seconds before
    it has to spend bits again. With a target/min/max band this narrow
    (1000-1200, a ~20% spread), a short buffer forces the encoder back
    toward target_kbps almost every frame instead of every few seconds,
    which is what actually keeps output in-band rather than merely
    capping the ceiling. Combined with the qpmax clamp below, a
    completely static multi-second stretch can still legitimately dip
    under min_kbps briefly (see the ARCHIVE_MIN_BITRATE_KBPS comment
    above for why no encoder has a literal hard floor) but should
    recover to target within about a second instead of staying pinned
    low for the rest of the scene.

    ARCHIVE_RATE_MODE=crf opts back into the old open-ended,
    ARCHIVE_CRF-driven quality target with only a maxrate/bufsize
    ceiling — no floor, no target average — for anyone who prefers
    that trade-off (a recording looks as good as its size budget
    allows, full stop, rather than conforming to a predictable rate).

    libx265 (software): "-preset veryfast" — see the call site's own
    comment for why "veryfast" over "medium": CPU budget, not quality,
    is the binding constraint under software encoding (compounded now
    by _thread_limit_args() deliberately capping this process's own
    thread pool — see ARCHIVE_ENCODE_THREADS above).

    hevc_nvenc (hardware): "-rc vbr" is NVENC's average-bitrate VBR
    mode — "-cq" is intentionally NOT set in corridor mode (leaving it
    unset alongside a real -b:v target is what lets NVENC's own VBR
    rate control, rather than a competing quality target, drive the
    output). "-preset p4" (NVENC's balanced default, not the fastest
    p1) spends the headroom hardware encoding frees up on quality
    instead of raw speed — archival footage benefits more from that
    trade than live view's latency-sensitive path does.
    """
    max_bitrate = f"{max_kbps}k"
    bufsize = f"{target_kbps}k"
    if ARCHIVE_RATE_MODE == "crf":
        if codec == "hevc_nvenc":
            return ["-preset", "p4", "-rc", "vbr", "-cq", crf_value, "-b:v", "0",
                    "-maxrate", max_bitrate, "-bufsize", max_bitrate]
        if codec == "hevc_qsv":
            return ["-preset", "medium", "-global_quality", crf_value,
                    "-maxrate", max_bitrate, "-bufsize", max_bitrate]
        return ["-preset", "veryfast", "-crf", crf_value,
                "-maxrate", max_bitrate, "-bufsize", max_bitrate]

    target_bitrate = f"{target_kbps}k"
    minrate = f"{min_kbps}k"
    # qpmax clamp: the "floor" for min_kbps — see the env var comment
    # above for why this is a clamp, not a literal guaranteed minimum.
    # min_kbps/target_kbps close to 1 (a narrow corridor like the
    # 1000/1100/1200 default — only a ~20% spread) means the encoder
    # needs to be kept from EVER treating a scene as "easy enough" to
    # drop far below target, so qpmax is pulled in hard for a narrow
    # band and only relaxed for a wide one. 18 is close to x265's own
    # near-lossless range; 34 is loose enough to let a genuinely easy
    # scene save real bits when the corridor allows the room for it.
    ratio = min_kbps / target_kbps if target_kbps else 0
    qpmax = max(18, min(34, round(40 - ratio * 22)))
    if codec == "hevc_nvenc":
        return ["-preset", "p4", "-rc", "vbr",
                "-b:v", target_bitrate, "-minrate", minrate,
                "-maxrate", max_bitrate, "-bufsize", bufsize,
                "-qmax", str(qpmax)]
    if codec == "hevc_qsv":
        return ["-preset", "medium",
                "-b:v", target_bitrate, "-maxrate", max_bitrate, "-bufsize", bufsize]
    return ["-preset", "veryfast",
            "-b:v", target_bitrate, "-minrate", minrate,
            "-maxrate", max_bitrate, "-bufsize", bufsize,
            "-x265-params", f"qpmax={qpmax}"]


# ── Stage 1: watermark — reads MediaMTX's own camera pull, republishes live ─
# ── Shared resilience flags — reduce frame drops / blank gaps / segment-cut
# drift caused by RTSP timestamp jitter and momentary encode backpressure ──
# _INPUT_RESILIENCE_ARGS (placed before -i, applies to reading the local
# MediaMTX pull):
#   -use_wallclock_as_timestamps 1 : derive PTS from the local wall clock
#     as each frame arrives, instead of trusting the RTSP stream's own
#     timestamps. Camera-side reconnects, packet loss, or MediaMTX's own
#     brief re-buffering can make the stream's own timestamps jump or
#     stall — since -force_key_frames and -segment_time both operate on
#     that same presentation-time clock, a timestamp jump directly
#     desyncs segment cuts from real elapsed time, which is the main
#     reason recorded segments come out shorter/longer than the
#     configured duration even when nothing crashed. Wall-clock timestamps
#     keep that clock tied to real time regardless of what the source
#     stream's own PTS does.
#   -fflags +genpts : regenerates any missing/invalid presentation
#     timestamps rather than passing gaps through, which otherwise show
#     up as a frozen/blank stretch in the output around the gap.
#   -err_detect ignore_err : keep decoding through a corrupted
#     packet/frame instead of aborting the whole read.
#   -fflags +discardcorrupt : paired with the above — actively DROP a
#     frame ffmpeg has flagged as corrupt (bad reference, incomplete
#     packet, etc.) rather than decoding and passing it through. Without
#     this, a single corrupted frame from the camera's own encoder or a
#     brief network glitch gets decoded anyway, and everything that
#     references it (the rest of that GOP) inherits the same garbled
#     macroblocks until the next keyframe — which is the horizontal-band
#     corruption artifact seen in both live view and recordings. Dropping
#     the bad frame instead means the output briefly repeats/freezes on
#     the last good frame — a much smaller, much less alarming defect
#     than a multi-second stretch of visible garbage.
#   -timeout 15000000 : 15s ceiling (microseconds) on a stalled read from
#     MediaMTX's local RTSP pull. This is the RTSP-demuxer-level option
#     name (some ffmpeg builds/versions only expose the equivalent
#     read-timeout knob as "-rw_timeout", a protocol-level option valid
#     for http/tcp/rtmp contexts but NOT accepted as a top-level input
#     option for an "rtsp://" URL on every ffmpeg build — that mismatch
#     is exactly what caused every WATERMARK/ARCHIVE-ENCODE ffmpeg
#     process fleet-wide to exit immediately with "Option rw_timeout not
#     found" the moment this resilience block was added; "-timeout" is
#     the RTSP demuxer's own documented option and works consistently
#     across ffmpeg versions for this exact use case).
#     Without this, a stalled socket read can hang indefinitely with no
#     output written and no process exit — from the supervisor's point
#     of view the stage looks "alive" the whole time, so it never
#     restarts and the recording just sits blank until the read
#     eventually resumes on its own (or doesn't). Timing out promptly
#     hands this back to _run_supervised()'s restart-with-backoff loop
#     instead.
_INPUT_RESILIENCE_ARGS = [
    "-use_wallclock_as_timestamps", "1",
    "-fflags", "+genpts+discardcorrupt",
    "-err_detect", "ignore_err",
    "-timeout", "15000000",
]
# _MUX_RESILIENCE_ARGS (placed among the output args):
#   -max_muxing_queue_size 4096 : ffmpeg's default muxing queue is small
#     enough that a momentarily-slow write (disk I/O hiccup, or the
#     encoder briefly falling behind real-time under CPU load — the
#     ARCHIVE stage's "medium" x265 preset is the more likely of the two
#     to do this) hits "Too many packets buffered for output stream" and
#     ffmpeg drops frames (or exits) rather than just waiting a bit
#     longer. A larger queue absorbs that jitter as a brief buffer
#     instead of dropped/missing frames.
_MUX_RESILIENCE_ARGS = ["-max_muxing_queue_size", "4096"]


def run_watermark(camera_id: int, camera_name: str, location_description: str | None = None):
    """Reads cam_<id>_raw — the camera's LIVE profile, which MediaMTX
    itself pulls directly from the camera (see mediamtx-sync.py; that's
    now the ONLY thing that ever opens an RTSP connection to the physical
    camera). Burns in the date/time + location + speed watermark, encodes
    once, republishes to cam_<id> — the path the frontend's WebRTC/HLS
    players actually watch.

    This process never touches the camera itself, only MediaMTX's own
    local, already-stable pull of it — so camera flakiness becomes
    MediaMTX's problem to reconnect through (which it's built and tested
    for), not this process's."""
    src = f"rtsp://{MEDIAMTX_RTSP_HOST}:{MEDIAMTX_RTSP_PORT}/cam_{camera_id}_raw"
    target = f"rtsp://{MEDIAMTX_RTSP_HOST}:{MEDIAMTX_RTSP_PORT}/cam_{camera_id}"

    # See the WATERMARK_STALL_GRACE_SECS block near the top of this file:
    # this restart_event is stall_watchdog()'s handle on this camera's
    # WATERMARK stage, same mechanism settings_refresher() already uses
    # for segment-duration changes.
    restart_event = _WATERMARK_RESTART.setdefault(camera_id, threading.Event())

    def build_cmd() -> list[str]:
        # Stamped on every (re)start attempt — crash-driven or
        # stall-watchdog-forced alike — so the watchdog's "how long has
        # this attempt been running" clock always reflects the CURRENT
        # process, never a stale one from a previous attempt.
        with _watermark_lock:
            _watermark_start_time[camera_id] = time.monotonic()
        # Re-probed on every (re)start of this stage — see
        # _probe_source_config()'s docstring for why that matters — so
        # bitrate/GOP always reflect what the camera is sending right
        # now, not a stale snapshot from whenever this process first
        # launched. The watermark's date/time/location/speed content
        # updates independently and continuously via reload=1 — see
        # build_watermark_filter().
        cfg = _probe_source_config(src, f"{camera_name} live")
        bitrate = _target_bitrate(cfg, LIVE_VIDEO_CODEC)
        gop = _target_gop(cfg)
        fps = _target_fps(cfg)
        vf = build_watermark_filter(location_description)
        if cfg:
            log.info(
                f"[{camera_name}] live source: {cfg.get('width')}x{cfg.get('height')} "
                f"{cfg.get('fps') or '?'}fps {cfg.get('codec') or '?'} "
                f"→ encoding {LIVE_VIDEO_CODEC} at {bitrate}, gop {gop}"
            )
            if cfg.get("width") and cfg.get("height") and (cfg["width"] < 1920 or cfg["height"] < 1080):
                log.warning(f"[{camera_name}] live source is {cfg['width']}x{cfg['height']}, "
                            f"not Full HD — check this camera's live-profile resolution setting")
        else:
            log.warning(f"[{camera_name}] live source probe unavailable — using "
                        f"defaults ({bitrate}, gop {gop})")
        return [
            "ffmpeg", "-nostdin", "-loglevel", "warning",
            "-rtsp_transport", "tcp",
            "-analyzeduration", "10M",
            "-probesize", "10M",
            *_INPUT_RESILIENCE_ARGS,
            "-i", src,
            "-vf", vf,
            # -bf 0: MediaMTX's WebRTC (WHEP) closes the session outright
            # for H.264 streams with B-frames, and B-frames add latency
            # that live view can't afford regardless of codec — kept for
            # HEVC too even though it's not the hard requirement it is
            # for H.264. -pix_fmt yuv420p: WebRTC/browsers only decode
            # 4:2:0. Bitrate and GOP are computed above from the camera's
            # own current resolution/fps/bitrate rather than fixed
            # constants; codec/profile/pix_fmt stay fixed compliance
            # requirements, not camera settings.
            # Rate-control flags are codec-aware (see _live_rate_control_args
            # for why NVENC and libx265 need genuinely different flags, not
            # just a different -c:v value) — set LIVE_VIDEO_CODEC=hevc_nvenc
            # once hardware encoding is confirmed working to get every
            # camera's live view running at full quality without the CPU
            # contention that forced software encoding down to "superfast".
            "-c:v", LIVE_VIDEO_CODEC,
            *_thread_limit_args(LIVE_VIDEO_CODEC, LIVE_ENCODE_THREADS),
            *_live_rate_control_args(LIVE_VIDEO_CODEC, bitrate),
            *_video_codec_args(LIVE_VIDEO_CODEC),
            "-bf", "0", "-pix_fmt", "yuv420p",
            "-g", gop, "-keyint_min", gop, "-sc_threshold", "0",
            "-force_key_frames", "expr:gte(t,n_forced*2)",
            # -fps_mode cfr (replaces the deprecated -vsync cfr) + explicit
            # -r: force constant, evenly-spaced output frame timing
            # regardless of any encode-timing jitter upstream — see
            # _target_fps()'s docstring for why this is what actually
            # fixes "sometimes fast, sometimes slow" playback (a pacing
            # issue, not a CRF/quality issue).
            "-fps_mode", "cfr", "-r", fps,
            # -an: live view carries NO audio track, on purpose.
            # Every attempt to fix jittery source audio in-line
            # (aresample=async=1, then asetpts=N/SR/TB to regenerate PTS
            # from scratch, then avoid_negative_ts at the muxer) still
            # left WATERMARK processes wedging indefinitely on some
            # cameras' live-profile audio (confirmed: near-zero CPU while
            # stuck, so NOT a resource/contention issue — a genuine
            # timestamp problem in the source). Recordings are
            # completely unaffected and keep full audio — this only
            # removes audio from the live/WebRTC/HLS view, via the
            # separate ARCHIVE-ENCODE stage below, which uses hevc_nvenc
            # (GPU) and has never shown this failure. Trade-off: live
            # tiles are silent; recorded footage has sound.
            "-an",
            "-bsf:v", "dump_extra=freq=keyframe",
            *_MUX_RESILIENCE_ARGS,
            "-f", "rtsp", "-rtsp_transport", "tcp",
            target,
        ]

    _run_supervised(camera_name, "WATERMARK", build_cmd, camera_id, "watermark",
                     restart_event=restart_event)



# ── Stage 2: ARCHIVE — same watermark, camera-driven encode, own connection ─
def run_archive_encode(camera_id: int, camera_name: str, output_dir: str,
                        location_description: str | None = None):
    """Reads cam_{camera_id}_rec_raw — the camera's RECORDING profile,
    independent from the LIVE profile cam_{camera_id}_raw that
    run_watermark() reads (see mediamtx-sync.py's module docstring for
    why these are now two separate MediaMTX pulls rather than one shared
    one) — and writes it to segmented MP4 files carrying the SAME
    date/time + location + speed watermark as the live view (see the
    module docstring's "v5" note for why this isn't a pure `-c copy`: a
    stored recording that visibly shows when/where/how fast it was taken
    is worth more as evidence than pixel-perfect fidelity to the camera's
    raw stream).

    Encoded with libx265/HEVC (see "v6" in the module docstring) using an
    average-bitrate corridor by default (see "v7" and ARCHIVE_TARGET_
    BITRATE_KBPS/ARCHIVE_MAX_BITRATE_KBPS/ARCHIVE_MIN_BITRATE_KBPS above)
    rather than a flat single bitrate or an open-ended CRF quality
    target — deliberately re-encoding even though the camera's recording
    profile may already be sending HEVC itself, since a slower/better-
    tuned x265 pass gets meaningfully better compression at the same or
    better visual quality than whatever real-time encode the camera's
    own firmware does. The corridor is still scene-adaptive (more bits
    to motion, fewer to static frames) — see _archive_rate_control_args()
    — just anchored to a predictable ~1000-1200kbps band instead of an
    unbounded one.

    Audio: MP4 has no standard tag for raw G.711 (PCM mu-law/A-law),
    which is what this camera fleet sends — ffmpeg's mp4 muxer refuses
    to write it at all ("Could not find tag for codec pcm_mulaw in
    stream #1"). AAC is cheap to encode and universally supported for
    playback; if there is no audio track at all this is simply a no-op.

    Segment duration note: because this re-encodes, ffmpeg can force a
    keyframe at the segment boundary itself, so segment cuts land much
    closer to the requested duration than a copy-only design could
    guarantee — that one could only cut at whatever keyframe interval the
    camera's own firmware happened to use. The duration itself comes from
    current_segment_seconds() (DB-backed, see settings_refresher()), read
    fresh on every build_cmd() call — i.e. on every (re)start of this
    stage, including the deliberate restart settings_refresher() triggers
    the moment the DB value changes — not a value frozen at process
    launch. Segments still land short/early whenever this stage itself
    restarts mid-segment (source hiccup, crash, etc — see
    _INPUT_RESILIENCE_ARGS below for what reduces how often that happens)
    since -reset_timestamps restarts the segment clock from zero on every
    new ffmpeg invocation; that's a structural cost of the one-process-
    per-camera-stage design, not something a flag can paper over."""
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    pattern = os.path.join(output_dir, f"cam_{camera_id}_%Y%m%d_%H%M%S.mp4")
    src = f"rtsp://{MEDIAMTX_RTSP_HOST}:{MEDIAMTX_RTSP_PORT}/cam_{camera_id}_rec_raw"
    restart_event = _ARCHIVE_RESTART.setdefault(camera_id, threading.Event())

    def build_cmd() -> list[str]:
        cfg = _probe_source_config(src, f"{camera_name} recording")
        gop = _target_gop(cfg)
        fps = _target_fps(cfg)
        vf = build_watermark_filter(location_description)
        segment_seconds = current_segment_seconds()
        if cfg:
            log.info(
                f"[{camera_name}] recording source: {cfg.get('width')}x{cfg.get('height')} "
                f"{cfg.get('fps') or '?'}fps {cfg.get('codec') or '?'} "
                f"→ encoding {ARCHIVE_VIDEO_CODEC} "
                f"{'crf ' + ARCHIVE_CRF if ARCHIVE_RATE_MODE == 'crf' else f'target {ARCHIVE_TARGET_BITRATE_KBPS}k'}, "
                f"corridor {ARCHIVE_MIN_BITRATE_KBPS}-{ARCHIVE_MAX_BITRATE_KBPS}k, gop {gop}, "
                f"segment {segment_seconds}s"
            )
            if cfg.get("width") and cfg.get("height") and (cfg["width"] < 1920 or cfg["height"] < 1080):
                log.warning(f"[{camera_name}] recording source is {cfg['width']}x{cfg['height']}, "
                            f"not Full HD — check this camera's recording-profile resolution setting")
        else:
            log.warning(f"[{camera_name}] recording source probe unavailable — using "
                        f"defaults (corridor {ARCHIVE_MIN_BITRATE_KBPS}-{ARCHIVE_MAX_BITRATE_KBPS}k, "
                        f"gop {gop}, segment {segment_seconds}s)")
        return [
            "ffmpeg", "-nostdin", "-loglevel", "warning",
            "-rtsp_transport", "tcp",
            "-analyzeduration", "10M",
            "-probesize", "10M",
            *_INPUT_RESILIENCE_ARGS,
            "-i", src,
            "-vf", vf,
            # Rate-control flags are codec-aware (see _archive_rate_control_
            # args for why NVENC's -rc vbr replaces libx265's -b:v/-maxrate/
            # -bufsize rather than just swapping -c:v) — set
            # ARCHIVE_VIDEO_CODEC=hevc_nvenc once hardware encoding is
            # confirmed working to get full-quality real-time archival
            # across every camera at once, instead of the CPU-budget
            # compromise "veryfast" represents under software encoding.
            "-c:v", ARCHIVE_VIDEO_CODEC,
            *_thread_limit_args(ARCHIVE_VIDEO_CODEC, ARCHIVE_ENCODE_THREADS),
            *_archive_rate_control_args(ARCHIVE_VIDEO_CODEC, ARCHIVE_CRF,
                                         ARCHIVE_TARGET_BITRATE_KBPS,
                                         ARCHIVE_MAX_BITRATE_KBPS,
                                         ARCHIVE_MIN_BITRATE_KBPS),
            *_video_codec_args(ARCHIVE_VIDEO_CODEC),
            "-pix_fmt", "yuv420p",
            "-g", gop, "-keyint_min", gop, "-sc_threshold", "0",
            "-force_key_frames", f"expr:gte(t,n_forced*{segment_seconds})",
            # -fps_mode cfr (replaces the deprecated -vsync cfr): same fix
            # as the live stage — forces constant, evenly-spaced output
            # timing so the stored recording plays back at an even pace
            # instead of drifting fast/slow whenever the encoder had to
            # briefly catch up.
            "-fps_mode", "cfr", "-r", fps,
            "-c:a", "aac", "-b:a", "64k",
            *_MUX_RESILIENCE_ARGS,
            "-f", "segment", "-segment_time", str(segment_seconds),
            "-segment_format", "mp4", "-reset_timestamps", "1", "-strftime", "1",
            pattern,
        ]

    _run_supervised(camera_name, "ARCHIVE-ENCODE", build_cmd, camera_id, "rec",
                     restart_event=restart_event)


# ── Recording indexer ───────────────────────────────────────────────────────
# Nothing else registers finished segments. Without this, files land
# correctly in rec_output_dir but the `recordings` table (which the video player reads
# via GET /api/recordings) never gets a row for them, so nothing shows up in
# the UI even though the files are genuinely there. This closes that gap by
# writing directly to Postgres (no dependency on the API/auth being up).
_SEGMENT_RE = re.compile(r"^cam_(\d+)_(\d{8})_(\d{6})\.mp4$")


def _ffprobe(path: str) -> dict | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", path],
            capture_output=True, text=True, timeout=20,
        )
        return json.loads(out.stdout) if out.returncode == 0 and out.stdout else None
    except Exception:
        return None


def _video_codec_label(codec_name: str) -> str:
    return {"h264": "H.264", "hevc": "H.265", "h265": "H.265"}.get(
        (codec_name or "").lower(), (codec_name or "H.264").upper())


def _upsert_recording(conn, camera_id: int, path: Path):
    m = _SEGMENT_RE.match(path.name)
    if not m:
        return  # not one of our segment files (e.g. a leftover/unexpected file)
    try:
        start_ts = datetime.strptime(f"{m.group(2)}{m.group(3)}", "%Y%m%d%H%M%S")
    except ValueError:
        return

    probe = _ffprobe(str(path))
    if not probe:
        return  # file may still be mid-write/corrupt; will retry next poll

    fmt = probe.get("format", {})
    streams = probe.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    has_audio = any(s.get("codec_type") == "audio" for s in streams)

    try:
        duration = float(fmt.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    try:
        num, den = (v.get("r_frame_rate") or "0/1").split("/")
        fps = round(float(num) / float(den), 2) if float(den) else None
    except Exception:
        fps = None

    try:
        file_size = int(fmt.get("size") or path.stat().st_size)
    except Exception:
        file_size = path.stat().st_size

    # Snapshot the closest GPS fix to this segment's start time into the
    # recording's own row — separate from the continuously-updating
    # overlay text burned into the video itself (build_watermark_filter),
    # this is what lets the video player / event search show/filter on
    # "where was the train when this was recorded" without re-parsing
    # video frames.
    gps = None
    try:
        gps = _gps_near(conn, start_ts)
    except Exception:
        gps = None

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO recordings(
                camera_id, file_path, file_name, file_size_bytes, duration_seconds,
                start_timestamp, end_timestamp, video_codec, resolution_width,
                resolution_height, fps_actual, has_audio, recording_mode, status,
                gps_latitude, gps_longitude, gps_speed_kmh, gps_heading,
                gps_satellites, gps_fix_quality, watermark_enabled)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'CONTINUOUS','COMPLETED',
                   %s,%s,%s,%s,%s,%s,1)
            ON CONFLICT (file_path) DO UPDATE SET
                file_size_bytes=EXCLUDED.file_size_bytes,
                duration_seconds=EXCLUDED.duration_seconds,
                end_timestamp=EXCLUDED.end_timestamp,
                status='COMPLETED',
                watermark_enabled=1,
                updated_at=NOW()
            """,
            (camera_id, str(path), path.name, file_size, int(duration),
             start_ts, start_ts + timedelta(seconds=duration),
             _video_codec_label(v.get("codec_name")),
             v.get("width"), v.get("height"), fps, int(has_audio),
             gps["latitude"] if gps else None, gps["longitude"] if gps else None,
             gps["speed_kmh"] if gps else None, gps["heading"] if gps else None,
             gps["satellites"] if gps else None, gps["fix_quality"] if gps else None),
        )
    conn.commit()


def index_recordings(camera_id: int, camera_name: str, output_dir: str):
    """Polls output_dir for this camera's segments and upserts finished ones
    into the DB. The newest-by-name file is always skipped — ffmpeg is still
    writing it — everything older is guaranteed closed and safe to probe."""
    conn = get_db()
    indexed: set[str] = set()
    poll_interval = 30
    while not _shutdown.is_set():
        try:
            files = sorted(Path(output_dir).glob(f"cam_{camera_id}_*.mp4"))
            for f in files[:-1]:  # skip the newest (still being written)
                key = str(f)
                if key in indexed:
                    continue
                try:
                    _upsert_recording(conn, camera_id, f)
                    indexed.add(key)
                except Exception as e:
                    log.warning(f"[{camera_name}] recording index failed for {f.name}: {e}")
                    try:
                        conn.rollback()
                    except Exception:
                        pass
        except Exception as e:
            log.warning(f"[{camera_name}] recording indexer error ({e}), reconnecting to DB...")
            try:
                conn.close()
            except Exception:
                pass
            conn = get_db()
        _shutdown.wait(poll_interval)


# ── Health reporting: tell the DB (and therefore the UI) what's real ───────
def _path_ready(path_name: str) -> bool:
    """Ground truth for is_online: does MediaMTX currently have an active,
    ready source for cam_<id>_raw? This comes from MediaMTX itself (which
    is the only thing that actually talks to the camera now — see the
    module docstring), not from anything this script assumes."""
    try:
        r = requests.get(f"{MEDIAMTX_API}/v3/paths/get/{path_name}", timeout=3)
        if r.ok:
            return bool(r.json().get("ready"))
    except Exception:
        pass
    return False


def report_health(all_camera_ids_fn):
    """Periodically writes a real camera_health row per active camera.

    Nothing else writes to camera_health. GET /api/cameras joins
    the LATEST camera_health row to populate is_online/is_recording for
    the frontend — with nobody writing new rows, that join was returning
    stale-or-empty data forever, completely disconnected from whether
    ffmpeg/MediaMTX were actually streaming. Writing directly to Postgres
    here (same approach as index_recordings() above) avoids needing an
    API auth token inside this script.
    """
    conn = get_db()
    while not _shutdown.is_set():
        try:
            for cid in all_camera_ids_fn():
                is_online = _path_ready(f"cam_{cid}_raw")
                with _status_lock:
                    is_recording = bool(_camera_status.get(cid, {}).get("rec"))
                try:
                    with conn.cursor() as cur:
                        cur.execute(
                            """INSERT INTO camera_health
                               (camera_id, is_online, is_recording, error_count)
                               VALUES (%s, %s, %s, 0)""",
                            (cid, int(is_online), int(is_recording)))
                    conn.commit()
                except Exception as e:
                    log.warning(f"health report failed for camera {cid}: {e}")
                    conn.rollback()
        except Exception as e:
            log.warning(f"report_health error ({e}), reconnecting to DB...")
            try:
                conn.close()
            except Exception:
                pass
            conn = get_db()
        _shutdown.wait(10)


# ── Main: one WATERMARK + one ARCHIVE thread per camera, refreshed from DB ─
def main():
    log.info("=" * 60)
    log.info("  Stream Manager — ffmpeg-based live view + recording")
    log.info(f"  DB           : {DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME}")
    log.info(f"  MediaMTX RTSP: {MEDIAMTX_RTSP_HOST}:{MEDIAMTX_RTSP_PORT}")
    log.info(f"  Recordings   : {RECORDINGS_BASE}")
    log.info(f"  GPS overlay  : {GPS_OVERLAY_FILE}")
    log.info(f"  LIVE codec   : {LIVE_VIDEO_CODEC} (threads capped at {LIVE_ENCODE_THREADS})")
    if ARCHIVE_RATE_MODE == "crf":
        log.info(f"  ARCHIVE codec: {ARCHIVE_VIDEO_CODEC} (CRF {ARCHIVE_CRF}, "
                 f"threads capped at {ARCHIVE_ENCODE_THREADS})")
    else:
        log.info(f"  ARCHIVE codec: {ARCHIVE_VIDEO_CODEC} (target "
                 f"{ARCHIVE_TARGET_BITRATE_KBPS}k, corridor "
                 f"{ARCHIVE_MIN_BITRATE_KBPS}-{ARCHIVE_MAX_BITRATE_KBPS}k, "
                 f"threads capped at {ARCHIVE_ENCODE_THREADS})")
    log.info(f"  Retention    : recordings & logs checked every "
             f"{RETENTION_CHECK_INTERVAL}s (days come from recording_settings, "
             f"defaults {DEFAULT_RECORDING_RETENTION_DAYS}d/{DEFAULT_LOG_RETENTION_DAYS}d)")
    log.info(f"  Stall watchdog: checks every {WATCHDOG_INTERVAL}s, forces a "
             f"WATERMARK restart if wedged (alive but not ready) for "
             f"{WATERMARK_STALL_GRACE_SECS}s+")
    log.info("=" * 60)

    started_cameras: set[int] = set()
    threads: list[threading.Thread] = []

    conn = get_db()
    log.info("Connected to PostgreSQL")

    # Read recording_settings once, synchronously, before any camera starts
    # — so the very first ARCHIVE segment already uses the DB value instead
    # of the SEGMENT_SECONDS env fallback for up to SETTINGS_REFRESH_INTERVAL
    # seconds. settings_refresher() (started right after) takes over from here.
    try:
        initial = fetch_recording_settings(conn)
        raw = initial.get("segment_duration_sec")
        if raw is not None:
            global _current_segment_seconds_val
            with _settings_lock:
                _current_segment_seconds_val = max(
                    MIN_SEGMENT_SECONDS, min(int(raw), MAX_SEGMENT_SECONDS))
            log.info(f"segment_duration_sec (initial, from recording_settings): "
                     f"{_current_segment_seconds_val}s")
    except Exception as e:
        log.warning(f"Initial recording_settings read failed ({e}), "
                     f"using SEGMENT_SECONDS env fallback: {SEGMENT_SECONDS}s")

    t_gps = threading.Thread(target=gps_overlay_writer, name="gps-overlay", daemon=True)
    t_gps.start()
    threads.append(t_gps)

    t_health = threading.Thread(target=report_health, args=(lambda: set(started_cameras),),
                                 name="health-reporter", daemon=True)
    t_health.start()
    threads.append(t_health)

    t_settings = threading.Thread(target=settings_refresher, name="settings-refresher", daemon=True)
    t_settings.start()
    threads.append(t_settings)

    t_retention = threading.Thread(target=retention_cleanup, name="retention-cleanup", daemon=True)
    t_retention.start()
    threads.append(t_retention)

    t_watchdog = threading.Thread(target=stall_watchdog, args=(lambda: set(started_cameras),),
                                   name="stall-watchdog", daemon=True)
    t_watchdog.start()
    threads.append(t_watchdog)

    while not _shutdown.is_set():
        try:
            cameras = fetch_active_cameras(conn)
        except Exception as e:
            log.warning(f"Camera fetch failed ({e}), reconnecting to DB...")
            try:
                conn.close()
            except Exception:
                pass
            conn = get_db()
            cameras = fetch_active_cameras(conn)

        for cam in cameras:
            cid = cam["camera_id"]
            if cid in started_cameras:
                continue
            name = cam["camera_name"]
            out_dir = cam["rec_output_dir"] or RECORDINGS_BASE
            loc = cam["location_description"]

            t_watermark = threading.Thread(target=run_watermark, args=(cid, name, loc),
                                            name=f"watermark-{cid}", daemon=True)
            t_archive = threading.Thread(target=run_archive_encode, args=(cid, name, out_dir, loc),
                                          name=f"archive-{cid}", daemon=True)
            t_idx = threading.Thread(target=index_recordings, args=(cid, name, out_dir),
                                      name=f"idx-{cid}", daemon=True)
            t_watermark.start()
            t_archive.start()
            t_idx.start()
            threads.extend([t_watermark, t_archive, t_idx])
            started_cameras.add(cid)
            log.info(f"[{name}] Started WATERMARK + ARCHIVE-ENCODE + "
                     f"recording-indexer threads (camera_id={cid})")

        _shutdown.wait(CAMERA_REFRESH_INTERVAL)

    log.info("Waiting for camera threads to exit...")
    for t in threads:
        t.join(timeout=10)
    log.info("Stream manager stopped.")


if __name__ == "__main__":
    main()