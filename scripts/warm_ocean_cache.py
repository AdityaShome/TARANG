"""
warm_ocean_cache.py — pre-fetch every ocean region into the cache at the same size/precision
as the Bay of Bengal box, so any region a researcher searches later loads as fast/"beautifully"
as Bay of Bengal does today.

How it works:
  Bay of Bengal is fast because registry/copernicus_temp.yaml's local_cache_bbox=[80,5,100,25]
  (a 20°x20° box) is a real Copernicus subset already saved to disk. Any OTHER region instead
  falls through to NetCDFAdapter._open_live_copernicus(), which fetches live and only THEN
  caches the result to disk/Redis (see backend/app/adapters/netcdf_adapter.py) — so the first
  search of a new region is always slow.

  This script drives that same live-fetch-and-cache path ahead of time, for every 20°x20° box
  across the world's oceans, by hitting the running backend's real /api/slice endpoint (the
  same one the frontend calls) — NOT the coarse preview endpoint. Each request's result lands
  in both Redis (cache.py) and NetCDFAdapter's on-disk live-fetch cache
  (backend/app/adapters/netcdf_adapter.py's cache_dir), exactly like Bay of Bengal's.

Usage (backend must already be running, e.g. `uvicorn backend.app.main:app --port 8000`):
  python scripts/warm_ocean_cache.py
  python scripts/warm_ocean_cache.py --source copernicus_temp --var thetao --depth 0 --time 0
  python scripts/warm_ocean_cache.py --box-size 20 --sleep 2 --dry-run

Ocean-only boxes are used by default (via global_land_mask, already a project dependency) so
pure-land boxes — which would just fail or return all-missing data — are skipped.
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass

import numpy as np
import requests

try:
    from global_land_mask import globe
except ImportError:
    globe = None


# Bay of Bengal's box (registry/copernicus_temp.yaml's local_cache_bbox) is 20x20 degrees —
# every box this script generates matches that exact size by default.
DEFAULT_BOX_SIZE_DEG = 20.0
DEFAULT_SOURCE = "copernicus_temp"
DEFAULT_VAR = "thetao"
DEFAULT_DEPTH = 0.0
DEFAULT_TIME = 0
DEFAULT_BACKEND = "http://localhost:8000"


@dataclass
class Box:
    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float

    @property
    def center(self) -> tuple[float, float]:
        return (self.min_lat + self.max_lat) / 2, (self.min_lon + self.max_lon) / 2

    def bbox_str(self) -> str:
        return f"{self.min_lon},{self.min_lat},{self.max_lon},{self.max_lat}"


def generate_boxes(box_size_deg: float, min_lat: float = -80.0, max_lat: float = 80.0) -> list[Box]:
    """Tile the globe into box_size_deg x box_size_deg boxes (same shape as Bay of Bengal's)."""
    boxes: list[Box] = []
    lon = -180.0
    while lon < 180.0:
        lat = min_lat
        while lat < max_lat:
            boxes.append(Box(lon, lat, min(lon + box_size_deg, 180.0), min(lat + box_size_deg, max_lat)))
            lat += box_size_deg
        lon += box_size_deg
    return boxes


def is_ocean_box(box: Box, samples_per_axis: int = 5) -> bool:
    """A box counts as 'ocean' if ANY sample point inside it is water — cheap and avoids
    skipping boxes that are mostly land but touch a coastline/bay worth caching."""
    if globe is None:
        return True  # land-mask package unavailable — don't skip anything
    lats = np.linspace(box.min_lat, box.max_lat, samples_per_axis)
    lons = np.linspace(box.min_lon, box.max_lon, samples_per_axis)
    grid_lat, grid_lon = np.meshgrid(lats, lons)
    return bool(np.any(~globe.is_land(grid_lat, grid_lon)))


def warm_box(backend: str, source: str, var: str, depth: float, time_idx: int, box: Box, timeout: float) -> tuple[bool, str]:
    url = f"{backend}/api/slice"
    params = {"source": source, "var": var, "depth": depth, "time": time_idx, "bbox": box.bbox_str()}
    try:
        resp = requests.get(url, params=params, timeout=timeout)
        if resp.status_code == 200:
            return True, f"{resp.status_code} ({len(resp.content)} bytes)"
        return False, f"{resp.status_code} {resp.text[:200]}"
    except requests.RequestException as e:
        return False, str(e)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backend", default=DEFAULT_BACKEND, help="Running backend base URL")
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="Registry source ID")
    parser.add_argument("--var", default=DEFAULT_VAR, help="Variable name")
    parser.add_argument("--depth", type=float, default=DEFAULT_DEPTH, help="Depth in meters")
    parser.add_argument("--time", type=int, default=DEFAULT_TIME, help="Time step index")
    parser.add_argument("--box-size", type=float, default=DEFAULT_BOX_SIZE_DEG, help="Box size in degrees (Bay of Bengal = 20)")
    parser.add_argument("--min-lat", type=float, default=-80.0, help="Skip boxes south of this latitude (polar ice, little ocean data)")
    parser.add_argument("--max-lat", type=float, default=80.0, help="Skip boxes north of this latitude")
    parser.add_argument("--sleep", type=float, default=1.0, help="Seconds to sleep between requests — live Copernicus fetches are rate-sensitive; keep this >=1")
    # A client timeout that's shorter than the backend's actual fetch time does NOT cancel the
    # backend's in-flight work — the script just moves on and fires the NEXT box's live fetch
    # too, so several end up racing for the same 10-connection S3 pool and everything slows
    # down further. Verified directly: an isolated single box took ~4min under today's
    # (unusually slow) Copernicus conditions, so the default must comfortably outlast that.
    parser.add_argument("--timeout", type=float, default=420.0, help="Per-request timeout in seconds — must exceed the slowest expected live fetch, or timed-out boxes pile up as orphaned concurrent server-side fetches")
    parser.add_argument("--include-land", action="store_true", help="Don't skip land-only boxes")
    parser.add_argument("--dry-run", action="store_true", help="List the boxes that would be warmed, without hitting the backend")
    args = parser.parse_args()

    boxes = generate_boxes(args.box_size, args.min_lat, args.max_lat)
    if not args.include_land:
        ocean_boxes = [b for b in boxes if is_ocean_box(b)]
        print(f"{len(boxes)} boxes total, {len(ocean_boxes)} touch ocean (skipping {len(boxes) - len(ocean_boxes)} land-only boxes)")
        boxes = ocean_boxes
    else:
        print(f"{len(boxes)} boxes total (land-only boxes included)")

    if args.dry_run:
        for b in boxes:
            print(f"  {b.bbox_str()}")
        return 0

    ok_count = 0
    fail_count = 0
    for i, box in enumerate(boxes, 1):
        ok, detail = warm_box(args.backend, args.source, args.var, args.depth, args.time, box, args.timeout)
        status = "OK  " if ok else "FAIL"
        print(f"[{i}/{len(boxes)}] {status} bbox={box.bbox_str():<24} {detail}")
        if ok:
            ok_count += 1
        else:
            fail_count += 1
        if i < len(boxes):
            time.sleep(args.sleep)

    print(f"\nDone: {ok_count} cached, {fail_count} failed, out of {len(boxes)} boxes.")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
