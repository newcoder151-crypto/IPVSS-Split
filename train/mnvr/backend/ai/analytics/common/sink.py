"""Background thread that saves snapshots and POSTs events to the API.

Kept off the analysis threads so a slow/unreachable API can never stall
inference. Bounded queue: when full, the newest event is dropped and logged.
"""
import logging
import os
import queue
import threading
import time
import uuid
from dataclasses import dataclass

import cv2
import numpy as np

from common import config
from common.api_client import ApiRejected

log = logging.getLogger("analytics.sink")


@dataclass
class Job:
    camera_id: int
    analytic: str
    event: object          # analyzers.base.Event
    frame: np.ndarray


class EventSink(threading.Thread):
    def __init__(self, api, max_queue=50, retries=3):
        super().__init__(daemon=True, name="event-sink")
        self.api = api
        self.retries = retries
        self.q = queue.Queue(maxsize=max_queue)
        self._stop_evt = threading.Event()

    def submit(self, job: Job):
        try:
            self.q.put_nowait(job)
        except queue.Full:
            log.warning("event queue full — dropping %s on camera %s", job.event.event_type, job.camera_id)

    def stop(self):
        self._stop_evt.set()

    def run(self):
        while not self._stop_evt.is_set():
            try:
                job = self.q.get(timeout=1)
            except queue.Empty:
                continue
            try:
                self._handle(job)
            except Exception:
                log.exception("unhandled error while sending event")

    def _save_snapshot(self, job: Job):
        img = job.event.frame if job.event.frame is not None else job.frame
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        if not ok:
            return None
        rel = f"{job.camera_id}/{uuid.uuid4().hex}.jpg"
        dest = config.EVENT_SNAPS_PATH / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".tmp")
        tmp.write_bytes(buf.tobytes())
        os.replace(tmp, dest)
        return rel

    def _handle(self, job: Job):
        ev = job.event
        try:
            rel = self._save_snapshot(job)
        except Exception:
            log.exception("snapshot save failed; sending event without one")
            rel = None
        payload = {
            "camera_id": job.camera_id,
            "analytic": job.analytic,
            "event_type": ev.event_type,
            "severity": ev.severity,
            "title": ev.title,
            "description": ev.description,
            "data": ev.data,
            "snapshot_path": rel,
        }
        for attempt in range(1, self.retries + 1):
            try:
                self.api.post_event(payload)
                log.info("event sent: %s cam=%s", ev.event_type, job.camera_id)
                return
            except ApiRejected as e:
                log.error("API rejected event (not retrying): %s", e)
                break
            except Exception as e:
                log.warning("send failed (attempt %d/%d): %s", attempt, self.retries, e)
                time.sleep(2 * attempt)
        if rel:
            try:
                (config.EVENT_SNAPS_PATH / rel).unlink()
            except OSError:
                pass
