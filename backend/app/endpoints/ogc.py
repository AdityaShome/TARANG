"""
GET /api/ogc/endpoints — machine-readable directory of the open-standard data
access URLs TARANG exposes, per registered source.

The PS asks for interoperability via "open standards (OGC WMS/WCS, CF Conventions
for NetCDF)" and "a lightweight REST/OPeNDAP API backend". Those endpoints do
exist — THREDDS serves OPeNDAP/WMS/WCS/NCSS for every catalogued NetCDF, and the
FastAPI app serves a hand-rolled OGC WMS/WCS (Option B) — but nothing surfaced
them. This endpoint lists them so the UI (and a judge with QGIS) can find them.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter(tags=["OGC"])

# THREDDS base as seen from *outside* the compose network (via the nginx reverse
# proxy). Override with THREDDS_PUBLIC_BASE if deployed elsewhere.
_THREDDS_PUBLIC_BASE = os.getenv("THREDDS_PUBLIC_BASE", "/thredds")


def _thredds_path(manifest: dict) -> str | None:
    """The catalogue urlPath for a source's NetCDF, e.g. 'netcdf/copernicus_marine.nc'.
    Only sources whose file THREDDS actually serves (the data/netcdf/ mount, via the
    NetCDFAdapter) get a THREDDS URL — Argo/glider caches live elsewhere and 404 there.
    """
    cache = (manifest.get("local_cache") or "").replace("\\", "/")
    if manifest.get("adapter") != "NetCDFAdapter":
        return None
    if not cache.endswith(".nc") or "data/netcdf/" not in cache:
        return None
    return f"netcdf/{Path(cache).name}"


@router.get("/ogc/endpoints", summary="List OPeNDAP / OGC WMS / WCS / NCSS URLs per source")
async def ogc_endpoints(request: Request):
    registry = request.app.state.registry
    api_base = str(request.base_url).rstrip("/") + "/api"

    sources = []
    for manifest in registry.all_manifests():
        sid = manifest["id"]
        entry: dict = {
            "id": sid,
            "label": manifest.get("label", sid),
            "standard_name": manifest.get("standard_name", "unknown"),
            "units": manifest.get("units", "unknown"),
            # Hand-rolled OGC (Option B) — always up with the API, no THREDDS needed.
            "wms_option_b": (
                f"{api_base}/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap"
                f"&LAYERS={sid}&CRS=CRS:84&BBOX=58,2,100,26&WIDTH=1024&HEIGHT=768&FORMAT=image/png"
            ),
            "wcs_option_b": (
                f"{api_base}/wcs?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID={sid}"
            ),
        }
        tpath = _thredds_path(manifest)
        if tpath:
            # THREDDS (Option A) — spec-complete, needs the thredds service running.
            # Link the browseable HTML forms, not the raw dodsC/dds endpoints.
            entry["opendap"] = f"{_THREDDS_PUBLIC_BASE}/dodsC/{tpath}.html"
            entry["wms"] = f"{_THREDDS_PUBLIC_BASE}/wms/{tpath}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities"
            entry["wcs"] = f"{_THREDDS_PUBLIC_BASE}/wcs/{tpath}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCapabilities"
            entry["ncss"] = f"{_THREDDS_PUBLIC_BASE}/ncss/grid/{tpath}/dataset.html"
            entry["http_download"] = f"{_THREDDS_PUBLIC_BASE}/fileServer/{tpath}"
        sources.append(entry)

    return JSONResponse({
        "conventions": "CF-1.8",
        "service_catalogs": {
            "wms_capabilities_option_b": f"{api_base}/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities",
            "wcs_capabilities_option_b": f"{api_base}/wcs?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCapabilities",
            "thredds_catalog": f"{_THREDDS_PUBLIC_BASE}/catalog/catalog.html",
        },
        "sources": sources,
    })
