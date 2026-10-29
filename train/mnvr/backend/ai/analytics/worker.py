#!/usr/bin/env python3
"""
Analytics worker — runs the per-camera AI analyzers (CPU only).

  python worker.py

Every POLL_CONFIG_SECS it asks the API which cameras have analytics enabled
(GET /api/analytics/config), then keeps one thread per camera that reads the
camera's MediaMTX path (rtsp://<MEDIAMTX_RTSP>/cam_<id>), runs each enabled
analyzer at its own interval, and hands any resulting events to a background
sender (POST /api/analytics/events). It never touches PostgreSQL.

Config changes (analytic enabled/disabled, params edited) are picked up on the
next poll: that camera's thread is restarted. If the API is unreachable the
running threads keep going.
"""
import json
import logging
import signal
import sys
import threading
import time

from analyzers import REGISTRY
from common import config
from common.api_client import ApiClient, FatalAuthError
from common.models import INFERENCE_LOCK, configure_torch
from common.sink import EventSink, Job
from common.stats import RollingStats
from common.stream import FrameSource
from dataclasses import replace

log = logging.getLogger("analytics.worker")


class _Slot:
    def __init__(self, name, analyzer, shadow=False, stats_window=60.0):
        self.name = name
        self.analyzer = analyzer
        self.shadow = shadow
        self.next_run = 0.0
        self.fails = 0
        self.stats = RollingStats(stats_window, time.monotonic())
        self.warm = False      # first run (model warm-up) is timed separately


class CameraWorker(threading.Thread):
    MAX_CONSECUTIVE_FAILURES = 5
    STALE_AFTER_SEC = 5.0

    def __init__(self, camera_id, camera_name, specs, sink,
                 source_factory=FrameSource, registry=REGISTRY,
                 stats_interval_sec=None):
        super().__init__(daemon=True, name=f"cam-{camera_id}")
        self.camera_id = camera_id
        self.camera_name = camera_name
        self.specs = specs
        self.sink = sink
        self.source_factory = source_factory
        self.registry = registry
        self._stop_evt = threading.Event()
        self._last_emit = {}
        self.ended_at = 0.0
        self.stats_interval_sec = config.STATS_INTERVAL_SEC if stats_interval_sec is None else stats_interval_sec

    def stop(self):
        self._stop_evt.set()

    def _build_slots(self):
        slots = []
        for spec in self.specs:
            name = spec["analytic"]
            cls = self.registry.get(name)
            if cls is None:
                log.warning("[cam %s] unknown analytic %r — skipped", self.camera_id, name)
                continue
            try:
                params = spec.get("params") or {}
                shadow = params.get("shadow", cls.shadow_default)
                if not isinstance(shadow, bool):
                    log.warning("[cam %s] %s: \"shadow\" must be true/false, got %r — using %s",
                                self.camera_id, name, shadow, cls.shadow_default)
                    shadow = cls.shadow_default
                slots.append(_Slot(name, cls(self.camera_id, params), shadow, self.stats_interval_sec))
                log.info("[cam %s] analyzer ready: %s%s", self.camera_id, name,
                         "  [SHADOW MODE: events are INFO and labelled [SHADOW]; set params {\"shadow\": false} to go live]" if shadow else "")
            except Exception as e:
                # One bad analyzer (missing weights, bad polygon) must not take
                # down the camera's other analyzers.
                log.error("[cam %s] analyzer %s disabled: %s", self.camera_id, name, e)
        return slots

    def _emit(self, slot, event, frame):
        key = (slot.name, event.dedup_key or event.event_type)
        now = time.monotonic()
        last = self._last_emit.get(key)
        if last is not None and now - last < slot.analyzer.cooldown_sec:
            return
        self._last_emit[key] = now
        if slot.shadow:
            # Tuning mode: visible in the Events page, but never CRITICAL and clearly labelled.
            event = replace(event, severity="INFO", title="[SHADOW] " + event.title,
                            data={**event.data, "shadow": True, "would_be_severity": event.severity})
        self.sink.submit(Job(self.camera_id, slot.name, event, frame))

    def _record_timing(self, slot, wait, run, t):
        if not slot.warm:
            slot.warm = True
            log.info("[cam %s] %s first run took %.0f ms (includes model warm-up; not counted in averages)",
                     self.camera_id, slot.name, run * 1000)
            slot.stats.reset(t)
            return
        slot.stats.add(wait, run)
        if self.stats_interval_sec > 0 and slot.stats.due(t):
            msg, slow = slot.stats.report(t, slot.analyzer.interval_sec)
            (log.warning if slow else log.info)("[cam %s] %s: %s", self.camera_id, slot.name, msg)
            slot.stats.reset(t)

    def run(self):
        try:
            self._run()
        finally:
            # Recorded on EVERY exit path (including 'no usable analyzers'), so the cool-off in
            # sync_workers always applies.
            self.ended_at = time.monotonic()

    def _run(self):
        slots = self._build_slots()
        if not slots:
            log.warning("[cam %s] no usable analyzers — thread exiting", self.camera_id)
            return
        url = f"rtsp://{config.MEDIAMTX_RTSP}/cam_{self.camera_id}"
        source = self.source_factory(url).start()
        log.info("[cam %s] %s started (%s)", self.camera_id, self.camera_name,
                 ", ".join(s.name for s in slots))
        stale_logged = False
        try:
            while not self._stop_evt.is_set() and slots:
                frame = source.wait_new(timeout=2.0)
                if frame is None:
                    age = source.age()
                    if (age is None or age > self.STALE_AFTER_SEC) and not stale_logged:
                        log.warning("[cam %s] no frames for %s", self.camera_id,
                                    "a while" if age is None else f"{age:.0f}s")
                        stale_logged = True
                    continue
                stale_logged = False
                for slot in list(slots):
                    now = time.monotonic()
                    if now < slot.next_run:
                        continue
                    try:
                        t_req = time.monotonic()
                        with INFERENCE_LOCK:
                            t_in = time.monotonic()
                            events = slot.analyzer.process(frame, now)
                            t_out = time.monotonic()
                        slot.fails = 0
                        self._record_timing(slot, t_in - t_req, t_out - t_in, t_out)
                        for ev in events:
                            self._emit(slot, ev, frame)
                    except Exception:
                        slot.fails += 1
                        log.exception("[cam %s] %s failed (%d/%d)", self.camera_id, slot.name,
                                      slot.fails, self.MAX_CONSECUTIVE_FAILURES)
                        if slot.fails >= self.MAX_CONSECUTIVE_FAILURES:
                            log.error("[cam %s] %s disabled after repeated failures", self.camera_id, slot.name)
                            slots.remove(slot)
                    finally:
                        slot.next_run = time.monotonic() + slot.analyzer.interval_sec
        finally:
            source.stop()
            for s in slots:
                try:
                    s.analyzer.close()
                except Exception:
                    pass
            log.info("[cam %s] stopped", self.camera_id)


def describe_config(desired):
    """One-line summary of what the API says should be running (logged whenever it changes)."""
    if not desired:
        return ("no ACTIVE camera has an analytic enabled, so nothing is running and no timing lines will appear. "
                "Enable one: PUT /api/analytics/cameras/<id>/fall_lean {\"enabled\": true}")
    parts = []
    for cid in sorted(desired):
        names = ", ".join(a["analytic"] for a in desired[cid].get("analytics", []))
        parts.append(f"cam {cid} [{names}]")
    return "analytics enabled on " + "; ".join(parts)


def _fingerprint(cam):
    return json.dumps(cam.get("analytics", []), sort_keys=True)


def sync_workers(workers, desired, sink, **worker_kw):
    """Make `workers` ({camera_id: (thread, fingerprint)}) match `desired`
    ({camera_id: camera dict from the API}). Returns nothing; mutates `workers`."""
    for cid in list(workers):
        thread, fp = workers[cid]
        cam = desired.get(cid)
        changed = cam is None or _fingerprint(cam) != fp
        if not changed and not thread.is_alive():
            # Died by itself (e.g. every analyzer disabled after repeated failures). Retry after a
            # cool-off instead of every poll: each retry reloads the model and spams the log.
            if time.monotonic() - thread.ended_at < config.RESTART_COOLOFF_SEC:
                continue
            log.info("[cam %s] retrying analytics after cool-off", cid)
            changed = True
        if changed:
            thread.stop()
            thread.join(timeout=5)
            del workers[cid]
            log.info("[cam %s] worker removed/restarting", cid)
    for cid, cam in desired.items():
        if cid not in workers:
            t = CameraWorker(cid, cam.get("camera_name", f"cam{cid}"), cam["analytics"], sink, **worker_kw)
            t.start()
            workers[cid] = (t, _fingerprint(cam))


def main():
    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s [ANALYTICS] %(levelname)s %(name)s: %(message)s",
                        datefmt="%Y-%m-%d %H:%M:%S")
    if not config.ANALYTICS_USER or not config.ANALYTICS_PASS:
        log.error("ANALYTICS_USER and ANALYTICS_PASS must be set (use a dedicated API_CLIENT account).")
        return 2

    configure_torch()
    api = ApiClient(config.API_URL, config.ANALYTICS_USER, config.ANALYTICS_PASS)
    sink = EventSink(api)
    sink.start()

    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())

    workers = {}
    backoff = 5
    last_summary = None
    log.info("worker started; polling %s every %ss", config.API_URL, config.POLL_CONFIG_SECS)
    while not stop.is_set():
        try:
            cfg = api.get_config()
            desired = {int(c["camera_id"]): c for c in cfg.get("cameras", [])}
            summary = describe_config(desired)
            if summary != last_summary:
                log.info("config: %s", summary)
                last_summary = summary
            sync_workers(workers, desired, sink)
            backoff = 5
            stop.wait(config.POLL_CONFIG_SECS)
        except FatalAuthError as e:
            log.error("fatal auth problem, exiting: %s", e)
            stop.set()
            return_code = 2
            break
        except Exception as e:
            # API down/starting: keep current workers running, retry with backoff.
            log.warning("config poll failed (%s); retrying in %ds", e, backoff)
            stop.wait(backoff)
            backoff = min(backoff * 2, 60)
    else:
        return_code = 0

    log.info("shutting down…")
    for thread, _ in workers.values():
        thread.stop()
    for thread, _ in workers.values():
        thread.join(timeout=5)
    sink.stop()
    return return_code


if __name__ == "__main__":
    sys.exit(main())
