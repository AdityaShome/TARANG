"""
GET /api/profile?platform_id=&time=

Returns depth-vs-variable arrays for one Argo float / glider profile.
Powers the click-to-inspect profile popover chart.

Uses argopy 1.4.0 — pin carefully (§6, §15):
  - Python >= 3.11
  - Incompatible with xarray 2024.3.0–2025.6.1
  - Local cache checked first (§20 Rule 8)
"""

from __future__ import annotations
import asyncio
import logging
import threading
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("tarang.endpoint.profile")
router = APIRouter(tags=["instruments"])

# Serialize local-cache reads: HDF5 isn't safe for concurrent access from multiple threads
# and overlapping profile requests can open the same .nc file at once.
_argo_cache_lock = threading.Lock()


@router.get("/profile")
async def get_profile(
    request:     Request,
    platform_id: str = Query(..., description="Argo float WMO ID or glider ID"),
    time:        str | None = Query(None, description="ISO date filter (optional)"),
):
    """
    Returns:
      {
        "platform_id": "1234567",
        "lat": 12.5, "lon": 88.3,
        "time": "2026-08-01T00:00:00",
        "depth":       [0, 10, 20, 50, 100, ...],
        "temperature": [28.5, 27.2, 26.1, ...],
        "salinity":    [33.5, 34.1, 34.8, ...],
        "units": { "depth": "m", "temperature": "degree_Celsius", "salinity": "psu" }
      }
    """
    loop = asyncio.get_running_loop()

    def fetch_profile():
        # Try every local cache file (data/argo/*.nc + data/glider/*.nc) — no fixed
        # platform_id→file mapping, and _load_from_local_cache resolves either shape.
        import glob
        import os

        data_dir = os.getenv("DATA_DIR", "data")
        cache_files = sorted(
            glob.glob(os.path.join(data_dir, "argo", "*.nc"))
            + glob.glob(os.path.join(data_dir, "glider", "*.nc"))
        )

        with _argo_cache_lock:
            for cache_path in cache_files:
                try:
                    return _load_from_local_cache(cache_path, platform_id)
                except ValueError:
                    continue  # platform not in this file — try the next one

        # Not cached. The live argopy fallback needs internet + argopy (not in
        # requirements.txt). Fail cleanly rather than timing out / raising ImportError.
        offline = os.getenv("OFFLINE_MODE", "false").strip().lower() in ("1", "true", "yes", "on")
        if offline:
            raise ValueError(
                f"Platform {platform_id} not in local cache and OFFLINE_MODE is on — "
                f"run argo_ingest.py / glider_ingest.py with network first."
            )
        try:
            import argopy  # noqa: F401
        except ImportError:
            raise ValueError(
                f"Platform {platform_id} not in local cache and argopy is not installed."
            )
        logger.warning(
            f"Platform {platform_id} not found in any local cache under '{data_dir}'. "
            "Falling back to live argopy query — run argo_ingest.py before demo! (§15)"
        )
        return _load_from_argopy(platform_id)

    try:
        profile_data = await loop.run_in_executor(None, fetch_profile)
    except Exception as e:
        logger.error(f"Profile fetch failed for {platform_id}: {e}")
        return JSONResponse(
            status_code=404,
            content={"error": f"Profile not found for platform {platform_id}: {str(e)}"}
        )

    return JSONResponse(content=profile_data)


def _load_from_local_cache(cache_path: str, platform_id: str) -> dict:
    """Load a profile from a cached flat per-measurement Argo/glider NetCDF."""
    import xarray as xr
    import numpy as np
    ds = xr.open_dataset(cache_path)

    def _col(*candidates: str) -> str | None:
        return next((c for c in candidates if c in ds.variables), None)

    # Argo columns or glider (trajectory/profile_id/depth/temperature/salinity).
    col_platform = _col("platform_number", "PLATFORM_NUMBER", "trajectory", "TRAJECTORY")
    col_cycle    = _col("cycle_number", "CYCLE_NUMBER", "profile_id", "PROFILE_ID")
    col_pres     = _col("pres", "PRES", "pressure", "depth", "DEPTH")
    col_temp     = _col("temp", "TEMP", "temperature", "TEMPERATURE")
    col_psal     = _col("psal", "PSAL", "salinity", "SALINITY")
    col_lat      = _col("latitude", "LATITUDE")
    col_lon      = _col("longitude", "LONGITUDE")
    col_time     = _col("time", "TIME", "JULD")

    if col_platform is None:
        raise ValueError(f"'{cache_path}' has no platform/float ID column")

    mask = ds[col_platform].values.astype(str) == str(platform_id)
    if not mask.any():
        raise ValueError(f"Platform {platform_id} not found in {cache_path}")

    dim = ds[col_platform].dims[0]
    sub = ds.isel({dim: mask})

    # Use the most recent cycle if the file has several for this float.
    if col_cycle is not None:
        cycles = sub[col_cycle].values
        latest_cycle = cycles[np.argmax(cycles)]
        sub = sub.isel({dim: sub[col_cycle].values == latest_cycle})

    # Sort by depth so the chart draws a sane depth-ordered profile, not scan order.
    if col_pres is not None:
        order = np.argsort(sub[col_pres].values)
        sub = sub.isel({dim: order})

    def _values(col: str | None) -> list:
        return sub[col].values.flatten().tolist() if col else []

    lat  = float(sub[col_lat].values.flat[0])  if col_lat  else 0.0
    lon  = float(sub[col_lon].values.flat[0])  if col_lon  else 0.0
    time = str(sub[col_time].values.flat[0])   if col_time else None

    return {
        "platform_id": platform_id,
        "lat": lat,
        "lon": lon,
        "time": time,
        "depth":       _values(col_pres),
        "temperature": _values(col_temp),
        "salinity":    _values(col_psal),
        "units": {
            "depth":       "dbar",
            "temperature": "degree_Celsius",
            "salinity":    "psu",
        }
    }


def _load_from_argopy(platform_id: str) -> dict:
    """Live argopy fetch — fallback only, never called during demo."""
    import argopy
    from argopy import DataFetcher as ArgoDataFetcher

    loader = ArgoDataFetcher(src="gdac").float(int(platform_id))
    ds = loader.to_xarray()

    # Return the most recent profile
    pres  = ds["PRES"].values[-1].tolist()
    temp  = ds["TEMP"].values[-1].tolist()
    psal  = ds["PSAL"].values[-1].tolist()
    lat   = float(ds["LATITUDE"].values[-1])
    lon   = float(ds["LONGITUDE"].values[-1])
    time  = str(ds["TIME"].values[-1])

    return {
        "platform_id": platform_id,
        "lat": lat, "lon": lon, "time": time,
        "depth": pres, "temperature": temp, "salinity": psal,
        "units": {"depth": "dbar", "temperature": "degree_Celsius", "salinity": "psu"},
    }
