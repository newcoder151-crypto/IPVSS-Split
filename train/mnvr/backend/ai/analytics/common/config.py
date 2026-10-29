"""Environment-driven settings. Reads backend/ai/analytics/.env if present."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv(ROOT / ".env")

API_URL = os.environ.get("API_URL", "http://localhost:3001").rstrip("/")

# Deliberately NO default password (unlike indexer.py). Use a dedicated
# API_CLIENT account, not "admin".
ANALYTICS_USER = os.environ.get("ANALYTICS_USER", "")
ANALYTICS_PASS = os.environ.get("ANALYTICS_PASS", "")

MEDIAMTX_RTSP = os.environ.get("MEDIAMTX_RTSP", "localhost:8554")

# Must match the API's STORAGE_PATH (the API default is /storage).
STORAGE_PATH = Path(os.environ.get("STORAGE_PATH", "/storage"))
EVENT_SNAPS_PATH = STORAGE_PATH / "event_snaps"

MODELS_DIR = Path(os.environ.get("ANALYTICS_MODELS_DIR", str(ROOT / "models")))

POLL_CONFIG_SECS = int(os.environ.get("POLL_CONFIG_SECS", "30"))
DEVICE = os.environ.get("ANALYTICS_DEVICE", "cpu")
# 0 = leave torch's default. On a shared CPU box, cap this so inference
# doesn't starve the API / stream-manager / sidecar.
TORCH_THREADS = int(os.environ.get("TORCH_THREADS", "0"))
# How often each analyzer logs its timing summary (seconds).
STATS_INTERVAL_SEC = float(os.environ.get("STATS_INTERVAL_SEC", "60"))
# A camera's analytics thread that dies on its own (analyzers disabled after repeated failures)
# is retried only after this cool-off, not on every 30 s config poll.
RESTART_COOLOFF_SEC = float(os.environ.get("ANALYTICS_RESTART_COOLOFF_SEC", "120"))