"""
GET /api/metadata?source=<id>

Returns available variables, CF units, non-uniform depth levels, time range.
This endpoint drives ALL frontend selectors — it must respond before anything renders.
Cached in Redis for 1 hour (metadata rarely changes).
"""

from __future__ import annotations
import logging
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from backend.app.cache import TTL_METADATA

logger = logging.getLogger("tarang.endpoint.metadata")
router = APIRouter(tags=["metadata"])


@router.get("/metadata")
async def get_metadata(source: str, request: Request):
    """
    Returns:
      {
        "source_id": "hycom_water_temp",
        "label": "HYCOM — Water Temperature",
        "available_variables": ["water_temp", "salinity", ...],
        "cf_metadata": { "water_temp": { "units": "degC", "standard_name": ..., ... } },
        "depth_levels": [0, 2, 4, 6, ..., 5000],   ← NON-UNIFORM, explicit list
        "time_range": { "start": "...", "end": "...", "steps": 8 },
        "dimensions": { "time": 8, "depth": 40, "lat": 850, "lon": 1500 }
      }
    """
    registry  = request.app.state.registry
    cache     = request.app.state.cache

    # ── Validate source ───────────────────────────────────────────────────────
    try:
        adapter = registry.get_adapter(source)
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown source '{source}'. Available: {list(registry.manifest_ids())}"
        )

    # ── Cache check ───────────────────────────────────────────────────────────
    cache_key = cache.metadata_key(source)

    async def compute():
        import orjson
        meta = adapter.get_metadata()
        return orjson.dumps(meta)

    raw = await cache.get_or_compute(cache_key, TTL_METADATA, compute)
    import orjson
    return JSONResponse(content=orjson.loads(raw))


@router.get("/sources")
async def list_sources(request: Request):
    """List all registered data source IDs and labels. Used to populate the source dropdown."""
    registry = request.app.state.registry
    sources = [
        {"id": m["id"], "label": m.get("label", m["id"]), "render_type": m.get("render_type", "slice")}
        for m in registry.all_manifests()
    ]
    return JSONResponse(content={"sources": sources})
