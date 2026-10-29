#!/usr/bin/env python3
"""
indexer.py — Smart Search real-time indexer.

One thread per active camera (same shape as recorder.py): reads that
camera's already-stable, watermarked live path from MediaMTX
(rtsp://<mediamtx>:8554/cam_<id> — the same path the frontend's live view
watches, never the physical camera directly), samples a frame every
SAMPLE_INTERVAL_SECS, and for every person detected in that frame:

  1. crops the person (with a small margin) out of the frame,
  2. asks the sidecar for a CLIP embedding + best-guess attributes,
  3. saves the crop as a thumbnail under STORAGE_PATH/search_thumbs/<camera_id>/,
  4. POSTs the result to the API (POST /api/ai/index-detection).

The API is the only writer of person_detections — this process never talks
to postgres directly, so a bad/misauthenticated indexer can't do anything
the authenticated API route wouldn't otherwise allow.

Run with:  python indexer.py
"""
import io
import logging
import os
import sys
import threading
import time
import uuid
from datetime import datetime

import cv2
import requests
from PIL import Image

API_URL          = os.environ.get("API_URL", "http://localhost:3001")
API_USER         = os.environ.get("API_USER", "admin")
API_PASS         = os.environ.get("API_PASS", "Admin@123")
YOLO_URL         = os.environ.get("YOLO_SIDECAR_URL", "http://localhost:8000")
MEDIAMTX_RTSP    = os.environ.get("MEDIAMTX_RTSP", "localhost:8554")
STORAGE_PATH     = os.environ.get("STORAGE_PATH", "./storage")
THUMBS_PATH      = os.path.join(STORAGE_PATH, "search_thumbs")

SAMPLE_INTERVAL_SECS = float(os.environ.get("SAMPLE_INTERVAL_SECS", "2"))
POLL_CAMERAS_SECS    = int(os.environ.get("POLL_CAMERAS_SECS", "30"))
DETECT_CONF           = float(os.environ.get("INDEXER_DETECT_CONF", "0.45"))
DETECT_MODEL           = os.environ.get("INDEXER_DETECT_MODEL", "yolov8n.pt")
MAX_PEOPLE_PER_FRAME  = int(os.environ.get("INDEXER_MAX_PEOPLE_PER_FRAME", "5"))
CROP_MARGIN_FRAC       = 0.12  # extra margin around each bbox so clothing isn't cropped off

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [INDEXER] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("indexer")

os.makedirs(THUMBS_PATH, exist_ok=True)

# ── Auth (mirrors recorder.py's service-account login) ──────────────────────
_token = None
_token_exp = 0
_token_lock = threading.Lock()


def get_token():
    global _token, _token_exp
    with _token_lock:
        if _token and time.time() < _token_exp:
            return _token
        for attempt in range(120):
            try:
                r = requests.post(
                    f"{API_URL}/api/auth/login",
                    json={"username": API_USER, "password": API_PASS},
                    timeout=10,
                )
                if r.status_code == 200:
                    _token = r.json()["token"]
                    _token_exp = time.time() + 3600 * 20
                    log.info("Authenticated (%s)", API_URL)
                    return _token
                log.warning("Auth attempt %d: HTTP %d", attempt + 1, r.status_code)
            except Exception as e:
                log.warning("Auth attempt %d/120: %s", attempt + 1, e)
            time.sleep(5)
        raise RuntimeError("Could not authenticate to API")


def api_headers():
    return {"Authorization": f"Bearer {get_token()}"}


def fetch_active_cameras():
    try:
        r = requests.get(
            f"{API_URL}/api/cameras", params={"status": "ACTIVE", "limit": 500},
            headers=api_headers(), timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        cams = data.get("cameras", data if isinstance(data, list) else [])
        return [c for c in cams if str(c.get("status", "")).upper() == "ACTIVE"]
    except Exception as e:
        log.warning("Could not fetch camera list: %s", e)
        return []


# ── Sidecar calls ────────────────────────────────────────────────────────────
def jpeg_bytes(bgr_frame, quality=85):
    ok, buf = cv2.imencode(".jpg", bgr_frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        return None
    return buf.tobytes()


def detect_people(jpeg_buf):
    files = {"image": ("frame.jpg", jpeg_buf, "image/jpeg")}
    data = {"conf": str(DETECT_CONF), "model": DETECT_MODEL}
    r = requests.post(f"{YOLO_URL}/detect", files=files, data=data, timeout=15)
    r.raise_for_status()
    dets = r.json().get("detections", [])
    return [d for d in dets if d.get("label") == "person"]


def embed_crop(jpeg_buf):
    files = {"image": ("crop.jpg", jpeg_buf, "image/jpeg")}
    r = requests.post(f"{YOLO_URL}/embed-image", files=files, timeout=15)
    r.raise_for_status()
    return r.json()


def push_detection(camera_id, occurred_at_iso, bbox, confidence, thumb_rel_path, embedding, attributes):
    payload = {
        "camera_id": camera_id,
        "occurred_at": occurred_at_iso,
        "bbox": bbox,
        "confidence": confidence,
        "thumbnail_path": thumb_rel_path,
        "embedding": embedding,
        "attributes": attributes,
    }
    r = requests.post(f"{API_URL}/api/ai/index-detection", json=payload, headers=api_headers(), timeout=15)
    if r.status_code >= 400:
        log.warning("index-detection rejected (HTTP %d): %s", r.status_code, r.text[:300])


# ── Per-camera worker ─────────────────────────────────────────────────────
def camera_worker(camera_id, stop_event):
    rtsp_url = f"rtsp://{MEDIAMTX_RTSP}/cam_{camera_id}"
    cam_thumb_dir = os.path.join(THUMBS_PATH, str(camera_id))
    os.makedirs(cam_thumb_dir, exist_ok=True)
    log.info("[cam %s] worker starting (%s)", camera_id, rtsp_url)

    while not stop_event.is_set():
        cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
        if not cap.isOpened():
            log.warning("[cam %s] could not open stream, retrying in 10s", camera_id)
            time.sleep(10)
            continue

        last_sample = 0.0
        try:
            while not stop_event.is_set():
                ok, frame = cap.read()
                if not ok or frame is None:
                    log.warning("[cam %s] stream read failed, reconnecting", camera_id)
                    break

                now = time.time()
                if now - last_sample < SAMPLE_INTERVAL_SECS:
                    continue  # drain the buffer without processing every frame
                last_sample = now

                h, w = frame.shape[:2]
                frame_jpeg = jpeg_bytes(frame)
                if frame_jpeg is None:
                    continue

                try:
                    people = detect_people(frame_jpeg)
                except Exception as e:
                    log.warning("[cam %s] /detect failed: %s", camera_id, e)
                    continue

                # Cap cost per sampled frame — a packed platform shot doesn't
                # need 40 embeddings, just the most confident handful.
                people.sort(key=lambda d: d.get("confidence", 0), reverse=True)
                occurred_at_iso = datetime.now().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]

                for det in people[:MAX_PEOPLE_PER_FRAME]:
                    x1, y1, x2, y2 = det["bbox"]
                    mw, mh = (x2 - x1) * CROP_MARGIN_FRAC, (y2 - y1) * CROP_MARGIN_FRAC
                    cx1, cy1 = max(0, int(x1 - mw)), max(0, int(y1 - mh))
                    cx2, cy2 = min(w, int(x2 + mw)), min(h, int(y2 + mh))
                    if cx2 <= cx1 or cy2 <= cy1:
                        continue
                    crop = frame[cy1:cy2, cx1:cx2]
                    crop_jpeg = jpeg_bytes(crop, quality=90)
                    if crop_jpeg is None:
                        continue

                    try:
                        emb_res = embed_crop(crop_jpeg)
                    except Exception as e:
                        log.warning("[cam %s] /embed-image failed: %s", camera_id, e)
                        continue

                    fname = f"{uuid.uuid4().hex}.jpg"
                    with open(os.path.join(cam_thumb_dir, fname), "wb") as f:
                        f.write(crop_jpeg)

                    try:
                        push_detection(
                            camera_id, occurred_at_iso, [x1, y1, x2, y2],
                            det.get("confidence"), f"{camera_id}/{fname}",
                            emb_res["embedding"], emb_res.get("attributes", {}),
                        )
                    except Exception as e:
                        log.warning("[cam %s] failed to push detection: %s", camera_id, e)
        finally:
            cap.release()

        if not stop_event.is_set():
            time.sleep(5)  # brief backoff before reconnecting


def main():
    log.info("Smart Search indexer starting — sampling every %.1fs, polling cameras every %ds",
              SAMPLE_INTERVAL_SECS, POLL_CAMERAS_SECS)
    workers = {}  # camera_id -> (thread, stop_event)

    while True:
        cameras = fetch_active_cameras()
        seen_ids = set()
        for cam in cameras:
            cid = cam.get("camera_id")
            if cid is None:
                continue
            seen_ids.add(cid)
            if cid not in workers:
                stop_event = threading.Event()
                t = threading.Thread(target=camera_worker, args=(cid, stop_event), daemon=True)
                workers[cid] = (t, stop_event)
                t.start()

        # Stop workers for cameras that disappeared/went offline.
        for cid in list(workers.keys()):
            if cid not in seen_ids:
                _, stop_event = workers.pop(cid)
                stop_event.set()
                log.info("[cam %s] stopped — no longer active", cid)

        time.sleep(POLL_CAMERAS_SECS)


if __name__ == "__main__":
    main()
