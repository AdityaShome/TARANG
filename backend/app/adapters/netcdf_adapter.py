"""
NetCDFAdapter — xarray-based adapter for local NetCDF files and OPeNDAP URLs.

Handles:
  - HYCOM GLBy0.08 (OPeNDAP: tds.hycom.org)
  - INCOIS GODAS (OPeNDAP: las.incois.gov.in)
  - Copernicus Marine (local NetCDF via copernicusmarine download)
  - Any CF-1.6 compliant NetCDF file

Engine priority: netCDF4 > h5netcdf > scipy
DO NOT use PyNIO — unmaintained (§6).

CRITICAL rules enforced here:
  - (§20 Rule 8) Always check local_cache first, fall back to OPeNDAP
  - (§20 Rule 5) Every .sel() is bbox-scoped — never loads a global grid
  - (§8.1) CF metadata extracted once and threaded through
  - (§8.1) depth_levels are non-uniform — snap to nearest, never interpolate
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import numpy as np
import xarray as xr

from backend.app.adapters.base import DataSourceAdapter, CFMetadata, SliceResult, VolumeResult

logger = logging.getLogger("tarang.adapters.netcdf")


class NetCDFAdapter(DataSourceAdapter):
    """
    Adapter for CF-compliant NetCDF datasets accessed either:
      1. As a local file  (local_cache path, preferred for demo stability)
      2. Via OPeNDAP URL  (source_url, requires network)

    All subsetting is lazy — xarray .sel() before .compute(), so only the
    requested bytes travel over the wire / are read from disk.
    """

    def __init__(self, manifest: dict):
        super().__init__(manifest)
        self._depth_levels: list[float] = manifest.get("depth_levels") or []
        self._ds: xr.Dataset | None = None  # lazy-opened dataset

    # ── Internal: resolve the best available source ────────────────────────────
    def _resolve_source(self) -> str:
        """
        Returns the path/URL to open:
        - local_cache if it exists on disk (§20 Rule 8)
        - source_url (OPeNDAP / HTTPS) as fallback
        """
        if self.local_cache:
            local_path = Path(self.local_cache)
            if local_path.exists():
                logger.debug(f"Using local cache: {local_path}")
                return str(local_path)
        logger.warning(
            f"Local cache not found at '{self.local_cache}'. "
            f"Falling back to live OPeNDAP: {self.source_url}. "
            "Run ingest scripts before demo day! (§15)"
        )
        return self.source_url

    def open(self) -> xr.Dataset:
        """Open the dataset lazily. Cached after first open."""
        if self._ds is not None:
            return self._ds

        source = self._resolve_source()
        logger.info(f"Opening dataset: {source}")

        # Engine priority: netCDF4 > h5netcdf > scipy (§6)
        for engine in ["netcdf4", "h5netcdf", "scipy"]:
            try:
                self._ds = xr.open_dataset(
                    source,
                    engine=engine,
                    mask_and_scale=True,   # apply _FillValue masking automatically
                    decode_times=True,
                    chunks={},             # open lazily (dask-backed chunks)
                )
                logger.info(f"Opened with engine '{engine}': {list(self._ds.data_vars)}")
                return self._ds
            except Exception as e:
                logger.debug(f"Engine '{engine}' failed: {e}")
                continue

        raise RuntimeError(
            f"Could not open dataset '{source}' with any available engine "
            "(netCDF4, h5netcdf, scipy). Check installation of netCDF4>=1.6."
        )

    def get_metadata(self) -> dict:
        """
        Return metadata dict driving all frontend selectors.
        CF metadata is sourced from the dataset — never hardcoded.
        """
        ds = self.open()

        # Gather available variables (skip coordinate variables)
        available_vars = []
        cf_meta = {}
        for vname in ds.data_vars:
            var = ds[vname]
            if var.attrs.get("standard_name") or var.attrs.get("long_name"):
                available_vars.append(vname)
                cf_meta[vname] = {
                    "standard_name": var.attrs.get("standard_name", vname),
                    "long_name":     var.attrs.get("long_name", vname),
                    "units":         var.attrs.get("units", "unknown"),
                    "valid_min":     float(var.attrs.get("valid_min", -9999)),
                    "valid_max":     float(var.attrs.get("valid_max",  9999)),
                    "missing_value": float(var.attrs.get("_FillValue", np.nan)),
                }

        # Resolve actual depth levels from dataset, fallback to manifest
        depth_levels = self._resolve_depth_levels(ds)

        # Time range
        time_range = {}
        if "time" in ds.coords:
            times = ds.coords["time"].values
            time_range = {
                "start": str(times[0]),
                "end":   str(times[-1]),
                "steps": int(len(times)),
            }

        return {
            "source_id":          self.manifest["id"],
            "label":              self.manifest.get("label", self.manifest["id"]),
            "available_variables": available_vars,
            "cf_metadata":        cf_meta,
            "depth_levels":       depth_levels,  # non-uniform, explicit list
            "time_range":         time_range,
            "dimensions": {k: int(v) for k, v in ds.sizes.items()},
        }

    def get_slice(
        self,
        variable: str,
        depth_m: float,
        time_idx: int,
        bbox: tuple[float, float, float, float],
    ) -> SliceResult:
        """
        Fetch a 2D (lat, lon) depth-slice at the nearest actual depth level.
        ALL subsetting is done before .compute() — never loads the full grid.
        """
        ds = self.open()
        min_lon, min_lat, max_lon, max_lat = bbox

        # ── Subset to bbox first (smallest possible read) ──────────────────────
        subset = ds[variable].sel(
            lat=slice(min_lat, max_lat),
            lon=slice(min_lon, max_lon),
        )

        # ── Select time step ──────────────────────────────────────────────────
        if "time" in subset.dims:
            subset = subset.isel(time=time_idx)
            time_str = str(ds.coords["time"].values[time_idx])
        else:
            time_str = "static"

        # ── Snap to nearest actual depth level (NON-UNIFORM — §8.1) ──────────
        actual_depth_m = depth_m
        if "depth" in subset.dims or "lev" in subset.dims:
            depth_dim = "depth" if "depth" in subset.dims else "lev"
            subset = subset.sel({depth_dim: depth_m}, method="nearest")
            actual_depth_m = float(subset.coords[depth_dim].values)

        # ── Compute (pulls only the subset bytes) ─────────────────────────────
        arr = subset.values.astype(np.float32)

        # ── Build CF metadata ─────────────────────────────────────────────────
        depth_levels = self._resolve_depth_levels(ds)
        meta = self._extract_cf_meta(ds, variable, depth_levels)
        meta.bounds = {
            "lat": [float(min_lat), float(max_lat)],
            "lon": [float(min_lon), float(max_lon)],
            "depth": [float(actual_depth_m)],
        }

        return SliceResult(
            data=arr,
            meta=meta,
            lat=ds.coords["lat"].sel(lat=slice(min_lat, max_lat)).values.astype(np.float32),
            lon=ds.coords["lon"].sel(lon=slice(min_lon, max_lon)).values.astype(np.float32),
            depth_m=actual_depth_m,
            time_str=time_str,
        )

    def get_volume(
        self,
        variable: str,
        time_idx: int,
        bbox: tuple[float, float, float, float],
    ) -> VolumeResult:
        """
        Fetch the full depth column as 3D (depth, lat, lon) for raymarching.
        This is the largest payload — cache aggressively in Redis.
        Downsamples if the regional cube exceeds GPU-safe resolution limits.
        """
        ds = self.open()
        min_lon, min_lat, max_lon, max_lat = bbox

        # ── bbox subset first ─────────────────────────────────────────────────
        subset = ds[variable].sel(
            lat=slice(min_lat, max_lat),
            lon=slice(min_lon, max_lon),
        )

        # ── time step ─────────────────────────────────────────────────────────
        if "time" in subset.dims:
            subset = subset.isel(time=time_idx)
            time_str = str(ds.coords["time"].values[time_idx])
        else:
            time_str = "static"

        # ── Compute ───────────────────────────────────────────────────────────
        arr = subset.values.astype(np.float32)  # (depth, lat, lon)

        # ── GPU safety: downsample if too large ───────────────────────────────
        # Target: max 64 * 256 * 256 floats ≈ 4M samples for safe WebGL texture
        MAX_GPU_SAMPLES = 64 * 256 * 256
        if arr.size > MAX_GPU_SAMPLES:
            arr = self._downsample_volume(arr, MAX_GPU_SAMPLES)
            logger.info(f"Volume downsampled to shape {arr.shape} for GPU safety")

        depth_levels = self._resolve_depth_levels(ds)
        meta = self._extract_cf_meta(ds, variable, depth_levels)
        meta.bounds = {
            "lat":   [float(min_lat), float(max_lat)],
            "lon":   [float(min_lon), float(max_lon)],
            "depth": [float(depth_levels[0]), float(depth_levels[-1])] if depth_levels else [],
        }

        return VolumeResult(
            data=arr,
            meta=meta,
            lat=ds.coords["lat"].sel(lat=slice(min_lat, max_lat)).values.astype(np.float32),
            lon=ds.coords["lon"].sel(lon=slice(min_lon, max_lon)).values.astype(np.float32),
            time_str=time_str,
        )

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _resolve_depth_levels(self, ds: xr.Dataset) -> list[float]:
        """
        Return actual depth levels from the dataset (preferred) or the manifest.
        Never assume uniform spacing.
        """
        for dim in ("depth", "lev", "z"):
            if dim in ds.coords:
                return [float(v) for v in ds.coords[dim].values]
        # Fallback: use manifest depth_levels
        return self._depth_levels

    @staticmethod
    def _downsample_volume(arr: np.ndarray, max_samples: int) -> np.ndarray:
        """
        Uniform downsampling of a 3D (depth, lat, lon) array to fit GPU limit.
        Uses stride-based slicing — no interpolation, fast, deterministic.
        """
        d, la, lo = arr.shape
        total = d * la * lo
        if total <= max_samples:
            return arr
        # Find the largest stride s such that (d/s)*(la/s)*(lo/s) <= max_samples
        s = 1
        while (d // (s + 1)) * (la // (s + 1)) * (lo // (s + 1)) > max_samples:
            s += 1
        return arr[::s, ::s, ::s]
