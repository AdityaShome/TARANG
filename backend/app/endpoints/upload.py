"""
POST /api/registry/upload — add a new data source from the browser.

The PS asks for ingestion that accepts "new observational data streams or
additional model variables without significant re-engineering". The registry
already does that server-side (drop a YAML in registry/), but there was no way
to do it without shell access to the container.

This endpoint takes a NetCDF or delimited-text file, introspects it (variables,
bbox, depth levels, time steps, CF attributes), writes a registry manifest, and
hot-reloads the registry — so the new source appears in the frontend's source
dropdown within a second, no restart, no code change. That is the "extensible
design" requirement made demoable on stage.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

import numpy as np
import yaml
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

logger = logging.getLogger("tarang.endpoint.upload")
router = APIRouter(tags=["registry"])

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "data/uploads"))
REGISTRY_DIR = Path(os.getenv("REGISTRY_DIR", "registry"))
MAX_BYTES = 256 * 1024 * 1024  # 256 MB — matches nginx client_max_body_size

_NETCDF_EXT = {".nc", ".nc4", ".cdf", ".netcdf"}
_TEXT_EXT = {".csv", ".txt", ".tsv", ".dat"}

_LAT_NAMES = ("latitude", "lat", "nav_lat", "y")
_LON_NAMES = ("longitude", "lon", "nav_lon", "x")
_DEPTH_NAMES = ("depth", "lev", "z", "deptht")


def _slugify(name: str) -> str:
    stem = Path(name).stem.lower()
    slug = re.sub(r"[^a-z0-9]+", "_", stem).strip("_")
    return slug or "uploaded_source"


def _first_present(candidates, names):
    lower = {str(c).lower(): c for c in candidates}
    for n in names:
        if n in lower:
            return lower[n]
    return None


def _introspect_netcdf(path: Path) -> dict:
    import xarray as xr

    last_err = None
    for engine in ("netcdf4", "h5netcdf", "scipy"):
        try:
            ds = xr.open_dataset(path, engine=engine, mask_and_scale=True, decode_times=True)
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            ds = None
    if ds is None:
        raise HTTPException(422, f"Could not open NetCDF with any engine: {last_err}")

    warnings: list[str] = []
    try:
        lat_name = _first_present(ds.coords, _LAT_NAMES) or _first_present(ds.variables, _LAT_NAMES)
        lon_name = _first_present(ds.coords, _LON_NAMES) or _first_present(ds.variables, _LON_NAMES)
        if not lat_name or not lon_name:
            raise HTTPException(422, "No recognisable latitude/longitude coordinate found")

        lat = np.asarray(ds[lat_name].values, dtype=float)
        lon = np.asarray(ds[lon_name].values, dtype=float)
        bbox = [
            round(float(np.nanmin(lon)), 4), round(float(np.nanmin(lat)), 4),
            round(float(np.nanmax(lon)), 4), round(float(np.nanmax(lat)), 4),
        ]

        depth_name = _first_present(ds.coords, _DEPTH_NAMES)
        depth_levels = (
            [round(float(v), 3) for v in np.asarray(ds[depth_name].values, dtype=float)]
            if depth_name is not None else []
        )

        n_times = int(ds.sizes["time"]) if "time" in ds.sizes else 1

        coord_names = {str(c).lower() for c in ds.coords}
        data_vars = [
            v for v in ds.data_vars
            if str(v).lower() not in coord_names and ds[v].ndim >= 2
        ]
        if not data_vars:
            raise HTTPException(422, "NetCDF has no 2-D+ data variables to render")

        # Prefer a CF-annotated variable, else the first.
        primary = next(
            (v for v in data_vars if ds[v].attrs.get("standard_name") or ds[v].attrs.get("long_name")),
            data_vars[0],
        )
        va = ds[primary].attrs

        def _num(attr, fallback):
            try:
                return round(float(attr), 4)
            except (TypeError, ValueError):
                return fallback

        arr = np.asarray(ds[primary].values, dtype="float32")
        finite = arr[np.isfinite(arr)]
        vmin = _num(va.get("valid_min"), round(float(finite.min()), 4) if finite.size else 0.0)
        vmax = _num(va.get("valid_max"), round(float(finite.max()), 4) if finite.size else 1.0)

        return {
            "adapter": "NetCDFAdapter",
            "variable": str(primary),
            "all_variables": [str(v) for v in data_vars],
            "standard_name": va.get("standard_name", str(primary)),
            "long_name": va.get("long_name", str(primary)),
            "units": va.get("units", "unknown"),
            "valid_min": vmin,
            "valid_max": vmax,
            "bbox": bbox,
            "depth_levels": depth_levels,
            "n_times": n_times,
            "render_type": "volume" if depth_levels else "slice",
            "warnings": warnings,
        }
    finally:
        ds.close()


def _introspect_text(path: Path) -> dict:
    import pandas as pd

    try:
        df = pd.read_csv(path, sep=None, engine="python")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, f"Could not parse delimited text: {e}")
    df.columns = [str(c).lower().strip() for c in df.columns]

    lat_col = next((c for c in ("lat", "latitude", "y") if c in df.columns), None)
    lon_col = next((c for c in ("lon", "longitude", "x") if c in df.columns), None)
    if not lat_col or not lon_col:
        raise HTTPException(422, f"CSV needs latitude & longitude columns. Found: {list(df.columns)}")

    depth_col = next((c for c in ("depth", "pres", "pressure", "lev", "z") if c in df.columns), None)
    time_col = next((c for c in ("time", "date", "datetime", "timestamp") if c in df.columns), None)

    reserved = {lat_col, lon_col, depth_col, time_col}
    value_cols = [
        c for c in df.columns
        if c not in reserved and pd.api.types.is_numeric_dtype(df[c])
    ]
    if not value_cols:
        raise HTTPException(422, "CSV has no numeric value column besides coordinates")

    primary = value_cols[0]
    series = df[primary].astype(float)
    depth_levels: list[float] = []
    if depth_col:
        depth_levels = sorted(round(float(d), 3) for d in df[depth_col].dropna().unique())
    return {
        "adapter": "DelimitedTextAdapter",
        "variable": primary,
        "all_variables": value_cols,
        "standard_name": primary,
        "long_name": primary,
        "units": "unknown",
        "valid_min": round(float(series.min()), 4),
        "valid_max": round(float(series.max()), 4),
        "bbox": [
            round(float(df[lon_col].min()), 4), round(float(df[lat_col].min()), 4),
            round(float(df[lon_col].max()), 4), round(float(df[lat_col].max()), 4),
        ],
        "depth_levels": depth_levels,
        "n_times": int(df[time_col].nunique()) if time_col else 1,
        "render_type": "volume" if depth_levels else "slice",
        "warnings": [],
    }


@router.post("/registry/upload", summary="Upload a NetCDF/CSV file and register it as a new source")
async def upload_source(
    request: Request,
    file: UploadFile = File(...),
    label: str | None = Form(None),
    overwrite: bool = Form(False),
):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in _NETCDF_EXT and ext not in _TEXT_EXT:
        raise HTTPException(415, f"Unsupported file type '{ext}'. Accepted: NetCDF (.nc) or delimited text (.csv)")

    slug = _slugify(file.filename or "uploaded_source")
    registry = request.app.state.registry
    existing = set(registry.manifest_ids())
    if slug in existing and not overwrite:
        raise HTTPException(409, f"A source named '{slug}' already exists. Re-upload with overwrite=true to replace it.")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dest = UPLOAD_DIR / f"{slug}{ext}"

    size = 0
    with dest.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_BYTES:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"File exceeds the {MAX_BYTES // (1024*1024)} MB limit")
            out.write(chunk)

    try:
        info = _introspect_netcdf(dest) if ext in _NETCDF_EXT else _introspect_text(dest)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise

    manifest = {
        "id": slug,
        "label": label or f"{file.filename} (uploaded)",
        "description": f"User-uploaded {ext} file, registered via /api/registry/upload.",
        "adapter": info["adapter"],
        "source": str(dest).replace("\\", "/"),
        "local_cache": str(dest).replace("\\", "/"),
        "local_cache_bbox": info["bbox"],
        "variable": info["variable"],
        "standard_name": info["standard_name"],
        "long_name": info["long_name"],
        "units": info["units"],
        "valid_min": info["valid_min"],
        "valid_max": info["valid_max"],
        "colormap": "thermal",
        "render_type": info["render_type"],
        "default_bbox": info["bbox"],
    }
    if info["depth_levels"]:
        manifest["depth_levels"] = info["depth_levels"]

    # ".uploaded.yaml" suffix keeps these runtime manifests out of git (.gitignore)
    # and visually distinct from the hand-authored registry.
    manifest_path = REGISTRY_DIR / f"{slug}.uploaded.yaml"
    header = (
        "# AUTO-GENERATED by POST /api/registry/upload — safe to edit or delete.\n"
        f"# Source file: {dest}\n"
    )
    manifest_path.write_text(header + yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8")

    result = registry.reload()
    if slug not in result.get("sources", []):
        raise HTTPException(500, f"Manifest written but '{slug}' did not load — check server logs")

    logger.info(f"Registered uploaded source '{slug}' ({info['adapter']}, {size} bytes)")
    return JSONResponse({
        "id": slug,
        "label": manifest["label"],
        "adapter": info["adapter"],
        "variable": info["variable"],
        "all_variables": info["all_variables"],
        "bbox": info["bbox"],
        "depth_levels": info["depth_levels"],
        "n_times": info["n_times"],
        "render_type": info["render_type"],
        "warnings": info["warnings"],
    })
