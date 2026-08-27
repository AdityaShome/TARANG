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

    # ── Internal: does the local cache actually cover this request? ────────────
    def _local_cache_covers(self, bbox: tuple[float, float, float, float] | None) -> bool:
        """
        True if local_cache exists on disk AND either we don't know its extent
        (local_cache_bbox unset — assume it's a global/full-coverage file) or the
        requested bbox falls inside the known extent. A researcher searching a sea
        outside a regional pre-download must NOT silently get that region's data back.
        """
        if not self.local_cache or not Path(self.local_cache).exists():
            return False
        if bbox is None or self.local_cache_bbox is None:
            return True
        min_lon, min_lat, max_lon, max_lat = bbox
        c_min_lon, c_min_lat, c_max_lon, c_max_lat = self.local_cache_bbox
        eps = 0.01  # degrees — avoid float-boundary flapping right at the cached edge
        return (
            c_min_lon - eps <= min_lon and max_lon <= c_max_lon + eps and
            c_min_lat - eps <= min_lat and max_lat <= c_max_lat + eps
        )

    def _open_local_or_configured_url(self, use_local: bool, override_path: str | None = None) -> xr.Dataset:
        source = override_path if override_path is not None else (self.local_cache if use_local else self.source_url)
        if use_local:
            logger.debug(f"Using local cache: {source}")
        logger.info(f"Opening dataset: {source}")

        # Engine priority: netCDF4 > h5netcdf > scipy (§6)
        for engine in ["netcdf4", "h5netcdf", "scipy"]:
            try:
                ds = xr.open_dataset(
                    source,
                    engine=engine,
                    mask_and_scale=True,
                    decode_times=True,
                    # No chunks parameter, let xarray manage memory without dask
                )
                logger.info(f"Opened with engine '{engine}': {list(ds.data_vars)}")
                return ds
            except Exception as e:
                logger.debug(f"Engine '{engine}' failed: {e}")
                continue

        raise RuntimeError(
            f"Could not open dataset '{source}' with any available engine "
            "(netCDF4, h5netcdf, scipy). Check installation of netCDF4>=1.6."
        )

    def _open_live_copernicus(self, bbox: tuple[float, float, float, float]) -> xr.Dataset:
        """
        Bbox-scoped fetch straight from Copernicus Marine — this is what makes an arbitrary
        sea search actually work, instead of only ever returning whatever region happened to
        be pre-downloaded into local_cache.

        Deliberately uses subset() (small server-side-prepared download to a cache file), NOT
        open_dataset() (lazy zarr) + .values(): measured directly against this exact dataset,
        subset() for a 20x20 degree region completed in ~22s, while open_dataset() followed by
        forcing computation on even one time/depth slice hung for 5+ minutes — this backend's
        ARCO/zarr chunk layout makes byte-range reads pathologically slow for small selections,
        while its own subset/download path is server-optimized and fast. subset() is also the
        exact method backend/app/ingest/download_copernicus.py already uses successfully.
        """
        import copernicusmarine
        from datetime import datetime, timedelta

        min_lon, min_lat, max_lon, max_lat = bbox

        # Cache by rounded bbox + variable, so re-querying the same searched region (different
        # depth/time-step/render-mode) within a session reuses the file instead of re-fetching.
        cache_key = f"live_{self.variable}_{min_lon:.1f}_{min_lat:.1f}_{max_lon:.1f}_{max_lat:.1f}"
        cache_dir = Path("data/netcdf/live_cache")
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / f"{cache_key}.nc"

        if cache_file.exists():
            logger.info(f"Using cached live fetch: {cache_file}")
            return self._open_local_or_configured_url(use_local=False, override_path=str(cache_file))

        logger.info(
            f"local_cache doesn't cover bbox={bbox}; fetching live from Copernicus Marine "
            f"dataset '{self.live_dataset_id}' -> {cache_file}"
        )
        end = datetime.utcnow()
        # Kept tight on purpose — measured directly: the full depth column (0-6000m, 50 levels)
        # over an 8-day window for a 20x20 degree region downloaded ~100MB and took ~3.5 minutes.
        # That's fine for a background pre-cache job, not for someone waiting on a search result.
        # 0-1000m covers the mixed layer/thermocline (where most near-surface phenomena — and
        # most of a demo's interesting variation — actually live) in a fraction of the levels;
        # 3 days is enough for one representative time step without multiplying the download.
        start = end - timedelta(days=3)
        copernicusmarine.subset(
            dataset_id=self.live_dataset_id,
            variables=[self.variable],
            minimum_longitude=min_lon,
            maximum_longitude=max_lon,
            minimum_latitude=min_lat,
            maximum_latitude=max_lat,
            minimum_depth=0,
            maximum_depth=1000,
            start_datetime=start.strftime("%Y-%m-%dT00:00:00"),
            end_datetime=end.strftime("%Y-%m-%dT00:00:00"),
            output_filename=cache_file.name,
            output_directory=str(cache_dir),
            username=os.environ.get("COPERNICUS_USERNAME"),
            password=os.environ.get("COPERNICUS_PASSWORD"),
            overwrite=True,
        )
        return self._open_local_or_configured_url(use_local=False, override_path=str(cache_file))

    def open(self, bbox: tuple[float, float, float, float] | None = None) -> xr.Dataset:
        """Open the dataset lazily. Never cached on self — xarray + netCDF4 isn't thread-safe,
        so we open fresh on every request."""
        if self._local_cache_covers(bbox):
            return self._open_local_or_configured_url(use_local=True)
        if self.live_dataset_id and bbox is not None:
            try:
                return self._open_live_copernicus(bbox)
            except Exception as e:
                logger.warning(f"Live Copernicus fetch failed ({e}); falling back to source_url")
        logger.warning(
            f"Local cache not found/doesn't cover bbox at '{self.local_cache}'. "
            f"Falling back to configured source: {self.source_url}. "
        )
        return self._open_local_or_configured_url(use_local=False)

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
        ds = self.open(bbox)
        min_lon, min_lat, max_lon, max_lat = bbox

        lat_dim = "latitude" if "latitude" in ds.dims else "lat"
        lon_dim = "longitude" if "longitude" in ds.dims else "lon"
        # ── Subset to bbox first (smallest possible read) ──────────────────────
        subset = ds[variable].sel(**{
            lat_dim: slice(min_lat, max_lat),
            lon_dim: slice(min_lon, max_lon),
        })

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

        # ── Build CF metadata ─────────────────────────────────────────────────
        depth_levels = self._resolve_depth_levels(ds)
        meta = self._extract_cf_meta(ds, variable, depth_levels)
        
        # ── Compute (pulls only the subset bytes) and replace NaNs ────────────
        arr = subset.values.astype(np.float32)
        # mask_and_scale=True replaces missing data with NaN. We must convert it back
        # to a numerical value so WebGL can correctly compare and discard land pixels.
        arr = np.nan_to_num(arr, nan=meta.missing_value)
        meta.bounds = {
            "lat": [float(min_lat), float(max_lat)],
            "lon": [float(min_lon), float(max_lon)],
            "depth": [float(actual_depth_m)],
        }

        return SliceResult(
            data=arr,
            meta=meta,
            lat=ds.coords[lat_dim].sel(**{lat_dim: slice(min_lat, max_lat)}).values.astype(np.float32),
            lon=ds.coords[lon_dim].sel(**{lon_dim: slice(min_lon, max_lon)}).values.astype(np.float32),
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
        ds = self.open(bbox)
        min_lon, min_lat, max_lon, max_lat = bbox

        lat_dim = "latitude" if "latitude" in ds.dims else "lat"
        lon_dim = "longitude" if "longitude" in ds.dims else "lon"
        # ── bbox subset first ─────────────────────────────────────────────────
        subset = ds[variable].sel(**{
            lat_dim: slice(min_lat, max_lat),
            lon_dim: slice(min_lon, max_lon),
        })

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
            lat=ds.coords[lat_dim].sel(**{lat_dim: slice(min_lat, max_lat)}).values.astype(np.float32),
            lon=ds.coords[lon_dim].sel(**{lon_dim: slice(min_lon, max_lon)}).values.astype(np.float32),
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
