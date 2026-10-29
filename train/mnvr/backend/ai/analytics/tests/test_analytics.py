"""Run:  python -m unittest discover -s tests -v     (from backend/ai/analytics)
No torch / ultralytics / camera / API needed: the YOLO result is faked and the
API is a throwaway local HTTP server."""
import base64
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analyzers import REGISTRY                                   # noqa: E402
from analyzers import fall_lean                                  # noqa: E402
from analyzers.base import Analyzer, Event                       # noqa: E402
from analyzers.fall_lean import (FallLeanAnalyzer, _Episode,     # noqa: E402
                                 box_aspect_ratio, is_leaning_out)
from common import config                                        # noqa: E402
from common.api_client import ApiClient, ApiRejected, FatalAuthError  # noqa: E402
from common.models import resolve_weights                        # noqa: E402
import worker                                                    # noqa: E402


# ── helpers ──────────────────────────────────────────────────────────────────
class _T:  # mimics a torch tensor enough for .cpu().numpy()
    def __init__(self, a): self.a = np.asarray(a)
    def cpu(self): return self
    def numpy(self): return self.a


class _Result:
    def __init__(self, ids, boxes, kxy, kconf):
        self.boxes = type("B", (), {"id": _T(ids) if ids is not None else None, "xyxy": _T(boxes)})()
        self.keypoints = type("K", (), {"xy": _T(kxy), "conf": _T(kconf)})()


class _FakeModel:
    def __init__(self, results): self.results, self.calls = list(results), 0
    def track(self, *a, **k):
        self.calls += 1
        return [self.results[min(self.calls - 1, len(self.results) - 1)]]


def _person(box, head_xy=None, shoulder_y=None, kconf=0.9):
    k = np.zeros((17, 2), dtype=np.float32)
    c = np.full(17, kconf, dtype=np.float32)
    if head_xy is not None:
        for i in range(5): k[i] = head_xy
    if shoulder_y is not None:
        k[5] = (head_xy[0] - 10, shoulder_y); k[6] = (head_xy[0] + 10, shoulder_y)
    return k, c


def _make(params, results):
    orig, orig_chk = fall_lean.load_yolo, fall_lean._check_tracker_deps
    fall_lean.load_yolo = lambda *a, **k: _FakeModel(results)
    fall_lean._check_tracker_deps = lambda: None          # `lap` is not needed with a fake model
    try:
        return FallLeanAnalyzer(1, params)
    finally:
        fall_lean.load_yolo, fall_lean._check_tracker_deps = orig, orig_chk


FRAME = np.zeros((480, 640, 3), dtype=np.uint8)


# ── episode / geometry ───────────────────────────────────────────────────────
class EpisodeTests(unittest.TestCase):
    def test_alarm_after_min_duration_rising_edge_once(self):
        e = _Episode(1.5, 0.5, 2.0, 0.5)
        fired = [e.update(t, True) for t in (0.0, 0.5, 1.0, 1.5, 2.0, 2.5)]
        self.assertEqual(fired, [False, False, False, True, False, False])
        self.assertTrue(e.alarm)

    def test_brief_dip_holds_but_long_gap_resets(self):
        e = _Episode(1.0, 0.5, 2.0, 0.3)
        for t in (0.0, 0.4, 0.8, 1.2): e.update(t, True)
        self.assertTrue(e.alarm)
        e.update(1.5, False)            # 0.3s dip < gap tolerance, rate still high
        self.assertTrue(e.alarm)
        e.update(2.3, False)            # 1.1s since last high > 0.5s
        self.assertFalse(e.alarm)

    def test_recent_rate_guard_clears_sticky_alarm(self):
        e = _Episode(1.0, 5.0, 2.0, 0.5)    # huge gap tolerance on purpose
        for t in (0.0, 0.5, 1.0, 1.5): e.update(t, True)
        self.assertTrue(e.alarm)
        for t in (1.6, 1.7, 1.8, 1.9, 2.0): e.update(t, False)   # mostly negative window
        self.assertFalse(e.alarm)

    def test_aspect_ratio(self):
        self.assertAlmostEqual(box_aspect_ratio([0, 0, 200, 100]), 2.0)
        self.assertEqual(box_aspect_ratio([0, 0, 10, 0]), 0.0)

    def test_leaning_requires_head_above_shoulder(self):
        poly = np.array([[100, 100], [300, 100], [300, 400], [100, 400]], dtype=np.int32)
        k, c = _person(None, head_xy=(200, 200), shoulder_y=260)     # head above shoulders
        self.assertTrue(is_leaning_out(k, c, poly, 0.35))
        k, c = _person(None, head_xy=(200, 300), shoulder_y=260)     # bent over
        self.assertFalse(is_leaning_out(k, c, poly, 0.35))
        k, c = _person(None, head_xy=(500, 200), shoulder_y=260)     # outside polygon
        self.assertFalse(is_leaning_out(k, c, poly, 0.35))
        k, c = _person(None, head_xy=(200, 200), shoulder_y=260, kconf=0.1)  # unconfident
        self.assertFalse(is_leaning_out(k, c, poly, 0.35))


# ── FallLeanAnalyzer end to end with a fake model ───────────────────────────
class FallLeanTests(unittest.TestCase):
    def test_fallen_event_fires_once_after_duration(self):
        k, c = _person(None, head_xy=(100, 100), shoulder_y=140)
        res = _Result([7], [[50, 300, 350, 400]], [k], [c])           # ratio 3.0
        a = _make({"fall_min_sec": 1.5}, [res])
        evs = []
        for t in (0.0, 0.5, 1.0, 1.4, 1.6, 2.0, 2.5):
            evs += a.process(FRAME, t)
        self.assertEqual(len(evs), 1)
        ev = evs[0]
        self.assertEqual(ev.event_type, "PASSENGER_FALLEN")
        self.assertEqual(ev.data["track_id"], 7)
        self.assertEqual(ev.frame.shape, FRAME.shape)
        self.assertFalse(ev.frame is FRAME)                           # analyzer must not mutate input
        json.dumps(ev.data)                                           # JSON-serializable

    def test_standing_person_never_alarms(self):
        k, c = _person(None, head_xy=(100, 100), shoulder_y=140)
        res = _Result([1], [[50, 50, 120, 300]], [k], [c])            # ratio 0.28
        a = _make({}, [res])
        self.assertEqual(sum(len(a.process(FRAME, t * 0.5)) for t in range(20)), 0)

    def test_leaning_uses_normalized_polygon(self):
        k, c = _person(None, head_xy=(320, 200), shoulder_y=260)
        res = _Result([2], [[280, 150, 360, 460]], [k], [c])          # tall box: not fallen
        poly = [[0.4, 0.2], [0.9, 0.2], [0.9, 0.9], [0.4, 0.9]]       # x 256..576 px on 640 wide
        a = _make({"lean_enabled": True, "lean_polygon": poly, "lean_min_sec": 1.0}, [res])
        evs = []
        for t in (0.0, 0.5, 1.0, 1.5):
            evs += a.process(FRAME, t)
        self.assertEqual([e.event_type for e in evs], ["PASSENGER_LEANING_OUT"])

    def test_lean_enabled_without_polygon_is_rejected(self):
        with self.assertRaises(ValueError):
            _make({"lean_enabled": True, "lean_polygon": None}, [_Result(None, np.zeros((0, 4)), np.zeros((0, 17, 2)), np.zeros((0, 17)))])

    def test_no_tracks_and_stale_track_pruned(self):
        k, c = _person(None, head_xy=(100, 100), shoulder_y=140)
        a = _make({"track_ttl_sec": 10},
                  [_Result([3], [[50, 50, 120, 300]], [k], [c]),
                   _Result(None, np.zeros((0, 4)), np.zeros((0, 17, 2)), np.zeros((0, 17)))])
        a.process(FRAME, 0.0)
        self.assertEqual(len(a.tracks), 1)
        a.process(FRAME, 20.0)                                        # id=None frame, 20s later
        self.assertEqual(len(a.tracks), 0)


class WeightsPathTests(unittest.TestCase):
    def test_rejects_paths_and_odd_suffixes(self):
        for bad in ("../evil.pt", "/etc/passwd", "sub/dir.pt", "model.pkl", ""):
            with self.assertRaises(ValueError):
                resolve_weights(bad)

    def test_missing_file_is_clear_error(self):
        with self.assertRaises(FileNotFoundError):
            resolve_weights("definitely_missing.pt")


# ── ApiClient against a throwaway server ────────────────────────────────────
def _jwt(exp):
    b = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()
    return f"{b({'alg': 'none'})}.{b({'exp': exp})}.sig"


class _Api(BaseHTTPRequestHandler):
    state = {}
    def log_message(self, *a): pass
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); body = json.loads(self.rfile.read(n) or b"{}")
        s = self.state
        if self.path == "/api/auth/login":
            s["logins"] = s.get("logins", 0) + 1
            if body.get("password") == "bad": return self._send(401, {"error": "Invalid credentials"})
            if body.get("username") == "mustchange": return self._send(200, {"token": _jwt(time.time() + 3600), "must_change_password": True})
            return self._send(200, {"token": _jwt(time.time() + 3600), "must_change_password": False})
        if self.path == "/api/analytics/events":
            if body.get("event_type") == "BAD": return self._send(400, {"error": "nope"})
            s.setdefault("events", []).append(body); return self._send(201, {"ok": True})
        self._send(404, {})
    def do_GET(self):
        s = self.state
        if self.path == "/api/analytics/config":
            if s.pop("force_401_once", False): return self._send(401, {"error": "expired"})
            return self._send(200, {"cameras": [{"camera_id": 1, "camera_name": "c", "analytics": []}]})
        self._send(404, {})


class ApiClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), _Api)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_port}"
    @classmethod
    def tearDownClass(cls): cls.srv.shutdown()
    def setUp(self): _Api.state.clear()

    def test_relogin_once_on_401_then_succeeds(self):
        api = ApiClient(self.url, "u", "p")
        api.get_config()
        _Api.state["force_401_once"] = True
        self.assertEqual(api.get_config()["cameras"][0]["camera_id"], 1)
        self.assertEqual(_Api.state["logins"], 2)

    def test_bad_password_is_fatal_after_exactly_one_attempt(self):
        api = ApiClient(self.url, "u", "bad")
        with self.assertRaises(FatalAuthError): api.get_config()
        self.assertEqual(_Api.state["logins"], 1)

    def test_must_change_password_is_fatal_with_clear_message(self):
        with self.assertRaises(FatalAuthError) as cm:
            ApiClient(self.url, "mustchange", "p").get_config()
        self.assertIn("must_change_password", str(cm.exception))

    def test_4xx_event_is_rejected_not_retried(self):
        api = ApiClient(self.url, "u", "p")
        with self.assertRaises(ApiRejected): api.post_event({"event_type": "BAD"})
        api.post_event({"event_type": "OK"})
        self.assertEqual(len(_Api.state["events"]), 1)


# ── CameraWorker with a fake source + analyzer ──────────────────────────────
class _FakeSource:
    def __init__(self, url): self.url = url; self.n = 0
    def start(self): return self
    def wait_new(self, timeout):
        time.sleep(0.01); self.n += 1; return FRAME
    def age(self): return 0.0
    def stop(self): pass


class _Spammer(Analyzer):
    name = "spam"
    default_params = {"interval_sec": 0.05, "cooldown_sec": 0.5}
    def process(self, frame, now):
        return [Event("AI_TEST", "INFO", "t", dedup_key="k", frame=None)]


class _Boom(Analyzer):
    name = "boom"
    default_params = {"interval_sec": 0.05, "cooldown_sec": 0}
    def process(self, frame, now): raise RuntimeError("x")


class _Sink:
    def __init__(self): self.jobs = []
    def submit(self, job): self.jobs.append(job)


class CameraWorkerTests(unittest.TestCase):
    def test_cooldown_limits_events_and_failing_analyzer_is_disabled(self):
        sink = _Sink()
        reg = {"spam": _Spammer, "boom": _Boom, "fake": REGISTRY["fake"]}
        w = worker.CameraWorker(5, "cam", [{"analytic": "spam"}, {"analytic": "boom"}, {"analytic": "nope"}],
                                sink, source_factory=_FakeSource, registry=reg)
        w.start(); time.sleep(1.3); w.stop(); w.join(3)
        self.assertFalse(w.is_alive())
        self.assertTrue(1 <= len(sink.jobs) <= 3, len(sink.jobs))     # ~1.3s / 0.5s cooldown
        self.assertTrue(all(j.camera_id == 5 and j.analytic == "spam" for j in sink.jobs))

    def test_sync_workers_restarts_only_changed_camera(self):
        sink = _Sink(); workers = {}
        reg = {"fake": REGISTRY["fake"]}
        kw = dict(source_factory=_FakeSource, registry=reg)
        d = {1: {"camera_id": 1, "analytics": [{"analytic": "fake", "params": {}}]},
             2: {"camera_id": 2, "analytics": [{"analytic": "fake", "params": {}}]}}
        worker.sync_workers(workers, d, sink, **kw)
        t1, t2 = workers[1][0], workers[2][0]
        d[2]["analytics"][0]["params"] = {"emit_every_sec": 5}
        worker.sync_workers(workers, d, sink, **kw)
        self.assertIs(workers[1][0], t1)
        self.assertIsNot(workers[2][0], t2)
        del d[1]
        worker.sync_workers(workers, d, sink, **kw)
        self.assertNotIn(1, workers)
        for t, _ in workers.values(): t.stop(); t.join(3)


class FakeAnalyzerTests(unittest.TestCase):
    def test_emits_first_frame_then_waits(self):
        a = REGISTRY["fake"](1, {"emit_every_sec": 10})
        self.assertEqual(len(a.process(FRAME, 100.0)), 1)
        self.assertEqual(len(a.process(FRAME, 105.0)), 0)
        self.assertEqual(len(a.process(FRAME, 110.5)), 1)


class SinkTests(unittest.TestCase):
    def test_snapshot_saved_and_payload_sent(self):
        from common.sink import EventSink, Job
        sent = []
        class A:
            def post_event(self, p): sent.append(p)
        with tempfile.TemporaryDirectory() as d:
            old = config.EVENT_SNAPS_PATH
            config.EVENT_SNAPS_PATH = Path(d)
            try:
                s = EventSink(A())
                s._handle(Job(3, "fake", Event("AI_TEST", "INFO", "t", frame=FRAME.copy()), FRAME))
                self.assertEqual(len(sent), 1)
                rel = sent[0]["snapshot_path"]
                self.assertRegex(rel, r"^3/[0-9a-f]{32}\.jpg$")
                self.assertTrue((Path(d) / rel).stat().st_size > 100)
            finally:
                config.EVENT_SNAPS_PATH = old



# ── shadow mode ──────────────────────────────────────────────────────────────
from common.stats import RollingStats                                         # noqa: E402


class _Loud(Analyzer):
    """Behaves like a real analytic: raises a CRITICAL event every run."""
    name = "x"
    default_params = {"interval_sec": 0.05, "cooldown_sec": 0.0}
    SHARED = Event("PASSENGER_FALLEN", "CRITICAL", "Passenger fallen", data={"track_id": 3})
    def process(self, frame, now):
        return [_Loud.SHARED]


def _run_worker(params, cls=_Loud, analytic="x", registry=None, seconds=0.4, **kw):
    sink = _Sink()
    reg = registry or {"x": cls}
    w = worker.CameraWorker(1, "c", [{"analytic": analytic, "params": params}], sink,
                            source_factory=_FakeSource, registry=reg, **kw)
    w.start(); time.sleep(seconds); w.stop(); w.join(3)
    return sink.jobs


class ShadowTests(unittest.TestCase):
    def test_real_analytics_default_to_shadow(self):
        jobs = _run_worker({}, stats_interval_sec=0)
        self.assertTrue(jobs)
        ev = jobs[0].event
        self.assertEqual(ev.severity, "INFO")
        self.assertTrue(ev.title.startswith("[SHADOW] "))
        self.assertEqual(ev.event_type, "PASSENGER_FALLEN")                  # still filterable by type
        self.assertTrue(ev.data["shadow"])
        self.assertEqual(ev.data["would_be_severity"], "CRITICAL")           # keeps what it WOULD have been
        self.assertEqual(ev.data["track_id"], 3)

    def test_analyzer_event_object_is_not_mutated(self):
        _run_worker({}, stats_interval_sec=0)
        self.assertEqual(_Loud.SHARED.severity, "CRITICAL")
        self.assertEqual(_Loud.SHARED.title, "Passenger fallen")
        self.assertNotIn("shadow", _Loud.SHARED.data)

    def test_shadow_false_goes_live_unchanged(self):
        ev = _run_worker({"shadow": False}, stats_interval_sec=0)[0].event
        self.assertEqual((ev.severity, ev.title), ("CRITICAL", "Passenger fallen"))
        self.assertNotIn("shadow", ev.data)

    def test_non_boolean_shadow_is_rejected_safely(self):
        with self.assertLogs("analytics.worker", level="WARNING") as cm:
            ev = _run_worker({"shadow": "false"}, stats_interval_sec=0)[0].event   # the classic string mistake
        self.assertEqual(ev.severity, "INFO")                                       # fell back to shadow, not live
        self.assertTrue(any("must be true/false" in m for m in cm.output))

    def test_fake_analyzer_is_not_shadowed(self):
        jobs = _run_worker({}, analytic="fake", registry={"fake": REGISTRY["fake"]}, stats_interval_sec=0, seconds=0.2)
        ev = jobs[0].event
        self.assertEqual(ev.event_type, "AI_TEST")
        self.assertFalse(ev.title.startswith("[SHADOW]"))
        self.assertNotIn("shadow", ev.data)

    def test_shadow_mode_announced_in_log(self):
        with self.assertLogs("analytics.worker", level="INFO") as cm:
            _run_worker({}, stats_interval_sec=0, seconds=0.1)
        self.assertTrue(any("SHADOW MODE" in m for m in cm.output))


# ── timing stats ─────────────────────────────────────────────────────────────
class StatsTests(unittest.TestCase):
    def test_report_ok_then_slow_variants(self):
        s = RollingStats(60, 0.0)
        for _ in range(10): s.add(0.01, 0.10)
        msg, slow = s.report(60.0, 0.5)
        self.assertFalse(slow)
        for part in ("10 runs", "run avg 100 ms", "keeping up"): self.assertIn(part, msg)

        s.reset(60.0)
        for _ in range(5): s.add(0.0, 0.8)
        msg, slow = s.report(120.0, 0.5)
        self.assertTrue(slow); self.assertIn("smaller model", msg); self.assertIn("max 800 ms", msg)

        s.reset(120.0)
        for _ in range(5): s.add(0.4, 0.2)                     # fast model, but waiting on other analyzers
        msg, slow = s.report(180.0, 0.5)
        self.assertTrue(slow); self.assertIn("other analyzers", msg)

    def test_due_and_reset(self):
        s = RollingStats(60, 100.0)
        self.assertFalse(s.due(150.0)); self.assertTrue(s.due(160.0))
        s.add(0, 1); s.reset(160.0)
        self.assertEqual(s.n, 0); self.assertFalse(s.due(170.0))

    def test_worker_logs_warmup_separately_and_flags_slow_model(self):
        class Sleepy(Analyzer):
            name = "x"
            default_params = {"interval_sec": 0.05, "cooldown_sec": 0.0}     # 0.05 s is the enforced minimum
            def process(self, frame, now):
                time.sleep(0.09); return []
        with self.assertLogs("analytics.worker", level="INFO") as cm:
            _run_worker({}, cls=Sleepy, stats_interval_sec=0.3, seconds=1.2)
        out = "\n".join(cm.output)
        self.assertIn("first run took", out)                    # warm-up logged once, excluded from averages
        self.assertIn("runs in", out)
        self.assertIn("run avg", out)
        self.assertIn("SLOW", out)                              # 90 ms model vs 50 ms interval
        self.assertTrue(any(m.startswith("WARNING") and "SLOW" in m for m in cm.output))


class DescribeConfigTests(unittest.TestCase):
    def test_empty_config_explains_why_nothing_is_running(self):
        msg = worker.describe_config({})
        self.assertIn("nothing is running", msg)
        self.assertIn("no timing lines", msg)
        self.assertIn("PUT /api/analytics/cameras/", msg)

    def test_lists_cameras_and_analytics(self):
        msg = worker.describe_config({
            3: {"camera_id": 3, "analytics": [{"analytic": "fall_lean"}, {"analytic": "fake"}]},
            1: {"camera_id": 1, "analytics": [{"analytic": "crowd"}]}})
        self.assertEqual(msg, "analytics enabled on cam 1 [crowd]; cam 3 [fall_lean, fake]")


class MissingDependencyTests(unittest.TestCase):
    def test_missing_lap_fails_once_with_actionable_message_before_loading_the_model(self):
        loaded = []
        orig = fall_lean.load_yolo
        fall_lean.load_yolo = lambda *a, **k: loaded.append(1)
        saved = sys.modules.get("lap", "absent")
        sys.modules["lap"] = None                             # makes `import lap` raise ImportError
        try:
            with self.assertRaises(RuntimeError) as cm:
                FallLeanAnalyzer(1, {})
        finally:
            fall_lean.load_yolo = orig
            if saved == "absent": sys.modules.pop("lap", None)
            else: sys.modules["lap"] = saved
        self.assertIn("'lap'", str(cm.exception))
        self.assertIn("requirements.txt", str(cm.exception))
        self.assertEqual(loaded, [])                          # heavy model never loaded

    def test_requirements_pins_lap(self):
        req = (Path(__file__).resolve().parent.parent / "requirements.txt").read_text()
        self.assertRegex(req, r"(?m)^lap==0\.5\.12$")


class RestartCooloffTests(unittest.TestCase):
    def test_dead_thread_is_retried_only_after_cooloff(self):
        sink = _Sink(); workers = {}
        cam = {"camera_id": 1, "analytics": [{"analytic": "nope", "params": {}}]}     # unknown analytic -> thread exits at once
        kw = dict(source_factory=_FakeSource, registry={})
        worker.sync_workers(workers, {1: cam}, sink, **kw)
        t1 = workers[1][0]; t1.join(3)
        self.assertFalse(t1.is_alive())
        worker.sync_workers(workers, {1: cam}, sink, **kw)             # immediately: still the same dead entry
        self.assertIs(workers[1][0], t1)
        t1.ended_at -= config.RESTART_COOLOFF_SEC + 1                    # pretend the cool-off has passed
        worker.sync_workers(workers, {1: cam}, sink, **kw)
        self.assertIsNot(workers[1][0], t1)

    def test_config_change_restarts_immediately_even_if_dead(self):
        sink = _Sink(); workers = {}
        cam = {"camera_id": 1, "analytics": [{"analytic": "nope", "params": {}}]}
        kw = dict(source_factory=_FakeSource, registry={})
        worker.sync_workers(workers, {1: cam}, sink, **kw)
        t1 = workers[1][0]; t1.join(3)
        cam2 = {"camera_id": 1, "analytics": [{"analytic": "nope", "params": {"x": 1}}]}
        worker.sync_workers(workers, {1: cam2}, sink, **kw)
        self.assertIsNot(workers[1][0], t1)


# ── crowd (overcrowding) ────────────────────────────────────────────────────
from analyzers import crowd as crowd_mod                                      # noqa: E402
from analyzers.crowd import CrowdAnalyzer                                      # noqa: E402


class _PredBoxes:
    def __init__(self, dets):
        self.xyxy = _T(np.array([d[:4] for d in dets], dtype=np.float32).reshape(-1, 4))
        self.conf = _T(np.array([d[4] for d in dets], dtype=np.float32))
        self._n = len(dets)
    def __len__(self): return self._n


class _FakeDetector:
    def __init__(self, script, names=None):
        self.script, self.calls, self.kw, self.last_input = list(script), 0, None, None
        self.names = names if names is not None else {0: "person", 2: "car"}
    def predict(self, frame, **kw):
        self.kw, self.last_input = kw, frame
        dets = self.script[min(self.calls, len(self.script) - 1)]
        self.calls += 1
        return [type("R", (), {"boxes": _PredBoxes(dets)})()]


def _people(n, x0=0, conf=0.9):
    return [(x0 + i * 10, 100, x0 + i * 10 + 20, 300, conf) for i in range(n)]


def _crowd(params, script, names=None):
    orig = crowd_mod.load_yolo
    det = _FakeDetector(script, names)
    crowd_mod.load_yolo = lambda *a, **k: det
    try:
        a = CrowdAnalyzer(1, params)
    finally:
        crowd_mod.load_yolo = orig
    return a, det


def _feed(a, step=2.0, start=0.0, n=None):
    """Run the analyzer once per scripted frame; returns [(t, [events])] for runs that produced events."""
    out, t = [], start
    for _ in range(n if n is not None else len(a.model_script)):
        evs = a.process(FRAME, t)
        if evs: out.append((t, evs))
        t += step
    return out


def _run(params, counts, **kw):
    a, det = _crowd(params, [_people(c) for c in counts])
    a.model_script = counts
    return a, det, _feed(a, **kw)


class CrowdTests(unittest.TestCase):
    def test_sustained_crowd_raises_exactly_one_event(self):
        a, det, ev = _run({}, [12] * 16)                          # 30 s of 12 people, limit is "more than 8"
        self.assertEqual(len(ev), 1)
        t, events = ev[0]
        self.assertEqual(t, 6.0)                                    # 0 s over-limit starts, +5 s min_sec, sampled every 2 s
        e = events[0]
        self.assertEqual((e.event_type, e.severity, e.dedup_key), ("CROWD_DENSITY", "WARNING", "crowd"))
        self.assertEqual(e.data["people_count"], 12)
        self.assertEqual(e.data["limit"], 8)
        self.assertFalse(e.data["zone_applied"])
        json.dumps(e.data)

    def test_exactly_at_the_limit_is_not_crowded(self):
        _, _, ev = _run({}, [8] * 15)                               # original rule: crowded only when count > 8
        self.assertEqual(ev, [])

    def test_one_frame_spike_is_ignored(self):
        _, _, ev = _run({}, [4, 4, 4, 15, 4, 4, 4, 4])
        self.assertEqual(ev, [])

    def test_flapping_around_the_limit_does_not_spam(self):
        _, _, ev = _run({}, [9, 8, 9, 8, 9, 8, 9, 8, 9, 8, 9, 8])  # the old per-frame rule would flip constantly
        self.assertLessEqual(len(ev), 1)

    def test_hysteresis_holds_until_count_really_drops(self):
        counts = [12] * 6 + [7] * 10 + [3] * 8 + [12] * 8
        a, det, ev = _run({}, counts)
        # 1st event while crowded; counts of 7 (between clear=6 and limit=8) must NOT end the episode;
        # only the long run of 3s does, so the final 12s raise a second event.
        self.assertEqual(len(ev), 2)
        self.assertGreater(ev[1][0], 2.0 * (6 + 10 + 8) - 1)

    def test_video_gap_resets_instead_of_firing_on_a_stale_timer(self):
        a, det = _crowd({}, [_people(12)])
        self.assertEqual(a.process(FRAME, 0.0), [])
        self.assertEqual(a.process(FRAME, 2.0), [])
        self.assertEqual(a.process(FRAME, 200.0), [])               # 198 s later: must not fire at once
        self.assertEqual(a.process(FRAME, 202.0), [])
        fired = a.process(FRAME, 206.0)                             # sustained again for min_sec after the gap
        self.assertEqual(len(fired), 1)

    def test_zone_counts_only_people_whose_feet_are_inside(self):
        left_half = [[0, 0], [0.5, 0], [0.5, 1], [0, 1]]            # x < 320 on the 640-wide test frame
        crowded_side = _people(10, x0=0) + _people(10, x0=400)      # 10 inside, 10 outside
        a, _ = _crowd({"zone_polygon": left_half}, [crowded_side])
        ev = []
        for i in range(8): ev += a.process(FRAME, i * 2.0)
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0].data["people_count"], 10)            # not 20
        self.assertTrue(ev[0].data["zone_applied"])
        a2, _ = _crowd({"zone_polygon": left_half}, [_people(5, x0=0) + _people(10, x0=400)])
        ev2 = []
        for i in range(8): ev2 += a2.process(FRAME, i * 2.0)
        self.assertEqual(ev2, [])                                   # 10 people in frame, only 5 in the zone

    def test_low_confidence_detections_are_not_counted(self):
        a, _ = _crowd({}, [_people(12, conf=0.2)])
        self.assertEqual(sum(len(a.process(FRAME, i * 2.0)) for i in range(10)), 0)

    def test_asks_the_model_for_people_only_on_cpu(self):
        a, det = _crowd({}, [_people(1)])
        a.process(FRAME, 0.0)
        self.assertEqual(det.kw["classes"], [0])
        self.assertEqual(det.kw["device"], "cpu")
        self.assertEqual(det.kw["conf"], 0.40)

    def test_snapshot_is_annotated_copy_and_input_untouched(self):
        a, _ = _crowd({}, [_people(12)])
        frame = FRAME.copy()
        ev = []
        for i in range(8): ev += a.process(frame, i * 2.0)
        snap = ev[0].frame
        self.assertIsNot(snap, frame)
        self.assertTrue(np.array_equal(frame, FRAME))               # input unchanged
        self.assertGreater(int(snap.sum()), 0)                      # boxes/text were drawn

    def test_bad_settings_are_rejected_at_startup(self):
        ok = [_people(1)]
        for bad in ({"clear_at_or_below": 8}, {"clear_at_or_below": 9}, {"crowded_above": 0},
                    {"conf": 0}, {"conf": 1.5}, {"min_sec": -1}, {"window_sec": 0},
                    {"zone_polygon": [[0, 0], [1, 1]]}, {"zone_polygon": [[0, 0], [2, 0], [1, 1]]}):
            with self.assertRaises(ValueError, msg=str(bad)):
                _crowd(bad, ok)

    def test_model_without_person_class_is_rejected(self):
        with self.assertRaises(ValueError):
            _crowd({}, [_people(1)], names={0: "smoke"})

    def test_registered_and_event_type_matches_api_allow_list(self):
        self.assertIs(REGISTRY["crowd"], CrowdAnalyzer)
        api = (Path(__file__).resolve().parents[3] / "api" / "src" / "routes" / "analytics.js").read_text()
        self.assertIn("crowd:         ['CROWD_DENSITY']", api)
        self.assertTrue(CrowdAnalyzer.shadow_default)               # new analytics start in shadow mode


# ── smoke ────────────────────────────────────────────────────────────────────
from analyzers import smoke as smoke_mod                                      # noqa: E402
from analyzers.smoke import SmokeAnalyzer, apply_clahe                         # noqa: E402

SM = [(100, 100, 300, 200, 0.8)]          # one smoke box in ORIGINAL-frame pixels


def _smoke(params, script, names=None):
    orig = smoke_mod.load_yolo
    det = _FakeDetector(script, names if names is not None else {0: "smoke"})
    smoke_mod.load_yolo = lambda *a, **k: det
    try:
        a = SmokeAnalyzer(1, params)
    finally:
        smoke_mod.load_yolo = orig
    return a, det


def _pattern(a, pattern, frame=FRAME, step=1.0, start=0.0, det=None):
    """'1' = model reports smoke on that sample, '0' = nothing. Returns [(index, events)]."""
    det.script = [SM if ch == "1" else [] for ch in pattern]
    det.calls = 0
    out = []
    for i in range(len(pattern)):
        evs = a.process(frame, start + i * step)
        if evs: out.append((i, evs))
    return out


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.a, self.det = _smoke({}, [[]])

    def test_boxes_are_in_original_pixels_not_rescaled_again(self):
        frame = np.zeros((720, 1280, 3), dtype=np.uint8)
        ev = _pattern(self.a, "111", frame=frame, det=self.det)
        box = ev[0][1][0].data["detections"][0]["box"]
        self.assertEqual(box, [100.0, 100.0, 300.0, 200.0])
        self.assertNotEqual(box, [200.0, 112.5, 600.0, 225.0])        # what the old width/imgsz scaling produced
        self.assertEqual(ev[0][1][0].data["frame_size"], [1280, 720])

    def test_needs_three_hits_in_five_samples(self):
        self.assertEqual([i for i, _ in _pattern(self.a, "10101", det=self.det)], [4])
        a, det = _smoke({}, [[]])
        self.assertEqual(_pattern(a, "11000000", det=det), [])         # only two hits
        a, det = _smoke({}, [[]])
        self.assertEqual([i for i, _ in _pattern(a, "1100100", det=det)], [4])

    def test_continuous_smoke_gives_one_event_not_one_per_30_frames(self):
        ev = _pattern(self.a, "1" * 60, det=self.det)
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0][0], 2)

    def test_flicker_does_not_refire_but_a_real_clear_then_new_smoke_does(self):
        ev = _pattern(self.a, "111" + "01" * 8 + "00000" + "111", det=self.det)
        self.assertEqual(len(ev), 2)
        self.assertEqual(ev[0][0], 2)
        self.assertEqual(ev[1][0], 3 + 16 + 5 + 2)

    def test_video_gap_clears_the_window(self):
        a, det = _smoke({}, [SM])
        self.assertEqual(a.process(FRAME, 0.0), [])
        self.assertEqual(a.process(FRAME, 1.0), [])
        self.assertEqual(a.process(FRAME, 100.0), [])                 # without the reset this would fire (3 hits)
        self.assertEqual(a.process(FRAME, 101.0), [])
        self.assertEqual(len(a.process(FRAME, 102.0)), 1)

    def test_clahe_is_applied_before_the_model_and_can_be_disabled(self):
        low = np.random.default_rng(0).integers(100, 140, (480, 640, 3), dtype=np.uint8)
        self.a.process(low, 0.0)
        seen = self.det.last_input
        self.assertEqual((seen.shape, seen.dtype), (low.shape, np.uint8))
        self.assertFalse(np.array_equal(seen, low))
        self.assertGreater(int(seen.astype(int).std()), int(low.astype(int).std()))     # contrast stretched
        a2, det2 = _smoke({"use_clahe": False}, [[]])
        a2.process(low, 0.0)
        self.assertTrue(np.array_equal(det2.last_input, low))

    def test_snapshot_is_annotated_copy_and_input_unchanged(self):
        frame = np.full((480, 640, 3), 50, dtype=np.uint8)
        before = frame.copy()
        ev = _pattern(self.a, "111", frame=frame, det=self.det)[0][1][0]
        self.assertIsNot(ev.frame, frame)
        self.assertTrue(np.array_equal(frame, before))
        self.assertFalse(np.array_equal(ev.frame, frame))
        json.dumps(ev.data)

    def test_model_is_called_for_smoke_only_on_cpu_with_original_thresholds(self):
        self.a.process(FRAME, 0.0)
        kw = self.det.kw
        self.assertEqual((kw["device"], kw["conf"], kw["iou"], kw["imgsz"], kw["classes"]), ("cpu", 0.35, 0.35, 640, [0]))

    def test_class_is_found_by_name_and_wrong_weights_are_refused(self):
        a, det = _smoke({}, [[]], names={0: "fire", 1: "Smoke"})
        a.process(FRAME, 0.0)
        self.assertEqual(det.kw["classes"], [1])
        a, det = _smoke({"class_names": ["flame"]}, [[]], names={0: "flame"})
        a.process(FRAME, 0.0)
        self.assertEqual(det.kw["classes"], [0])
        with self.assertRaises(ValueError):
            _smoke({}, [[]], names={0: "person"})                      # e.g. the wrong .pt file

    def test_low_confidence_boxes_never_count(self):
        a, det = _smoke({}, [[(1, 1, 50, 50, 0.2)]])
        self.assertEqual(sum(len(a.process(FRAME, float(i))) for i in range(10)), 0)

    def test_event_boxes_are_sorted_and_capped(self):
        many = [(i, i, i + 20, i + 20, 0.4 + i * 0.03) for i in range(15)]
        a, det = _smoke({}, [many])
        ev = []
        for i in range(4): ev += a.process(FRAME, float(i))
        d = ev[0].data
        self.assertEqual((len(d["detections"]), d["detection_count"]), (10, 15))
        confs = [x["confidence"] for x in d["detections"]]
        self.assertEqual(confs, sorted(confs, reverse=True))
        self.assertEqual(d["max_confidence"], confs[0])

    def test_event_fields_and_shadow_default(self):
        ev = _pattern(self.a, "111", det=self.det)[0][1][0]
        self.assertEqual((ev.event_type, ev.severity, ev.dedup_key), ("SMOKE_DETECTED", "CRITICAL", "smoke"))
        self.assertTrue(SmokeAnalyzer.shadow_default)
        self.assertIs(REGISTRY["smoke"], SmokeAnalyzer)
        api = (Path(__file__).resolve().parents[3] / "api" / "src" / "routes" / "analytics.js").read_text()
        self.assertIn("smoke:         ['SMOKE_DETECTED']", api)

    def test_bad_settings_are_rejected_at_startup(self):
        for bad in ({"conf": 0}, {"iou": 2}, {"persistence_trigger": 0}, {"persistence_trigger": 6},
                    {"clear_at_or_below": 3}, {"clear_at_or_below": -1}, {"clahe_clip_limit": 0},
                    {"class_names": []}, {"class_names": "smoke"}):
            with self.assertRaises(ValueError, msg=str(bad)):
                _smoke(bad, [[]])


# ── rail obstacle ────────────────────────────────────────────────────────────
import cv2                                                                     # noqa: E402
from analyzers import rail_obstacle as rail_mod                                # noqa: E402
from analyzers.rail_obstacle import RailObstacleAnalyzer, build_corridor, kernel_sizes   # noqa: E402

FR77 = np.full((480, 640, 3), 77, dtype=np.uint8)
RAIL = [[300, 150], [340, 150], [430, 470], [210, 470]]          # converging rails, original-frame pixels
PED = (305, 380, 345, 440, 0.8, 0)                               # x1,y1,x2,y2,conf,class
VEH = (260, 300, 380, 400, 0.7, 2)


class _SegMasks:
    def __init__(self, polys): self.xy = [np.array(p, dtype=np.float32) for p in polys]


class _FakeSeg:
    names, task = {0: "rail"}, "segment"
    def __init__(self, script):
        self.script, self.calls, self.kw, self.last_input = list(script), 0, None, None
    def predict(self, frame, **kw):
        self.kw, self.last_input = kw, frame
        polys = self.script[min(self.calls, len(self.script) - 1)]
        self.calls += 1
        return [type("R", (), {"masks": _SegMasks(polys) if polys else None})()]


class _DetB:
    def __init__(self, dets):
        arr = np.array(dets, dtype=np.float32).reshape(-1, 6)
        self.xyxy, self.conf, self.cls, self._n = _T(arr[:, :4]), _T(arr[:, 4]), _T(arr[:, 5]), len(dets)
    def __len__(self): return self._n


class _FakeDet:
    task = "detect"
    def __init__(self, script, names=None):
        self.script, self.calls, self.kw, self.last_input = list(script), 0, None, None
        self.names = names if names is not None else {0: "Pedestrian", 1: "Animal", 2: "Vehicle", 3: "Debris"}
    def predict(self, frame, **kw):
        self.kw, self.last_input = kw, frame
        dets = self.script[min(self.calls, len(self.script) - 1)]
        self.calls += 1
        return [type("R", (), {"boxes": _DetB(dets)})()]


def _rail(params, seg_script, det_script, seg=None, det=None):
    seg = seg or _FakeSeg(seg_script)
    det = det or _FakeDet(det_script)
    orig = rail_mod.load_yolo
    rail_mod.load_yolo = lambda name, shared=True: seg if "seg" in name else det
    try:
        a = RailObstacleAnalyzer(1, params)
    finally:
        rail_mod.load_yolo = orig
    return a, seg, det


def _ev_times(a, n, frame=FR77, step=1.0):
    out = []
    for i in range(n):
        for e in a.process(frame, i * step):
            out.append((i, e))
    return out


def _original_corridor(track_mask, kernels):
    """The ORIGINAL band loop from final_video_pipeline.py, verbatim in behaviour."""
    bands = [(0.0, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 1.0)]
    h, w = track_mask.shape
    corridor = np.zeros_like(track_mask)
    for (a, b), k in zip(bands, kernels):
        y1, y2 = int(h * a), int(h * b)
        band = np.zeros_like(track_mask)
        band[y1:y2] = track_mask[y1:y2]
        corridor = cv2.bitwise_or(corridor, cv2.dilate(band, np.ones((k, k), np.uint8), iterations=1))
    return corridor


class RailCorridorTests(unittest.TestCase):
    def test_kernel_sizes_are_the_original_ones_at_1080p(self):
        self.assertEqual(kernel_sizes(1080), [11, 31, 61, 101, 151])
        for h in (720, 540, 480, 361):
            ks = kernel_sizes(h)
            self.assertTrue(all(k % 2 == 1 and k >= 3 for k in ks), ks)
            self.assertEqual(ks, sorted(ks))
        self.assertGreater(kernel_sizes(1080, 1.5)[-1], 151)

    def test_corridor_is_bit_identical_to_the_original_algorithm(self):
        rng = np.random.default_rng(3)
        for h, w in ((1080, 1920), (720, 1280), (480, 640), (361, 500)):
            m = np.zeros((h, w), np.uint8)
            for x0 in (w * 0.4, w * 0.55):
                pts = np.array([[x0 - 4, 0], [x0 + 4, 0], [x0 + (x0 - w / 2) * 3, h - 1], [x0 - 60 + (x0 - w / 2) * 3, h - 1]], np.int32)
                cv2.fillPoly(m, [pts], 255)
            m[rng.integers(0, h, 40), rng.integers(0, w, 40)] = 255             # stray pixels
            self.assertTrue(np.array_equal(build_corridor(m, 1.0), _original_corridor(m, kernel_sizes(h, 1.0))), (h, w))
        m = np.zeros((1080, 1920), np.uint8); m[:, 900:1000] = 255
        self.assertTrue(np.array_equal(build_corridor(m), _original_corridor(m, [11, 31, 61, 101, 151])))

    def test_copyto_masking_is_identical_to_the_original_bitwise_and(self):
        rng = np.random.default_rng(1)
        fr = rng.integers(0, 256, (480, 640, 3), dtype=np.uint8)
        mask = np.zeros((480, 640), np.uint8); mask[100:400, 200:500] = 255
        self.assertTrue(np.array_equal(cv2.copyTo(fr, mask), cv2.bitwise_and(fr, fr, mask=mask)))


class RailObstacleTests(unittest.TestCase):
    def test_detector_only_sees_the_corridor_and_boxes_keep_original_pixels(self):
        a, seg, det = _rail({}, [[RAIL]], [[PED]])
        frame = FR77.copy()
        ev = _ev_times(a, 3, frame=frame)
        m = np.zeros((480, 640), np.uint8); cv2.fillPoly(m, [np.array(RAIL, np.int32)], 255)
        expect = cv2.bitwise_and(frame, frame, mask=build_corridor(m))
        self.assertTrue(np.array_equal(det.last_input, expect))
        self.assertEqual(int(det.last_input[0, 0].sum()), 0)                    # far corner blacked out
        self.assertTrue((det.last_input[300, 320] == 77).all())                 # on the rails: untouched
        self.assertTrue(np.array_equal(frame, FR77))                            # caller's frame not mutated
        self.assertEqual(ev[0][1].data["detections"][0]["box"], [305.0, 380.0, 345.0, 440.0])

    def test_event_needs_two_of_three_samples_then_fires_once(self):
        a, seg, det = _rail({}, [[RAIL]], [[PED]])
        ev = _ev_times(a, 12)
        self.assertEqual([i for i, _ in ev], [1])
        e = ev[0][1]
        self.assertEqual((e.event_type, e.severity, e.dedup_key, e.title),
                         ("TRACK_OBSTACLE", "CRITICAL", "obstacle:Pedestrian", "Pedestrian on track ahead"))
        self.assertEqual(e.data["class"], "Pedestrian")
        self.assertFalse(np.array_equal(e.frame, FR77))
        json.dumps(e.data)

    def test_single_frame_detection_is_ignored_and_flicker_gives_one_event(self):
        a, _, det = _rail({}, [[RAIL]], [[PED], [], [], [], []])
        self.assertEqual(_ev_times(a, 5), [])
        a, _, det = _rail({}, [[RAIL]], [[PED], [], [PED], [], [PED], [], [PED]])
        self.assertEqual(len(_ev_times(a, 7)), 1)

    def test_each_class_has_its_own_episode(self):
        a, _, det = _rail({}, [[RAIL]], [[PED], [PED, VEH], [PED, VEH], [PED, VEH]])
        ev = _ev_times(a, 4)
        self.assertEqual([(i, e.data["class"], e.dedup_key) for i, e in ev],
                         [(1, "Pedestrian", "obstacle:Pedestrian"), (2, "Vehicle", "obstacle:Vehicle")])

    def test_low_confidence_boxes_are_ignored(self):
        a, _, det = _rail({}, [[RAIL]], [[(305, 380, 345, 440, 0.1, 0)]])
        self.assertEqual(_ev_times(a, 6), [])

    def test_models_are_called_with_the_original_settings_on_cpu(self):
        a, seg, det = _rail({}, [[RAIL]], [[PED]])
        a.process(FR77, 0.0)
        self.assertEqual((seg.kw["imgsz"], seg.kw["conf"], seg.kw["device"]), (640, 0.30, "cpu"))
        self.assertEqual((det.kw["imgsz"], det.kw["conf"], det.kw["device"]), (640, 0.20, "cpu"))

    def test_no_rails_skips_the_detector_and_reports_track_not_visible_once_per_episode(self):
        script = [[]] * 31 + [[RAIL]] + [[]] * 40
        a, seg, det = _rail({}, script, [[PED]])
        ev = _ev_times(a, 60)
        self.assertEqual([(i, e.event_type) for i, e in ev if e.event_type == "TRACK_NOT_VISIBLE"],
                         [(15, "TRACK_NOT_VISIBLE"), (47, "TRACK_NOT_VISIBLE")])
        self.assertEqual(det.calls, 1)                                             # only the one sample with rails
        e = [e for _, e in ev if e.event_type == "TRACK_NOT_VISIBLE"][0]
        self.assertEqual((e.severity, e.dedup_key), ("WARNING", "rail_lost"))
        self.assertIn("does not mean the track is clear", e.description)

    def test_rail_lost_reporting_can_be_turned_off(self):
        a, _, _ = _rail({"report_rail_lost": False}, [[]], [[PED]])
        self.assertEqual(_ev_times(a, 40), [])

    def test_video_gap_does_not_count_as_rails_lost(self):
        a, _, _ = _rail({}, [[]], [[PED]])
        for t in (0, 1, 2, 3, 4, 5): a.process(FR77, float(t))
        evs = [a.process(FR77, 100.0 + i) for i in range(20)]
        self.assertEqual([i for i, e in enumerate(evs) if e], [15])                # 15 s after the gap, not at once

    def test_swapped_weight_files_are_refused(self):
        seg = _FakeSeg([[RAIL]]); seg.task = "detect"
        with self.assertRaises(ValueError): _rail({}, None, [[PED]], seg=seg)
        det = _FakeDet([[PED]]); det.task = "segment"
        with self.assertRaises(ValueError): _rail({}, [[RAIL]], None, det=det)

    def test_class_names_come_from_the_model_with_override_and_default_fallback(self):
        a, _, _ = _rail({}, [[RAIL]], [[(305, 380, 345, 440, 0.8, 0)]], det=_FakeDet([[(305, 380, 345, 440, 0.8, 0)]], names={0: "Person"}))
        self.assertEqual(_ev_times(a, 3)[0][1].data["class"], "Person")
        a, _, _ = _rail({"class_names": {"0": "Human"}}, [[RAIL]], [[PED]])
        self.assertEqual(_ev_times(a, 3)[0][1].data["class"], "Human")
        det = _FakeDet([[PED]]); det.names = None
        a, _, _ = _rail({}, [[RAIL]], None, det=det)
        self.assertEqual(_ev_times(a, 3)[0][1].data["class"], "Pedestrian")       # the original hard-coded names

    def test_unknown_class_id_still_raises_an_event_even_with_trigger_one(self):
        a, _, _ = _rail({"persistence_trigger": 1, "persistence_window": 1}, [[RAIL]], [[(305, 380, 345, 440, 0.8, 9)]])
        ev = _ev_times(a, 2)
        self.assertEqual(ev[0][1].data["class"], "class_9")

    def test_stage_timing_excludes_warmup_and_counts_skipped_detector_runs(self):
        a, _, _ = _rail({}, [[RAIL], [RAIL], [], [RAIL]], [[PED]])
        _ev_times(a, 4)
        s = a.timing_summary()
        self.assertEqual((s["runs"], s["det_skipped"]), (3, 1))
        for k in ("seg_ms", "corridor_ms", "det_ms"): self.assertGreaterEqual(s[k], 0)

    def test_bad_settings_are_rejected_at_startup(self):
        for bad in ({"seg_conf": 0}, {"det_conf": 2}, {"persistence_trigger": 4}, {"clear_at_or_below": 2},
                    {"corridor_scale": 5}, {"corridor_scale": 0.1}, {"rail_lost_sec": 0},
                    {"min_rail_area_frac": 1}, {"class_names": []}, {"class_names": "x"}):
            with self.assertRaises(ValueError, msg=str(bad)):
                _rail(bad, [[RAIL]], [[PED]])

    def test_registered_shadow_by_default_and_api_allows_both_event_types(self):
        self.assertIs(REGISTRY["rail_obstacle"], RailObstacleAnalyzer)
        self.assertTrue(RailObstacleAnalyzer.shadow_default)
        api = (Path(__file__).resolve().parents[3] / "api" / "src" / "routes" / "analytics.js").read_text()
        self.assertIn("rail_obstacle: ['TRACK_OBSTACLE', 'TRACK_NOT_VISIBLE']", api)


if __name__ == "__main__":
    unittest.main()
