"""Live-frame reader: keeps only the newest frame, reconnects forever.

Ported in spirit from main.py's LiveStreamReader, simplified for the one case
that matters here (an RTSP path republished by MediaMTX). Never falls behind:
if analysis is slower than the camera, older frames are dropped, not queued.
"""
import logging
import os
import threading
import time

os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
import cv2  # noqa: E402

log = logging.getLogger("analytics.stream")


class FrameSource:
    def __init__(self, url, reconnect_delay=2.0):
        self.url = url
        self.reconnect_delay = reconnect_delay
        self._stop = threading.Event()
        self._cond = threading.Condition()
        self._frame = None
        self._seq = 0
        self._consumed = 0
        self._t_last = None
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def start(self):
        self._thread.start()
        return self

    def _loop(self):
        cap = None
        warned = False
        while not self._stop.is_set():
            if cap is None:
                cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
                if not cap.isOpened():
                    cap.release()
                    cap = None
                    if not warned:
                        log.warning("cannot open %s, retrying every %.0fs", self.url, self.reconnect_delay)
                        warned = True
                    self._stop.wait(self.reconnect_delay)
                    continue
                log.info("connected: %s", self.url)
                warned = False
            ok, frame = cap.read()
            if not ok or frame is None:
                log.warning("read failed on %s, reconnecting", self.url)
                cap.release()
                cap = None
                self._stop.wait(self.reconnect_delay)
                continue
            with self._cond:
                self._frame = frame
                self._seq += 1
                self._t_last = time.monotonic()
                self._cond.notify_all()
        if cap is not None:
            cap.release()

    def wait_new(self, timeout):
        """Block for a frame newer than the last one returned; None on timeout/stop.
        The returned array is shared — analyzers must copy before drawing."""
        with self._cond:
            ok = self._cond.wait_for(lambda: self._seq != self._consumed or self._stop.is_set(), timeout)
            if not ok or self._stop.is_set():
                return None
            self._consumed = self._seq
            return self._frame

    def age(self):
        return None if self._t_last is None else time.monotonic() - self._t_last

    def stop(self):
        self._stop.set()
        with self._cond:
            self._cond.notify_all()
        if self._thread.is_alive():
            self._thread.join(timeout=3)
