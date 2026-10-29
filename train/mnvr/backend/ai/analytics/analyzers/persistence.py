"""Shared 'N detections in the last M samples' confirmation with hysteresis and gap reset."""
from collections import deque


class WindowPersistence:
    """Confirmed once >= `trigger` of the last `window` samples had a detection; stays confirmed until the
    window holds at most `clear_at_or_below` detections (hysteresis, so flicker can't re-fire). A gap in the
    video longer than `max_gap_sec` clears the window."""

    def __init__(self, window, trigger, clear_at_or_below, max_gap_sec):
        self.hist = deque(maxlen=window)
        self.trigger, self.clear, self.max_gap_sec = trigger, clear_at_or_below, max_gap_sec
        self.alarm = False
        self.last_t = None

    @property
    def hits(self):
        return sum(self.hist)

    def update(self, t, detected) -> bool:
        """Returns True only on the sample where it becomes confirmed."""
        if self.last_t is not None and t - self.last_t > self.max_gap_sec:
            self.hist.clear()
            self.alarm = False
        self.last_t = t
        self.hist.append(bool(detected))
        if not self.alarm:
            if self.hits >= self.trigger:
                self.alarm = True
                return True
        elif self.hits <= self.clear:
            self.alarm = False
        return False
