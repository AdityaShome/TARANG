"""
GET /api/isosurface?source=&var=&threshold=&time=&bbox=

Runs skimage.measure.marching_cubes server-side.
Returns verts (Float32Array) + faces (Uint32Array) + normals (Float32Array)
as a multipart binary payload for direct upload to THREE.BufferGeometry.

Algorithm: Lewiner et al. (2003) — method='lewiner' is the default in scikit-image.
Faster, resolves topological ambiguity, returns verts/faces/normals/values.
(§8.5, §6)
"""

from __future__ import annotations
import asyncio
import logging
import struct

import numpy as np
import orjson
from fastapi import APIRouter, HTTPException, Query, Request, Response
from backend.app.cache import TTL_ISOSURFACE
from backend.app.endpoints.binary import parse_bbox

logger = logging.getLogger("tarang.endpoint.isosurface")
router = APIRouter(tags=["data"])


def _build_isosurface_binary(
    verts: np.ndarray,
    faces: np.ndarray,
    normals: np.ndarray,
    header: dict
) -> bytes:
    """
    Binary layout (§8.5):
      [4 bytes: header_len]
      [header_len bytes: JSON header]
      [verts: float32, shape (N,3)]
      [normals: float32, shape (N,3)]
      [faces: uint32, shape (M,3)]

    Header contains:
      n_verts, n_faces, variable, units, threshold, time, ...
    """
    header["n_verts"]  = int(len(verts))
    header["n_faces"]  = int(len(faces))
    header["dtype_verts"]  = "float32"
    header["dtype_faces"]  = "uint32"

    header_bytes = orjson.dumps(header)
    header_len   = struct.pack("<I", len(header_bytes))

    verts_bytes   = verts.astype(np.float32).tobytes()
    normals_bytes = normals.astype(np.float32).tobytes()
    faces_bytes   = faces.astype(np.uint32).tobytes()

    return header_len + header_bytes + verts_bytes + normals_bytes + faces_bytes


@router.get("/isosurface")
async def get_isosurface(
    request:   Request,
    source:    str   = Query(...),
    var:       str   = Query(...),
    threshold: float = Query(..., description="Isosurface level in variable's units"),
    time:      int   = Query(0),
    bbox:      str   = Query("80,5,100,25"),
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

    key = cache.isosurface_key(source, var, threshold, time, bbox_tuple)

    async def compute() -> bytes:
        from skimage import measure

        loop = asyncio.get_running_loop()

        # 1. Fetch volume (checks its own cache)
        vol_result = await loop.run_in_executor(
            None,
            lambda: adapter.get_volume(var, time, bbox_tuple)
        )
        volume = vol_result.data  # (depth, lat, lon) float32

        # 2. Run marching cubes (CPU-bound — thread pool)
        def run_marching_cubes():
            # Replace NaN/fill values with threshold-1 so they're outside the surface
            vol_clean = np.where(np.isfinite(volume), volume, threshold - 1)
            try:
                verts, faces, normals, _ = measure.marching_cubes(
                    vol_clean,
                    level=threshold,
                    method="lewiner",     # Lewiner et al. (2003) — faster, topologically correct
                    allow_degenerate=False,
                )
            except ValueError as e:
                logger.warning(f"marching_cubes returned empty result: {e}")
                return (
                    np.zeros((0, 3), dtype=np.float32),
                    np.zeros((0, 3), dtype=np.uint32),
                    np.zeros((0, 3), dtype=np.float32),
                )
            return verts, faces, normals

        verts, faces, normals = await loop.run_in_executor(None, run_marching_cubes)

        header = {
            **vol_result.meta.to_header_dict(),
            "threshold": threshold,
            "time": vol_result.time_str,
            # Grid shape marching_cubes ran over — verts are in (depth, lat, lon)
            # index space, so the frontend needs these to scale them to physical
            # units (§8.5). volume may have been downsampled — use its actual shape.
            "volume_shape": list(volume.shape),
        }
        return _build_isosurface_binary(verts, faces, normals, header)

    raw = await cache.get_or_compute(key, TTL_ISOSURFACE, compute)
    return Response(content=raw, media_type="application/octet-stream")
