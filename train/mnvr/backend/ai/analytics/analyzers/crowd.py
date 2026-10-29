"""Overcrowding analyzer — ported from person_detection.py (YOLO26m, 'person' class).

What was kept: COCO 'person' detections at confidence >= 0.40, and "crowded = more than 8 people".
What changed, and why:
  * The original judged EVERY inference on its own (count > 8), so a count wobbling 8<->9 (one person
    briefly missed or double-detected) flips crowded/not-crowded. Now:
      - the count is smoothed with a rolling MEDIAN over `window_sec` (a one-frame spike or miss
        cannot move a median of several samples);
      - it must stay above the limit for `min_sec` before an event is raised;
      - HYSTERESIS: once crowded it stays crowded until the smoothed count drops to
        `clear_at_or_below` (< limit), so hovering at the limit gives one event, not a stream.
  * ONE event per crowding episode (on the rising edge). The worker's cooldown also applies.
  * Optional `zone_polygon` (normalized 0..1): only people whose FEET (bottom-centre of the box) are
    inside count — real overcrowding is per area, not "anyone anywhere in frame".
  * A gap in the video (stream outage) resets the state instead of letting a stale timer fire.
  * The report-only statistics of the original script (averages, FPS, annotated video) are gone:
    the worker's timing log and the Events page replace them.
Unchanged weakness (flagged): the limit is a head-count, not density. 9 people in a big vestibule and
9 in a tiny compartment are different situations — set `crowded_above` per camera.
"""
from collections import deque
from statistics import median
from typing import List

import cv2
import numpy as np

from analyzers.base import Analyzer, Event
from analyzers.geometry import inside, parse_polygon, to_pixels
from common import config
from common.models import load_yolo


class _CrowdState:
    def __init__(self, above, clear, min_sec, window_sec, max_gap_sec):
        self.above, self.clear = above, clear
        self.min_sec, self.window_sec, self.max_gap_sec = min_sec, window_sec, max_gap_sec
        self.samples = deque()
        self.over_since = None
        self.alarm = False
        self.last_t = None

    def update(self, t, count):
        """Returns (rose, smoothed_count). `rose` is True only on the update that turns the alarm on."""
        if self.last_t is not None and t - self.last_t > self.max_gap_sec:
            self.samples.clear()               # stream outage: don't trust anything from before it
            self.over_since = None
            self.alarm = False
        self.last_t = t
        self.samples.append((t, count))
        while self.samples and t - self.samples[0][0] > self.window_sec:
            self.samples.popleft()
        smooth = float(median(c for _, c in self.samples))
        if not self.alarm:
            if smooth > self.above:
                if self.over_since is None:
                    self.over_since = t
                if t - self.over_since >= self.min_sec:
                    self.alarm = True
                    return True, smooth
            else:
                self.over_since = None
        elif smooth <= self.clear:
            self.alarm = False
            self.over_since = None
        return False, smooth


def _person_ids(names):
    items = names.items() if isinstance(names, dict) else enumerate(names)
    return [int(i) for i, n in items if str(n).lower() == "person"]


class CrowdAnalyzer(Analyzer):
    name = "crowd"
    default_params = {
        "model": "yolo26m.pt",
        "conf": 0.40, "imgsz": 640,
        "interval_sec": 2.0,            # head-counting does not need 3 fps; saves a lot of CPU
        "cooldown_sec": 300.0,
        "crowded_above": 8,             # crowded when MORE than this many people (as in the original)
        "clear_at_or_below": 6,         # hysteresis: stays crowded until the smoothed count falls to this
        "min_sec": 5.0,
        "window_sec": 10.0,
        "zone_polygon": None,           # normalized [[x,y],...]; None = whole frame
    }

    def __init__(self, camera_id, params=None):
        super().__init__(camera_id, params)
        p = self.params
        if not (0 < float(p["conf"]) <= 1):
            raise ValueError("conf must be in (0, 1]")
        if int(p["crowded_above"]) < 1:
            raise ValueError("crowded_above must be >= 1")
        if int(p["clear_at_or_below"]) >= int(p["crowded_above"]):
            raise ValueError("clear_at_or_below must be lower than crowded_above (hysteresis)")
        if float(p["min_sec"]) < 0 or float(p["window_sec"]) <= 0:
            raise ValueError("min_sec must be >= 0 and window_sec > 0")
        self._zone_norm = parse_polygon(p["zone_polygon"], "zone_polygon") if p["zone_polygon"] is not None else None
        self.model = load_yolo(p["model"], shared=True)        # predict-only: safe to share across cameras
        self._person_ids = _person_ids(self.model.names)
        if not self._person_ids:
            raise ValueError(f"model {p['model']} has no 'person' class (classes: {self.model.names})")
        gap = max(3 * self.interval_sec, float(p["window_sec"]))
        self.state = _CrowdState(int(p["crowded_above"]), int(p["clear_at_or_below"]),
                                 float(p["min_sec"]), float(p["window_sec"]), gap)

    def process(self, frame, now) -> List[Event]:
        p = self.params
        h, w = frame.shape[:2]
        r = self.model.predict(frame, conf=p["conf"], imgsz=p["imgsz"], classes=self._person_ids,
                               device=config.DEVICE, verbose=False)[0]
        boxes = r.boxes.xyxy.cpu().numpy() if r.boxes is not None and len(r.boxes) else np.zeros((0, 4))
        confs = r.boxes.conf.cpu().numpy() if r.boxes is not None and len(r.boxes) else np.zeros((0,))
        zone_px = to_pixels(self._zone_norm, w, h) if self._zone_norm is not None else None

        counted, ignored = [], []
        for box, c in zip(boxes, confs):
            if float(c) < p["conf"]:
                continue
            x1, y1, x2, y2 = [float(v) for v in box]
            if zone_px is None or inside(zone_px, (x1 + x2) / 2.0, y2):     # feet point
                counted.append((x1, y1, x2, y2, float(c)))
            else:
                ignored.append((x1, y1, x2, y2, float(c)))

        count = len(counted)
        rose, smooth = self.state.update(now, count)
        if not rose:
            return []
        return [Event(
            event_type="CROWD_DENSITY", severity="WARNING",
            title="Overcrowding detected",
            description=(f"About {smooth:.0f} people (limit {p['crowded_above']}) for at least {p['min_sec']}s"
                         + (" in the monitored zone" if zone_px is not None else "") + "."),
            data={"people_count": count, "smoothed_count": smooth, "limit": int(p["crowded_above"]),
                  "zone_applied": zone_px is not None, "frame_size": [int(w), int(h)]},
            frame=self._annotate(frame, counted, ignored, zone_px, count),
            dedup_key="crowd")]

    def _annotate(self, frame, counted, ignored, zone_px, count):
        img = frame.copy()
        if zone_px is not None:
            cv2.polylines(img, [zone_px], True, (255, 0, 255), 2)
        for x1, y1, x2, y2, c in ignored:
            cv2.rectangle(img, (int(x1), int(y1)), (int(x2), int(y2)), (140, 140, 140), 1)
        for x1, y1, x2, y2, c in counted:
            cv2.rectangle(img, (int(x1), int(y1)), (int(x2), int(y2)), (0, 165, 255), 2)
        cv2.putText(img, f"People: {count} (limit {self.params['crowded_above']})", (20, 40),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 2)
        return img
