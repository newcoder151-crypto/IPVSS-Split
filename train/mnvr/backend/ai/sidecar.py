"""
sidecar.py — YOLO detection + CLIP embedding microservice for the Railway
mNVR AI pipeline.

Contract (matches backend/api/src/routes/ai.js exactly):
    POST /detect   multipart form: image=<file>, conf=<float, optional>, model=<str, optional>
                   -> { "detections": [ {label, confidence, bbox:[x1,y1,x2,y2]}, ... ],
                        "image_size": [width, height], "model": "<model file used>" }
    GET  /health   -> { "status": "ok", "device": "cpu"|"cuda", "default_model": "..." }

Smart-search additions (used by indexer.py and backend/api/src/routes/smart-search.js):
    POST /embed-image  multipart form: image=<file>
                        -> { "embedding": [float, ...512], "attributes": {...} }
    POST /embed-text    form: text=<str>
                        -> { "embedding": [float, ...512] }
Both embeddings come from the same CLIP model/projection space, so a cosine
similarity between a text embedding and an image embedding is a meaningful
"how well does this crop match this description" score — that's the whole
mechanism smart search relies on.

Run with:  uvicorn sidecar:app --host 0.0.0.0 --port 8000
(this is exactly what start.sh / ai.js already invoke)
"""

import io
import json
import logging
import threading

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from PIL import Image

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("sidecar")

app = FastAPI(title="mNVR YOLO Sidecar")

DEFAULT_MODEL = "yolov8n.pt"

# ── CLIP (smart search) ──────────────────────────────────────────────────────
# Loaded lazily, same pattern as YOLO weights below — a sidecar that only
# ever calls /detect never pays CLIP's load cost.
CLIP_MODEL_NAME = "ViT-B-32"
CLIP_PRETRAINED = "laion2b_s34b_b79k"

_clip = {"model": None, "preprocess": None, "tokenizer": None}
_clip_lock = threading.Lock()

# Small phrase bank used only to derive cheap, human-readable tags
# (attributes.colors / attributes.clothing / attributes.caption) for each
# indexed person crop. This is NOT what ranks search results — the raw
# embedding does that — it's just a readable label to show in the UI and a
# light keyword signal. Kept short on purpose: it's scored against every
# single indexed crop, so its size is a direct multiplier on indexing cost.
_COLORS = ["red", "blue", "green", "yellow", "white", "black", "orange",
           "grey", "brown", "pink", "purple"]
_CLOTHING = ["shirt", "t-shirt", "jacket", "uniform", "coat", "vest",
             "helmet", "cap", "saree", "kurta"]
_ATTRIBUTE_PHRASES = [f"a person wearing a {c} {g}" for c in _COLORS for g in _CLOTHING]
_attribute_text_embeddings = None  # populated on first use, shape [N, dim]


def _get_clip():
    with _clip_lock:
        if _clip["model"] is None:
            import open_clip
            import torch
            log.info("Loading CLIP model: %s / %s", CLIP_MODEL_NAME, CLIP_PRETRAINED)
            model, _, preprocess = open_clip.create_model_and_transforms(
                CLIP_MODEL_NAME, pretrained=CLIP_PRETRAINED
            )
            model = model.to(_device).eval()
            tokenizer = open_clip.get_tokenizer(CLIP_MODEL_NAME)
            _clip["model"] = model
            _clip["preprocess"] = preprocess
            _clip["tokenizer"] = tokenizer
        return _clip["model"], _clip["preprocess"], _clip["tokenizer"]


def _embed_image_pil(pil_img):
    import torch
    model, preprocess, _ = _get_clip()
    with torch.no_grad():
        tensor = preprocess(pil_img).unsqueeze(0).to(_device)
        feat = model.encode_image(tensor)
        feat = feat / feat.norm(dim=-1, keepdim=True)
        return feat[0].cpu().tolist()


def _embed_text_str(text):
    import torch
    model, _, tokenizer = _get_clip()
    with torch.no_grad():
        tokens = tokenizer([text]).to(_device)
        feat = model.encode_text(tokens)
        feat = feat / feat.norm(dim=-1, keepdim=True)
        return feat[0].cpu().tolist()


def _cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return dot / (na * nb) if na and nb else 0.0


def _derive_attributes(image_embedding):
    """Zero-shot-scores a person crop's embedding against the small phrase
    bank above and returns the best color/clothing guess + a caption. This
    is best-effort labeling for the UI, not the search ranking mechanism."""
    global _attribute_text_embeddings
    if _attribute_text_embeddings is None:
        _attribute_text_embeddings = [_embed_text_str(p) for p in _ATTRIBUTE_PHRASES]

    scored = sorted(
        zip(_ATTRIBUTE_PHRASES, _attribute_text_embeddings),
        key=lambda pair: _cosine(image_embedding, pair[1]),
        reverse=True,
    )
    best_phrase, best_emb = scored[0]
    best_score = _cosine(image_embedding, best_emb)
    if best_score < 0.20:
        return {"colors": [], "clothing": [], "caption": None}
    color = next((c for c in _COLORS if c in best_phrase), None)
    clothing = next((g for g in _CLOTHING if g in best_phrase), None)
    return {
        "colors": [color] if color else [],
        "clothing": [clothing] if clothing else [],
        "caption": best_phrase,
        "confidence": round(best_score, 3),
    }

# Loaded ultralytics YOLO models, keyed by weights filename. Loaded lazily on
# first request and cached — avoids paying the load cost (and the ~500MB
# first-run download start.sh warns about) more than once per model.
_models = {}
_models_lock = threading.Lock()
_device = "cpu"


def _get_model(name: str):
    name = name or DEFAULT_MODEL
    with _models_lock:
        if name not in _models:
            from ultralytics import YOLO  # imported lazily so /health works before it's installed/loaded
            log.info("Loading YOLO model: %s", name)
            _models[name] = YOLO(name)
        return _models[name]


@app.on_event("startup")
def _warm_up():
    global _device
    try:
        import torch
        _device = "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        _device = "cpu"
    try:
        _get_model(DEFAULT_MODEL)
    except Exception as e:
        # Don't crash the process if the default weights can't be fetched at
        # startup (e.g. no network yet) — /detect will retry the load and
        # surface a clear error instead of the whole sidecar dying.
        log.warning("Could not pre-load default model %s: %s", DEFAULT_MODEL, e)
    # CLIP is loaded lazily on first /embed-* call, not here — smart search
    # is an optional feature and shouldn't slow down startup for deployments
    # that only use /detect.


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": _device,
        "default_model": DEFAULT_MODEL,
        "loaded_models": list(_models.keys()),
        "clip_loaded": _clip["model"] is not None,
    }


@app.post("/detect")
async def detect(
    image: UploadFile = File(...),
    conf: float = Form(0.35),
    model: str = Form(None),
):
    model_name = model or DEFAULT_MODEL

    try:
        raw = await image.read()
        pil_img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")

    try:
        yolo = _get_model(model_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not load model '{model_name}': {e}")

    try:
        results = yolo.predict(pil_img, conf=conf, verbose=False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference failed: {e}")

    detections = []
    if results:
        r = results[0]
        names = r.names
        for box in r.boxes:
            x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
            detections.append({
                "label": names[int(box.cls[0])],
                "confidence": float(box.conf[0]),
                "bbox": [x1, y1, x2, y2],
            })

    w, h = pil_img.size
    return {
        "detections": detections,
        "image_size": [w, h],
        "model": model_name,
    }


@app.post("/embed-image")
async def embed_image(image: UploadFile = File(...)):
    """Used by indexer.py: embeds a cropped person image for smart search."""
    try:
        raw = await image.read()
        pil_img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")

    try:
        embedding = _embed_image_pil(pil_img)
        attributes = _derive_attributes(embedding)
    except Exception as e:
        log.exception("CLIP image embedding failed")
        raise HTTPException(status_code=500, detail=f"Embedding failed: {e}")

    return {"embedding": embedding, "attributes": attributes}


@app.post("/embed-text")
async def embed_text(text: str = Form(...)):
    """Used by smart-search.js: embeds the descriptive part of a search
    prompt into the same space as /embed-image, for cosine-similarity
    ranking against indexed person crops."""
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    try:
        embedding = _embed_text_str(text[:512])
    except Exception as e:
        log.exception("CLIP text embedding failed")
        raise HTTPException(status_code=500, detail=f"Embedding failed: {e}")
    return {"embedding": embedding}
