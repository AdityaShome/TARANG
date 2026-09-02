"""
GET /api/eddy?source=&time=&bbox=&threshold=
GET /api/front?source=&var=&time=&bbox=&threshold=
"""
from __future__ import annotations
import asyncio
import logging
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
import numpy as np

from backend.app.endpoints.binary import parse_bbox

logger = logging.getLogger("tarang.endpoint.eddy")
router = APIRouter(tags=["analytics"])

@router.get("/eddy")
async def get_eddy(
    request: Request,
    source: str = Query(..., description="Registry source ID"),
    time: int = Query(0, description="Time step index (0-based)"),
    bbox: str = Query("80,5,100,25", description="minLon,minLat,maxLon,maxLat"),
    threshold: float = Query(2e-11, description="Okubo-Weiss parameter threshold"),
):
    registry = request.app.state.registry
    try:
        adapter = registry.get_adapter(source)
    except KeyError:
        raise HTTPException(404, f"Unknown source '{source}'")

    try:
        bbox_tuple = parse_bbox(bbox)
    except ValueError as e:
        raise HTTPException(400, str(e))

    def compute():
        ds = adapter.open(bbox_tuple)
        min_lon, min_lat, max_lon, max_lat = bbox_tuple
        
        lat_dim = "latitude" if "latitude" in ds.dims else "lat"
        lon_dim = "longitude" if "longitude" in ds.dims else "lon"
        
        subset = ds.sel(**{
            lat_dim: slice(min_lat, max_lat),
            lon_dim: slice(min_lon, max_lon),
        })
        
        if "time" in subset.dims:
            subset = subset.isel(time=time)
            
        if "depth" in subset.dims or "lev" in subset.dims:
            depth_dim = "depth" if "depth" in subset.dims else "lev"
            subset = subset.isel(**{depth_dim: 0})

        if "water_u" not in subset.data_vars or "water_v" not in subset.data_vars:
            raise ValueError(f"Source '{source}' is missing water_u or water_v")

        u = subset["water_u"].values.astype(np.float64)
        v = subset["water_v"].values.astype(np.float64)
        
        lats = subset[lat_dim].values.astype(np.float64)
        lons = subset[lon_dim].values.astype(np.float64)
        
        dy = np.gradient(lats) * 111320.0
        dx = np.gradient(lons) * 111320.0
        
        dy_2d = dy[:, None] * np.ones_like(lons)[None, :]
        dx_2d = dx[None, :] * np.cos(np.radians(lats))[:, None]

        dy_2d = np.where(dy_2d == 0, 1e-6, dy_2d)
        dx_2d = np.where(dx_2d == 0, 1e-6, dx_2d)

        du_dy, du_dx = np.gradient(u)
        dv_dy, dv_dx = np.gradient(v)
        
        du_dy /= dy_2d
        du_dx /= dx_2d
        dv_dy /= dy_2d
        dv_dx /= dx_2d

        s_n = du_dx - dv_dy
        s_s = dv_dx + du_dy
        omega = dv_dx - du_dy
        
        W = s_n**2 + s_s**2 - omega**2
        
        cells = []
        eddy_mask = (W < -threshold) & ~np.isnan(W)
        front_mask = (W > threshold) & ~np.isnan(W)
        
        for i in range(len(lats)):
            for j in range(len(lons)):
                if eddy_mask[i, j]:
                    etype = "warm" if omega[i, j] < 0 else "cold"
                    cells.append({"lat": float(lats[i]), "lon": float(lons[j]), "type": etype, "w_value": float(W[i, j])})
                elif front_mask[i, j]:
                    cells.append({"lat": float(lats[i]), "lon": float(lons[j]), "type": "front", "w_value": float(W[i, j])})
                    
        return cells

    loop = asyncio.get_running_loop()
    try:
        cells = await loop.run_in_executor(None, compute)
    except Exception as e:
        logger.error(f"Eddy computation failed: {e}")
        raise HTTPException(500, f"Computation failed: {e}")

    return JSONResponse(content={"cells": cells})

@router.get("/front")
async def get_front(
    request: Request,
    source: str = Query(..., description="Registry source ID"),
    var: str = Query("water_temp", description="Variable name for gradient (water_temp or salinity)"),
    time: int = Query(0, description="Time step index (0-based)"),
    bbox: str = Query("80,5,100,25", description="minLon,minLat,maxLon,maxLat"),
    threshold: float = Query(0.00005, description="Gradient magnitude threshold"),
):
    registry = request.app.state.registry
    try:
        adapter = registry.get_adapter(source)
    except KeyError:
        raise HTTPException(404, f"Unknown source '{source}'")

    try:
        bbox_tuple = parse_bbox(bbox)
    except ValueError as e:
        raise HTTPException(400, str(e))

    def compute():
        ds = adapter.open(bbox_tuple)
        min_lon, min_lat, max_lon, max_lat = bbox_tuple
        
        lat_dim = "latitude" if "latitude" in ds.dims else "lat"
        lon_dim = "longitude" if "longitude" in ds.dims else "lon"
        
        subset = ds.sel(**{
            lat_dim: slice(min_lat, max_lat),
            lon_dim: slice(min_lon, max_lon),
        })
        
        if "time" in subset.dims:
            subset = subset.isel(time=time)
            
        if "depth" in subset.dims or "lev" in subset.dims:
            depth_dim = "depth" if "depth" in subset.dims else "lev"
            subset = subset.isel(**{depth_dim: 0})

        if var not in subset.data_vars:
            raise ValueError(f"Source '{source}' is missing variable '{var}'")

        data = subset[var].values.astype(np.float64)
        
        lats = subset[lat_dim].values.astype(np.float64)
        lons = subset[lon_dim].values.astype(np.float64)
        
        dy = np.gradient(lats) * 111320.0
        dx = np.gradient(lons) * 111320.0
        
        dy_2d = dy[:, None] * np.ones_like(lons)[None, :]
        dx_2d = dx[None, :] * np.cos(np.radians(lats))[:, None]

        dy_2d = np.where(dy_2d == 0, 1e-6, dy_2d)
        dx_2d = np.where(dx_2d == 0, 1e-6, dx_2d)

        grad_y, grad_x = np.gradient(data)
        grad_mag = np.sqrt((grad_x / dx_2d)**2 + (grad_y / dy_2d)**2)
        
        cells = []
        mask = (grad_mag > threshold) & ~np.isnan(grad_mag)
        
        for i in range(len(lats)):
            for j in range(len(lons)):
                if mask[i, j]:
                    cells.append({"lat": float(lats[i]), "lon": float(lons[j]), "gradient_magnitude": float(grad_mag[i, j])})
                    
        return cells

    loop = asyncio.get_running_loop()
    try:
        cells = await loop.run_in_executor(None, compute)
    except Exception as e:
        logger.error(f"Front computation failed: {e}")
        raise HTTPException(500, f"Computation failed: {e}")

    return JSONResponse(content={"cells": cells})
