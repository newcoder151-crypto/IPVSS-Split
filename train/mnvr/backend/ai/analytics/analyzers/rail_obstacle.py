"""Rail obstacle analyzer — ported from final_video_pipeline.py (ego-view / driver's-cab camera).

Pipeline (same idea as the original): (1) a segmentation model (seg_model.pt) finds the rails; (2) the rail
mask is widened into a TRACK CORRIDOR with perspective-aware dilation (kernels 11/31/61/101/151 px for the five
horizontal bands, bigger near the camera); (3) everything outside the corridor is blacked out; (4) the obstacle
detector (detect_model.pt) runs on that masked frame. Classes come from the detector itself
(Pedestrian / Animal / Vehicle / Debris in the original).

Kept exactly: seg conf 0.30, det conf 0.20, imgsz 640/640, the five bands and kernel sizes (at 1080p).
Equivalent but faster (verified bit-identical against the original code in the tests):
  * corridor: each band dilates only the rows it can reach (~4x faster);
  * mask apply: cv2.copyTo(frame, mask) instead of cv2.bitwise_and(frame, frame, mask=...) — the masked
    bitwise_and was ~100 ms on a 1080p frame in a CPU benchmark, copyTo ~1 ms, same pixels.
Changed:
  * kernel sizes scale with the frame height (reference 1080), so a 720p stream keeps the same real-world
    corridor width; `corridor_scale` widens/narrows it. At 1080p it is exactly the original.
  * PERSISTENCE: the original reported every raw detection (conf >= 0.20 is permissive). Now a class must be
    seen in `persistence_trigger` of the last `persistence_window` samples (default 2 of 3) per class, with
    hysteresis, and ONE event is raised per episode per class.
  * If no rails are segmented the detector is skipped (the masked frame would be all black anyway), and — because
    "no obstacle reported" must not be confused with "can't see the track" — a TRACK_NOT_VISIBLE event is raised
    when no rails have been found for `rail_lost_sec`.
  * Weights are checked to be the right KIND (segmentation vs detection), since the two files are easy to swap.
  * CPU only; shared model copies; a video gap resets state.

Limits (not fixable without footage): detection latency is one sample interval + persistence (about 2 s by
default) — at 80 km/h a train covers ~22 m per second, so this is advisory only until validated; the
corridor is only as good as the rail segmentation (curves, tunnels, glare, snow); and the original has no
notion of distance/closeness of an obstacle.
"""
import logging
import time
from typing import List

import cv2
import numpy as np

from analyzers.base import Analyzer, Event
from analyzers.persistence import WindowPersistence
from common import config
from common.models import load_yolo

log = logging.getLogger("analytics.rail")

REFERENCE_HEIGHT = 1080
# (start_frac, end_frac, kernel_px_at_1080p) — identical to the original BANDS
BASE_BANDS = [(0.0, 0.2, 11), (0.2, 0.4, 31), (0.4, 0.6, 61), (0.6, 0.8, 101), (0.8, 1.0, 151)]
DEFAULT_CLASS_NAMES = {0: "Pedestrian", 1: "Animal", 2: "Vehicle", 3: "Debris"}
MAX_BOXES_IN_EVENT = 10


def kernel_sizes(height, corridor_scale=1.0):
    s = (height / float(REFERENCE_HEIGHT)) * corridor_scale
    out = []
    for _, _, k in BASE_BANDS:
        kk = max(3, int(round(k * s)))
        out.append(kk + (1 if kk % 2 == 0 else 0))        # odd; unchanged at 1080p / scale 1.0
    return out


def build_corridor(track_mask, corridor_scale=1.0):
    """Perspective-aware dilation of the rail mask. Same result as the original band loop, but each band only
    dilates the rows it can reach (band rows +/- half the kernel)."""
    h, w = track_mask.shape
    corridor = np.zeros_like(track_mask)
    for (s, e, _), ksz in zip(BASE_BANDS, kernel_sizes(h, corridor_scale)):
        y1, y2 = int(h * s), int(h * e)
        if y2 <= y1:
            continue
        r = ksz // 2
        a, b = max(0, y1 - r), min(h, y2 + r)
        band = np.zeros((b - a, w), dtype=np.uint8)
        band[y1 - a:y2 - a] = track_mask[y1:y2]
        if not band.any():
            continue
        corridor[a:b] |= cv2.dilate(band, np.ones((ksz, ksz), np.uint8), iterations=1)
    return corridor


def _names_dict(names):
    if isinstance(names, dict):
        return {int(k): str(v) for k, v in names.items()}
    if isinstance(names, (list, tuple)):
        return {i: str(v) for i, v in enumerate(names)}
    return {}


class RailObstacleAnalyzer(Analyzer):
    name = "rail_obstacle"
    default_params = {
        "seg_model": "seg_model.pt", "det_model": "detect_model.pt",
        "seg_conf": 0.30, "det_conf": 0.20, "seg_imgsz": 640, "det_imgsz": 640,
        "interval_sec": 1.0,            # the original ran ~3/s on a GPU; two models per sample is heavy on CPU
        "cooldown_sec": 120.0,          # per class
        "persistence_window": 3, "persistence_trigger": 2, "clear_at_or_below": 0,
        "corridor_scale": 1.0,
        "report_rail_lost": True, "rail_lost_sec": 15.0, "min_rail_area_frac": 0.0005,
        "class_names": None,            # optional {"0": "Pedestrian", ...}; default = the detector's own names
    }

    def __init__(self, camera_id, params=None):
        super().__init__(camera_id, params)
        p = self.params
        for k in ("seg_conf", "det_conf"):
            if not (0 < float(p[k]) <= 1):
                raise ValueError(f"{k} must be in (0, 1]")
        win, trig, clr = int(p["persistence_window"]), int(p["persistence_trigger"]), int(p["clear_at_or_below"])
        if not (1 <= trig <= win):
            raise ValueError("persistence_trigger must be between 1 and persistence_window")
        if not (0 <= clr < trig):
            raise ValueError("clear_at_or_below must be >= 0 and lower than persistence_trigger")
        if not (0.2 <= float(p["corridor_scale"]) <= 3.0):
            raise ValueError("corridor_scale must be between 0.2 and 3.0")
        if float(p["rail_lost_sec"]) <= 0 or not (0 <= float(p["min_rail_area_frac"]) < 1):
            raise ValueError("rail_lost_sec must be > 0 and min_rail_area_frac in [0, 1)")

        self.seg_model = load_yolo(p["seg_model"], shared=True)     # predict-only: one copy for all cameras
        self.det_model = load_yolo(p["det_model"], shared=True)
        # The two weight files are easy to swap by mistake; fail clearly instead of producing nonsense.
        if getattr(self.seg_model, "task", "segment") != "segment":
            raise ValueError(f"{p['seg_model']} is a '{self.seg_model.task}' model; the rail model must be a segmentation model")
        if getattr(self.det_model, "task", "detect") != "detect":
            raise ValueError(f"{p['det_model']} is a '{self.det_model.task}' model; the obstacle model must be a detection model")

        if p["class_names"] is not None:
            if not isinstance(p["class_names"], dict) or not p["class_names"]:
                raise ValueError("class_names must be an object like {\"0\": \"Pedestrian\"}")
            self.classes = {int(k): str(v) for k, v in p["class_names"].items()}
        else:
            self.classes = _names_dict(getattr(self.det_model, "names", None)) or dict(DEFAULT_CLASS_NAMES)
        gap = max(3 * self.interval_sec, 10.0)
        self.max_gap_sec = gap
        self.persist = {n: WindowPersistence(win, trig, clr, gap) for n in self.classes.values()}

        self._lost_since = None
        self._lost_reported = False
        self._last_t = None
        # per-stage timing (the generic timing line only shows the total)
        self._tm = {"n": 0, "seg": 0.0, "corridor": 0.0, "det": 0.0, "det_skipped": 0}
        self._warm = False
        self._tm_start = time.monotonic()

    # ── stage timing ────────────────────────────────────────────────────────
    def timing_summary(self):
        n = max(1, self._tm["n"])
        return {"runs": self._tm["n"], "seg_ms": self._tm["seg"] / n * 1000,
                "corridor_ms": self._tm["corridor"] / n * 1000, "det_ms": self._tm["det"] / n * 1000,
                "det_skipped": self._tm["det_skipped"]}

    def _record(self, seg, corridor, det, skipped):
        if not self._warm:                       # first run includes model warm-up
            self._warm = True
            self._tm_start = time.monotonic()
            return
        t = self._tm
        t["n"] += 1; t["seg"] += seg; t["corridor"] += corridor; t["det"] += det; t["det_skipped"] += int(skipped)
        if config.STATS_INTERVAL_SEC > 0 and time.monotonic() - self._tm_start >= config.STATS_INTERVAL_SEC:
            s = self.timing_summary()
            log.info("[cam %s] rail_obstacle stages (avg of %d runs): segmentation %.0f ms | corridor+mask %.0f ms | "
                     "detector %.0f ms | detector skipped (no rails) %d times",
                     self.camera_id, s["runs"], s["seg_ms"], s["corridor_ms"], s["det_ms"], s["det_skipped"])
            self._tm = {"n": 0, "seg": 0.0, "corridor": 0.0, "det": 0.0, "det_skipped": 0}
            self._tm_start = time.monotonic()

    # ── main entry ──────────────────────────────────────────────────────────
    def process(self, frame, now) -> List[Event]:
        p = self.params
        h, w = frame.shape[:2]

        if self._last_t is not None and now - self._last_t > self.max_gap_sec:
            self._lost_since, self._lost_reported = None, False          # outage != "rails lost"
        self._last_t = now

        t0 = time.perf_counter()
        seg = self.seg_model.predict(frame, imgsz=p["seg_imgsz"], conf=p["seg_conf"],
                                     device=config.DEVICE, verbose=False)[0]
        t_seg = time.perf_counter() - t0

        t0 = time.perf_counter()
        track_mask = np.zeros((h, w), dtype=np.uint8)
        if seg.masks is not None:
            for poly in seg.masks.xy:                  # polygons are already in original-frame pixels
                if len(poly) >= 3:
                    cv2.fillPoly(track_mask, [np.asarray(poly).astype(np.int32)], 255)
        rail_px = int(np.count_nonzero(track_mask))
        rail_frac = rail_px / float(h * w)
        corridor = build_corridor(track_mask, float(p["corridor_scale"])) if rail_px else track_mask
        masked = cv2.copyTo(frame, corridor) if rail_px else None
        t_corr = time.perf_counter() - t0

        dets = []                                     # (class_name, [x1,y1,x2,y2], conf)
        t0 = time.perf_counter()
        if masked is not None:
            r = self.det_model.predict(masked, imgsz=p["det_imgsz"], conf=p["det_conf"],
                                       device=config.DEVICE, verbose=False)[0]
            if r.boxes is not None and len(r.boxes):
                xyxy, cls, conf = r.boxes.xyxy.cpu().numpy(), r.boxes.cls.cpu().numpy().astype(int), r.boxes.conf.cpu().numpy()
                for box, c, cf in zip(xyxy, cls, conf):
                    if float(cf) >= p["det_conf"]:    # boxes are already in original-frame pixels
                        dets.append((self.classes.get(int(c), f"class_{int(c)}"),
                                     [round(float(v), 1) for v in box], round(float(cf), 3)))
        t_det = time.perf_counter() - t0
        self._record(t_seg, t_corr, t_det, masked is None)

        events: List[Event] = []
        by_class = {}
        for name, box, cf in dets:
            by_class.setdefault(name, []).append({"box": box, "confidence": cf})
        for name in by_class:                          # a class id the detector reports but names don't cover
            if name not in self.persist:
                self.persist[name] = WindowPersistence(int(p["persistence_window"]), int(p["persistence_trigger"]),
                                                       int(p["clear_at_or_below"]), self.max_gap_sec)
        for name, st in self.persist.items():
            items = sorted(by_class.get(name, []), key=lambda d: -d["confidence"])
            if st.update(now, bool(items)):
                events.append(self._obstacle_event(name, items, st, frame, corridor, dets, rail_frac, w, h))

        # "no obstacle reported" must not be confused with "cannot see the track"
        visible = rail_px > 0 and rail_frac >= float(p["min_rail_area_frac"])
        if visible:
            self._lost_since, self._lost_reported = None, False
        else:
            if self._lost_since is None:
                self._lost_since = now
            elif p["report_rail_lost"] and not self._lost_reported and now - self._lost_since >= float(p["rail_lost_sec"]):
                self._lost_reported = True
                events.append(self._lost_event(frame, now - self._lost_since, rail_frac, w, h))
        return events

    # ── events ──────────────────────────────────────────────────────────────
    def _obstacle_event(self, name, items, st, frame, corridor, all_dets, rail_frac, w, h):
        confs = [d["confidence"] for d in items]
        return Event(
            event_type="TRACK_OBSTACLE", severity="CRITICAL",
            title=f"{name} on track ahead",
            description=(f"{name} detected in the track corridor in {st.hits} of the last {len(st.hist)} samples "
                         f"(best confidence {max(confs):.2f})."),
            data={"class": name, "detections": items[:MAX_BOXES_IN_EVENT], "detection_count": len(items),
                  "max_confidence": max(confs), "window_hits": st.hits, "window": int(self.params["persistence_window"]),
                  "rail_area_frac": round(rail_frac, 4), "frame_size": [int(w), int(h)]},
            frame=self._annotate(frame, corridor, all_dets, "TRACK OBSTACLE"),
            dedup_key=f"obstacle:{name}")

    def _lost_event(self, frame, secs, rail_frac, w, h):
        img = frame.copy()
        cv2.putText(img, "RAIL NOT VISIBLE", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 165, 255), 2)
        return Event(
            event_type="TRACK_NOT_VISIBLE", severity="WARNING",
            title="Track not visible to obstacle detection",
            description=(f"No rails were found for {secs:.0f}s, so obstacles cannot be detected. "
                         "A missing obstacle alarm does not mean the track is clear."),
            data={"seconds_without_rails": round(secs, 1), "rail_area_frac": round(rail_frac, 5),
                  "frame_size": [int(w), int(h)]},
            frame=img, dedup_key="rail_lost")

    def _annotate(self, frame, corridor, dets, banner):
        img = frame.copy()
        if corridor is not None and corridor.any():
            tint = img.copy()
            tint[corridor > 0] = (0, 200, 0)
            cv2.addWeighted(tint, 0.18, img, 0.82, 0, img)
        for name, (x1, y1, x2, y2), cf in dets:
            cv2.rectangle(img, (int(x1), int(y1)), (int(x2), int(y2)), (0, 0, 255), 2)
            cv2.putText(img, f"{name} {cf:.2f}", (int(x1), max(14, int(y1) - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
        cv2.putText(img, banner, (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 2)
        return img
