"""Model loading + the one global inference lock.

CPU-only design: all inference in this process is serialized behind
INFERENCE_LOCK. Torch already spreads one forward pass across cores; running
several at once on CPU mostly thrashes. This also makes it safe for
predict-only analyzers to share one model object across cameras.

Tracking analyzers (ByteTrack via model.track(persist=True)) must NOT share:
the tracker state lives on the model object, so two cameras sharing it would
mix their track IDs. They call load_yolo(..., shared=False).
"""
import logging
import threading
from pathlib import Path

from common import config

log = logging.getLogger("analytics.models")

INFERENCE_LOCK = threading.Lock()
_cache = {}
_cache_lock = threading.Lock()
_ALLOWED_SUFFIXES = {".pt", ".onnx"}


def configure_torch():
    if config.TORCH_THREADS > 0:
        import torch
        torch.set_num_threads(config.TORCH_THREADS)
        log.info("torch threads = %d", config.TORCH_THREADS)


def resolve_weights(name: str) -> Path:
    # Bare filename only: .pt files are pickles; never load one from a path
    # that came out of a database row.
    if not isinstance(name, str) or Path(name).name != name or Path(name).suffix not in _ALLOWED_SUFFIXES:
        raise ValueError(f"model must be a bare .pt/.onnx filename, got {name!r}")
    p = config.MODELS_DIR / name
    if not p.is_file():
        raise FileNotFoundError(
            f"weights not found: {p} — copy the file into {config.MODELS_DIR} "
            "(auto-download is disabled on purpose)"
        )
    return p


def load_yolo(name: str, shared: bool = True):
    from ultralytics import YOLO  # lazy: keeps the rest importable/testable without torch
    path = str(resolve_weights(name))
    if not shared:
        log.info("loading %s (private instance)", name)
        return YOLO(path)
    with _cache_lock:
        if path not in _cache:
            log.info("loading %s (shared)", name)
            _cache[path] = YOLO(path)
        return _cache[path]
