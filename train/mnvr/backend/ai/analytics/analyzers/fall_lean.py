"""Passenger fallen / leaning-out-of-door analyzer.

Ported from main.py (gangway pipeline). What was kept, deliberately:
  * fallen signal   = person box aspect ratio (w/h) >= threshold;
  * leaning signal  = a confident HEAD keypoint (nose/eyes/ears) inside the
                      door polygon AND head above shoulder line (the gate that
                      removed the bent-over false positive on real footage);
  * confirmation    = duration since onset + gap tolerance + recent-positive-
                      rate guard (the sticky-alarm fix) — identical logic,
                      factored into one _Episode class used for both signals.
What changed:
  * output is an Event on the alarm's rising edge, not an on-frame overlay;
  * danger polygon is in NORMALIZED 0..1 coordinates (survives a change of
    stream resolution) and leaning is OFF unless a polygon is configured;
  * track state is pruned after `track_ttl_sec` (the original grew forever);
  * everything comes from per-camera params, CPU only, no RTSP publishing.

Not fixed (still the original's open questions, flagged in main.py itself):
the 1.2 aspect-ratio threshold was eyeballed from a single real frame, and
ByteTrack is being fed ~2-3 fps, which it was not designed for.
"""
from collections import deque
from typing import List

import cv2
import numpy as np

from analyzers.base import Analyzer, Event
from analyzers.geometry import parse_polygon
from common import config
from common.models import load_yolo

NOSE, L_EYE, R_EYE, L_EAR, R_EAR = 0, 1, 2, 3, 4
L_SHOULDER, R_SHOULDER, L_ELBOW, R_ELBOW, L_WRIST, R_WRIST = 5, 6, 7, 8, 9, 10
L_HIP, R_HIP, L_KNEE, R_KNEE, L_ANKLE, R_ANKLE = 11, 12, 13, 14, 15, 16
HEAD_KPTS = [NOSE, L_EYE, R_EYE, L_EAR, R_EAR]
SKELETON = [
    (L_SHOULDER, R_SHOULDER), (L_HIP, R_HIP), (L_SHOULDER, L_HIP), (R_SHOULDER, R_HIP),
    (L_SHOULDER, L_ELBOW), (L_ELBOW, L_WRIST), (R_SHOULDER, R_ELBOW), (R_ELBOW, R_WRIST),
    (L_HIP, L_KNEE), (L_KNEE, L_ANKLE), (R_HIP, R_KNEE), (R_KNEE, R_ANKLE),
]


# ── pure helpers (unit-tested without a model) ───────────────────────────────

def box_aspect_ratio(box) -> float:
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    return float(w / h) if h > 0 else 0.0


def is_leaning_out(kxy, kconf, polygon_px, kpt_conf, require_head_above_shoulder=True) -> bool:
    sh = [kxy[i][1] for i in (L_SHOULDER, R_SHOULDER) if kconf[i] > kpt_conf]
    shoulder_y = float(np.mean(sh)) if sh else None
    for idx in HEAD_KPTS:
        if kconf[idx] > kpt_conf:
            pt = (float(kxy[idx][0]), float(kxy[idx][1]))
            if cv2.pointPolygonTest(polygon_px, pt, False) >= 0:
                if require_head_above_shoulder and shoulder_y is not None and pt[1] >= shoulder_y:
                    continue  # head at/below shoulders -> bent over, not leaning out
                return True
    return False


def _check_tracker_deps():
    """ByteTrack's matcher needs `lap`. Fail ONCE, clearly, before the heavy model is loaded,
    instead of failing on every frame (which is what a missing package used to do)."""
    try:
        import lap  # noqa: F401
    except ImportError as e:
        raise RuntimeError(
            "tracker dependency 'lap' is not installed in the analytics venv. Fix: "
            "backend/ai/analytics/.venv/bin/pip install -r backend/ai/analytics/requirements.txt "
            "and restart (bash scripts/start.sh)") from e


class _Episode:
    """One continuous real-world event seen through noisy per-sample detections."""

    def __init__(self, min_sec, gap_sec, window_sec, min_fraction):
        self.min_sec, self.gap_sec = min_sec, gap_sec
        self.window_sec, self.min_fraction = window_sec, min_fraction
        self.start = None
        self.last_high = None
        self.recent = deque()
        self.alarm = False

    def _rate(self, t, positive):
        self.recent.append((t, positive))
        while self.recent and t - self.recent[0][0] > self.window_sec:
            self.recent.popleft()
        return sum(1 for _, v in self.recent if v) / len(self.recent)

    def update(self, t, positive) -> bool:
        """Returns True only on the update where the alarm turns on."""
        rate = self._rate(t, positive)
        was = self.alarm
        if positive:
            if self.start is None:
                self.start = t
            self.last_high = t
            self.alarm = (t - self.start) >= self.min_sec
        elif self.start is not None:
            if (t - self.last_high) > self.gap_sec or rate < self.min_fraction:
                self.start = None
                self.alarm = False
            # else: brief dip inside a sustained episode -> hold state
        else:
            self.alarm = False
        return self.alarm and not was


class _Track:
    def __init__(self, p):
        self.fall = _Episode(p["fall_min_sec"], p["fall_gap_sec"], p["recent_window_sec"], p["recent_fraction"])
        self.lean = _Episode(p["lean_min_sec"], p["lean_gap_sec"], p["recent_window_sec"], p["recent_fraction"])
        self.last_seen = 0.0


def _parse_polygon(poly):
    return parse_polygon(poly, "lean_polygon")


class FallLeanAnalyzer(Analyzer):
    name = "fall_lean"
    default_params = {
        "model": "yolo26m-pose.pt",
        "conf": 0.2, "imgsz": 640, "kpt_conf": 0.35,
        "interval_sec": 0.5, "cooldown_sec": 60.0,
        "fall_aspect_ratio": 1.2, "fall_min_sec": 1.5, "fall_gap_sec": 0.5,
        "lean_enabled": False, "lean_polygon": None,
        "lean_min_sec": 1.0, "lean_gap_sec": 0.5, "require_head_above_shoulder": True,
        "recent_window_sec": 2.0, "recent_fraction": 0.5,
        "track_ttl_sec": 30.0,
    }

    def __init__(self, camera_id, params=None):
        super().__init__(camera_id, params)
        p = self.params
        self._poly_norm = None
        if p["lean_enabled"]:
            self._poly_norm = _parse_polygon(p["lean_polygon"])  # raises -> analyzer disabled, camera keeps running
        if p["fall_aspect_ratio"] <= 0:
            raise ValueError("fall_aspect_ratio must be > 0")
        self.tracks = {}
        _check_tracker_deps()
        # Private model: ByteTrack state lives on the model object.
        self.model = load_yolo(p["model"], shared=False)

    # ── main entry ──────────────────────────────────────────────────────────
    def process(self, frame, now) -> List[Event]:
        p = self.params
        h, w = frame.shape[:2]
        poly_px = None
        if self._poly_norm is not None:
            poly_px = (self._poly_norm * np.array([w, h], dtype=np.float32)).astype(np.int32)

        r = self.model.track(frame, persist=True, tracker="bytetrack.yaml", conf=p["conf"],
                             imgsz=p["imgsz"], device=config.DEVICE, verbose=False)[0]

        seen = []  # (track_id, box, kxy, kconf, fall_alarm, lean_alarm)
        events: List[Event] = []
        if r.boxes is not None and r.boxes.id is not None and r.keypoints is not None:
            ids = r.boxes.id.cpu().numpy().astype(int)
            boxes = r.boxes.xyxy.cpu().numpy()
            kxy_all = r.keypoints.xy.cpu().numpy()
            kconf_all = (r.keypoints.conf.cpu().numpy() if r.keypoints.conf is not None
                         else np.ones(kxy_all.shape[:2]))
            rising = []  # (kind, track_id)
            for i, tid in enumerate(ids):
                tr = self.tracks.get(int(tid))
                if tr is None:
                    tr = self.tracks[int(tid)] = _Track(p)
                tr.last_seen = now
                fallen = box_aspect_ratio(boxes[i]) >= p["fall_aspect_ratio"]
                leaning = bool(poly_px is not None and is_leaning_out(
                    kxy_all[i], kconf_all[i], poly_px, p["kpt_conf"], p["require_head_above_shoulder"]))
                if tr.fall.update(now, fallen):
                    rising.append(("fall", int(tid), float(box_aspect_ratio(boxes[i])), boxes[i]))
                if tr.lean.update(now, leaning):
                    rising.append(("lean", int(tid), None, boxes[i]))
                seen.append((int(tid), boxes[i], kxy_all[i], kconf_all[i], tr.fall.alarm, tr.lean.alarm))

            for kind, tid, ratio, box in rising:
                annotated = self._annotate(frame, seen, poly_px)
                box_i = [int(v) for v in box]
                if kind == "fall":
                    events.append(Event(
                        event_type="PASSENGER_FALLEN", severity="CRITICAL",
                        title="Passenger fallen",
                        description=f"Person (track {tid}) lying/fallen for ≥ {p['fall_min_sec']}s.",
                        data={"track_id": tid, "aspect_ratio": round(ratio, 2), "box": box_i, "frame_size": [w, h]},
                        frame=annotated, dedup_key="fall"))
                else:
                    events.append(Event(
                        event_type="PASSENGER_LEANING_OUT", severity="CRITICAL",
                        title="Passenger leaning out of door",
                        description=f"Head of person (track {tid}) beyond the door line for ≥ {p['lean_min_sec']}s.",
                        data={"track_id": tid, "box": box_i, "frame_size": [w, h]},
                        frame=annotated, dedup_key="lean"))

        # prune stale tracks (original script leaked these forever)
        for tid in [t for t, s in self.tracks.items() if now - s.last_seen > p["track_ttl_sec"]]:
            del self.tracks[tid]
        return events

    # ── drawing (only used for the event snapshot) ──────────────────────────
    def _annotate(self, frame, seen, poly_px):
        img = frame.copy()
        if poly_px is not None:
            cv2.polylines(img, [poly_px], True, (255, 0, 255), 2)
        kc = self.params["kpt_conf"]
        for tid, box, kxy, kconf, fall, lean in seen:
            color, label = (0, 200, 0), f"ID{tid}"
            if fall:
                color, label = (0, 0, 255), f"ID{tid} ALARM: FALLEN"
            elif lean:
                color, label = (0, 140, 255), f"ID{tid} ALARM: LEANING OUT"
            x1, y1, x2, y2 = [int(v) for v in box]
            cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
            cv2.putText(img, label, (x1, max(0, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
            for a, b in SKELETON:
                if kconf[a] > kc and kconf[b] > kc:
                    cv2.line(img, tuple(int(v) for v in kxy[a]), tuple(int(v) for v in kxy[b]), color, 1)
            for k in range(17):
                if kconf[k] > kc:
                    cv2.circle(img, (int(kxy[k][0]), int(kxy[k][1])), 3, color, -1)
        return img
