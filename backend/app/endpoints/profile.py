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
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("tarang.endpoint.profile")
router = APIRouter(tags=["instruments"])


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
        # Check local Argo cache first (§20 Rule 8)
        import os
        import numpy as np
        local_cache = os.path.join(
            os.getenv("DATA_DIR", "data"), "argo", "BoB_argo_2026-08.nc"
        )

        if os.path.exists(local_cache):
            return _load_from_local_cache(local_cache, platform_id)
        else:
            logger.warning(
                f"Argo local cache not found at '{local_cache}'. "
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
    """Load a profile from a locally cached Argo NetCDF file."""
    import xarray as xr
    ds = xr.open_dataset(cache_path)

    # Filter to the requested float
    if "PLATFORM_NUMBER" in ds:
        mask = ds["PLATFORM_NUMBER"].values.astype(str) == str(platform_id)
        ds = ds.isel(N_PROF=mask)

    if ds.dims.get("N_PROF", 0) == 0:
        raise ValueError(f"Platform {platform_id} not found in local cache")

    # Use the first available profile
    prof = ds.isel(N_PROF=0)

    depth    = prof["PRES"].values.flatten().tolist() if "PRES" in prof else []
    temp     = prof["TEMP"].values.flatten().tolist() if "TEMP" in prof else []
    salinity = prof["PSAL"].values.flatten().tolist() if "PSAL" in prof else []
    lat      = float(prof["LATITUDE"].values)  if "LATITUDE"  in prof else 0.0
    lon      = float(prof["LONGITUDE"].values) if "LONGITUDE" in prof else 0.0

    return {
        "platform_id": platform_id,
        "lat": lat,
        "lon": lon,
        "time": str(prof["JULD"].values) if "JULD" in prof else None,
        "depth":       depth,
        "temperature": temp,
        "salinity":    salinity,
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
