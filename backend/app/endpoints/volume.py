"""
GET /api/volume?source=&var=&time=&bbox=

Full depth column as 3D (depth, lat, lon) Float32Array — for raymarching.
Larger payload than slice → longer Redis TTL (10 min).
"""

from __future__ import annotations
import asyncio
import logging
from fastapi import APIRouter, HTTPException, Query, Request, Response
from backend.app.cache import TTL_VOLUME
from backend.app.endpoints.binary import make_binary_response, parse_bbox

logger = logging.getLogger("tarang.endpoint.volume")
router = APIRouter(tags=["data"])


@router.get("/volume")
async def get_volume(
    request: Request,
    source: str   = Query(...),
    var:    str   = Query(...),
    time:   int   = Query(0),
    bbox:   str   = Query("80,5,100,25"),
):
    registry = request.app.state.registry
    cache    = request.app.state.cache

    try:
        adapter = registry.get_adapter(source)
    except KeyError:
        raise HTTPException(404, f"Unknown source '{source}'")

    try:
        bbox_tuple = parse_bbox(bbox)
    except ValueError as e:
        raise HTTPException(400, str(e))

    key = cache.volume_key(source, var, time, bbox_tuple)

    async def compute() -> bytes:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: adapter.get_volume(var, time, bbox_tuple)
        )
        header = {
            **result.meta.to_header_dict(),
            "time": result.time_str,
        }
        resp = make_binary_response(header, result.data)
        return resp.body

    raw = await cache.get_or_compute(key, TTL_VOLUME, compute)
    return Response(content=raw, media_type="application/octet-stream")
