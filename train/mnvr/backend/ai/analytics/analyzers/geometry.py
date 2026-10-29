"""Zone helpers shared by analyzers. Zones are stored as NORMALIZED 0..1 [x, y] points so they
survive a change of stream resolution."""
import cv2
import numpy as np


def parse_polygon(poly, name="polygon"):
    if not isinstance(poly, list) or len(poly) < 3:
        raise ValueError(f"{name} needs at least 3 [x, y] points")
    pts = []
    for p in poly:
        if not (isinstance(p, (list, tuple)) and len(p) == 2
                and all(isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1 for v in p)):
            raise ValueError(f"{name} points must be [x, y] normalized to 0..1")
        pts.append([float(p[0]), float(p[1])])
    return np.array(pts, dtype=np.float32)


def to_pixels(poly_norm, width, height):
    return (poly_norm * np.array([width, height], dtype=np.float32)).astype(np.int32)


def inside(poly_px, x, y) -> bool:
    return cv2.pointPolygonTest(poly_px, (float(x), float(y)), False) >= 0
