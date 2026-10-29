-- ============================================================================
-- PER-CAMERA AI MODEL CONFIGURATION
-- Lets each camera use a different YOLO weights file for detection (e.g. a
-- lighter model on a low-power exterior camera, a heavier one on a door
-- camera where accuracy matters more). Statement is idempotent.
-- ============================================================================

ALTER TABLE cameras
    ADD COLUMN IF NOT EXISTS ai_model TEXT NOT NULL DEFAULT 'yolov8n.pt';

ALTER TABLE cameras
    ADD COLUMN IF NOT EXISTS ai_confidence_threshold NUMERIC(3,2) NOT NULL DEFAULT 0.35;

ALTER TABLE cameras
    ADD COLUMN IF NOT EXISTS ai_detection_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN cameras.ai_model IS
    'Ultralytics YOLO weights filename/path used for this camera''s detections (server/ai/sidecar.py loads it lazily and caches it). Must match one of the options surfaced by GET /api/ai/models.';
COMMENT ON COLUMN cameras.ai_confidence_threshold IS
    'Default confidence threshold (0-1) passed to the YOLO sidecar for this camera''s detections.';
COMMENT ON COLUMN cameras.ai_detection_enabled IS
    'Per-camera kill switch for AI overlay/detection, independent of the camera''s ACTIVE/INACTIVE status.';
