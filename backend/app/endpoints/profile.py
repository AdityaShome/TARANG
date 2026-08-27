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

# HDF5 (which the Argo .nc files are stored in) isn't safe for concurrent access from multiple
# threads without a thread-safe build — two profile requests landing close together (each run
# via loop.run_in_executor's default thread pool) can open the same file at the same time and
# raise a raw "HDF error" from deep inside the C library. This has a real trigger, not just a
# theoretical one: the frontend's dedupe() helper retries a request whose in-flight promise was
# aborted by a caller that gave up (e.g. React StrictMode's mount->cleanup->mount) — but the
# ABORTED request's server-side work keeps running to completion regardless (FastAPI doesn't
# cancel a background thread just because the client disconnected), so it can genuinely overlap
# with the retry's own file access. Serialize local-cache reads so that can't happen.
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
        # Check local Argo cache first (§20 Rule 8). A platform can be in any of the per-region
        # cache files argo_ingest.py produces (data/argo/*.nc) — there's no fixed mapping from
        # platform_id to file, so try each until one actually contains it, rather than hardcoding
        # a single filename (the previous hardcoded "BoB_argo_2026-08.nc" meant every platform
        # from any OTHER region's cache file 404'd, and didn't match what argo_ingest.py even
        # names its output files).
        import glob
        import os

        cache_dir = os.path.join(os.getenv("DATA_DIR", "data"), "argo")
        cache_files = sorted(glob.glob(os.path.join(cache_dir, "*.nc")))

        with _argo_cache_lock:
            for cache_path in cache_files:
                try:
                    return _load_from_local_cache(cache_path, platform_id)
                except ValueError:
                    continue  # platform not in this file — try the next one

        logger.warning(
            f"Platform {platform_id} not found in any local cache under '{cache_dir}'. "
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
    """
    Load a profile from a locally cached Argo NetCDF file.

    Every Argo cache file this pipeline has actually produced (via argo_ingest.py's ERDDAP
    tabledap fetch, or an argopy point export) is a FLAT per-measurement table — one row per
    (float, cycle, depth level), indexed by a bare dimension ("row" or "N_POINTS"), not the
    classic multi-profile format (N_PROF dimension) this function originally assumed. That
    mismatch meant ds.dims.get("N_PROF", 0) was always 0 and EVERY platform 404'd regardless of
    ID. Column names also vary by source (lowercase from ERDDAP, UPPERCASE from argopy) — see
    the identical resolution helper in argo_ingest.py's ingest_to_postgis().
    """
    import xarray as xr
    import numpy as np
    ds = xr.open_dataset(cache_path)

    def _col(*candidates: str) -> str | None:
        return next((c for c in candidates if c in ds.variables), None)

    col_platform = _col("platform_number", "PLATFORM_NUMBER")
    col_cycle    = _col("cycle_number", "CYCLE_NUMBER")
    col_pres     = _col("pres", "PRES")
    col_temp     = _col("temp", "TEMP")
    col_psal     = _col("psal", "PSAL")
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

    # Multiple profiles (cycles) for this float can be in the file — use the most recent one,
    # not an arbitrary/first row, so the chart reflects the float's latest known state.
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
