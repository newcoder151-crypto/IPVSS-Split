"""Smoke / fumes analyzer — ported from pipeline.py (YOLO26m, weights smoke_detect.pt).

Kept as in the original: CLAHE contrast preprocessing on the L channel (the original says it must
match training), conf 0.35, iou 0.35, imgsz 640, and the persistence rule "at least 3 detections in
the last 5 sampled frames" before smoke counts as confirmed.

Fixed:
  * BOX COORDINATES. The original multiplied every box by (frame_size / imgsz). Ultralytics already
    returns boxes in original-frame pixels (it rescales in construct_result), so on any frame that is
    not exactly 640x640 the boxes ended up in the wrong place (3x too wide on 1920x1080).
  * EVENT SPAM. The original appended an event every 30 frames for as long as smoke persisted. Now it
    raises ONE event per smoke episode (when it becomes confirmed). To stop it re-firing when detections
    flicker, it stays confirmed until the window has at most `clear_at_or_below` detections (default 0:
    a full window of misses), and the worker's cooldown still applies.
  * DEVICE. The original hard-coded device "0" (first GPU) and crashed on CPU; this uses the configured
    device (CPU).
  * A gap in the video (stream outage) clears the persistence window instead of mixing old and new samples.
  * Class is looked up BY NAME (not assumed to be index 0), and the weights are refused if no class
    name matches — a wrong weights file can't silently be treated as "smoke".
  * The report-only video/JSON output is gone; events + snapshots replace it.

Not fixable here (needs real footage): the 0.35 threshold was "tune after real footage testing" in the
original, and nothing here can tell smoke from steam, dust or glare. That is what shadow mode is for.
"""
from typing import List

import cv2
import numpy as np

from analyzers.base import Analyzer, Event
from analyzers.persistence import WindowPersistence
from common import config
from common.models import load_yolo

MAX_BOXES_IN_EVENT = 10


def apply_clahe(img_bgr, clahe):
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    return cv2.cvtColor(cv2.merge([clahe.apply(l), a, b]), cv2.COLOR_LAB2BGR)


def _class_ids(names, wanted):
    items = names.items() if isinstance(names, dict) else enumerate(names)
    return [int(i) for i, n in items if any(w.lower() in str(n).lower() for w in wanted)]


class SmokeAnalyzer(Analyzer):
    name = "smoke"
    default_params = {
        "model": "smoke_detect.pt",
        "conf": 0.35, "iou": 0.35, "imgsz": 640,
        "interval_sec": 1.0,            # the original sampled ~3/s; smoke changes slowly and CPU time is scarce
        "cooldown_sec": 120.0,
        "persistence_window": 5,        # samples
        "persistence_trigger": 3,       # detections within the window that confirm smoke
        "clear_at_or_below": 0,         # confirmed until the window has this few detections (hysteresis)
        "use_clahe": True,              # must match how the model was trained
        "clahe_clip_limit": 2.0, "clahe_tile_size": 8,
        "class_names": ["smoke", "fume"],
    }

    def __init__(self, camera_id, params=None):
        super().__init__(camera_id, params)
        p = self.params
        for k in ("conf", "iou"):
            if not (0 < float(p[k]) <= 1):
                raise ValueError(f"{k} must be in (0, 1]")
        win, trig, clr = int(p["persistence_window"]), int(p["persistence_trigger"]), int(p["clear_at_or_below"])
        if not (1 <= trig <= win):
            raise ValueError("persistence_trigger must be between 1 and persistence_window")
        if not (0 <= clr < trig):
            raise ValueError("clear_at_or_below must be >= 0 and lower than persistence_trigger")
        if float(p["clahe_clip_limit"]) <= 0 or int(p["clahe_tile_size"]) < 1:
            raise ValueError("clahe_clip_limit must be > 0 and clahe_tile_size >= 1")
        if not isinstance(p["class_names"], list) or not p["class_names"]:
            raise ValueError("class_names must be a non-empty list")
        self.model = load_yolo(p["model"], shared=True)        # predict-only: one copy for all cameras
        self._class_ids = _class_ids(self.model.names, p["class_names"])
        if not self._class_ids:
            raise ValueError(f"model {p['model']} has no class matching {p['class_names']} (classes: {self.model.names})")
        self._clahe = (cv2.createCLAHE(clipLimit=float(p["clahe_clip_limit"]),
                                       tileGridSize=(int(p["clahe_tile_size"]),) * 2)
                       if p["use_clahe"] else None)
        gap = max(3 * self.interval_sec, 10.0)
        self.persist = WindowPersistence(win, trig, clr, gap)

    def process(self, frame, now) -> List[Event]:
        p = self.params
        h, w = frame.shape[:2]
        proc = apply_clahe(frame, self._clahe) if self._clahe is not None else frame
        r = self.model.predict(proc, conf=p["conf"], iou=p["iou"], imgsz=p["imgsz"], classes=self._class_ids,
                               device=config.DEVICE, verbose=False)[0]
        dets = []
        if r.boxes is not None and len(r.boxes):
            xyxy, conf = r.boxes.xyxy.cpu().numpy(), r.boxes.conf.cpu().numpy()
            for box, c in zip(xyxy, conf):
                if float(c) >= p["conf"]:
                    # Already in ORIGINAL-frame pixels (Ultralytics rescales). Do NOT rescale again.
                    dets.append({"box": [round(float(v), 1) for v in box], "confidence": round(float(c), 3)})
        dets.sort(key=lambda d: -d["confidence"])

        rose = self.persist.update(now, bool(dets))
        if not rose:
            return []
        confs = [d["confidence"] for d in dets]
        return [Event(
            event_type="SMOKE_DETECTED", severity="CRITICAL",
            title="Smoke detected",
            description=(f"Smoke seen in {self.persist.hits} of the last {len(self.persist.hist)} samples "
                         f"(best confidence {max(confs):.2f})."),
            data={"detections": dets[:MAX_BOXES_IN_EVENT], "detection_count": len(dets),
                  "max_confidence": max(confs), "avg_confidence": round(sum(confs) / len(confs), 3),
                  "window_hits": self.persist.hits, "window": int(p["persistence_window"]),
                  "frame_size": [int(w), int(h)]},
            frame=self._annotate(frame, dets),         # annotate the ORIGINAL frame, not the CLAHE one
            dedup_key="smoke")]

    def _annotate(self, frame, dets):
        img = frame.copy()
        overlay = img.copy()
        cv2.rectangle(overlay, (0, 0), (img.shape[1], img.shape[0]), (0, 0, 180), -1)
        cv2.addWeighted(overlay, 0.25, img, 0.75, 0, img)
        for d in dets:
            x1, y1, x2, y2 = [int(v) for v in d["box"]]
            cv2.rectangle(img, (x1, y1), (x2, y2), (0, 165, 255), 2)
            cv2.putText(img, f"smoke {d['confidence']:.2f}", (x1, max(14, y1 - 6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        cv2.putText(img, "SMOKE DETECTED", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 2)
        return img
