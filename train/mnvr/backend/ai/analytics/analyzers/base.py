"""The contract every analyzer implements.

An analyzer is created once per (camera, analytic) with that camera's params,
and the worker calls process() at most once every `interval_sec`. It receives
the newest frame (do NOT draw on it — copy first) and returns zero or more
Events. It keeps its own temporal state; the worker handles streams, locking,
cooldowns, snapshots and delivery.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np


@dataclass
class Event:
    event_type: str                  # e.g. PASSENGER_FALLEN (API validates per analytic)
    severity: str                    # INFO | WARNING | ERROR | CRITICAL | EMERGENCY
    title: str
    description: str = ""
    data: dict = field(default_factory=dict)         # JSON-serializable only
    frame: Optional[np.ndarray] = None               # annotated snapshot (else raw frame)
    dedup_key: Optional[str] = None                  # cooldown key; default = event_type


class Analyzer(ABC):
    name: str = ""
    # New analytics start in SHADOW mode unless the camera's params say "shadow": false.
    # Handled by the worker, so every analyzer gets it for free (see worker._emit).
    shadow_default: bool = True
    default_params: dict = {"interval_sec": 1.0, "cooldown_sec": 60.0}

    def __init__(self, camera_id: int, params: Optional[dict] = None):
        self.camera_id = camera_id
        self.params = {**self.default_params, **(params or {})}

    @property
    def interval_sec(self) -> float:
        return max(0.05, float(self.params["interval_sec"]))

    @property
    def cooldown_sec(self) -> float:
        return max(0.0, float(self.params["cooldown_sec"]))

    @abstractmethod
    def process(self, frame: np.ndarray, now: float) -> List[Event]:
        """`now` is time.monotonic() seconds. Must not mutate `frame`."""

    def close(self) -> None:
        pass
