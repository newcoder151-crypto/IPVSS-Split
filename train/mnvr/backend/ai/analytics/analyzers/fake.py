"""Emits one AI_TEST event on the first frame, then every `emit_every_sec`.
Exists only to prove the whole path (worker -> API -> events table -> UI)
works before any real model is involved."""
from typing import List

import cv2

from analyzers.base import Analyzer, Event


class FakeAnalyzer(Analyzer):
    name = "fake"
    shadow_default = False      # a test event must look like a normal event
    default_params = {"interval_sec": 1.0, "cooldown_sec": 0.0, "emit_every_sec": 20.0}

    def __init__(self, camera_id, params=None):
        super().__init__(camera_id, params)
        self._last = None

    def process(self, frame, now) -> List[Event]:
        if self._last is not None and now - self._last < float(self.params["emit_every_sec"]):
            return []
        self._last = now
        h, w = frame.shape[:2]
        img = frame.copy()
        cv2.putText(img, "ANALYTICS TEST EVENT", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 255), 2)
        return [Event(
            event_type="AI_TEST", severity="INFO",
            title="Analytics worker test event",
            description="Synthetic event from the 'fake' analyzer.",
            data={"frame_size": [int(w), int(h)]}, frame=img,
        )]
