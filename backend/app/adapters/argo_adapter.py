"""
ArgoAdapter — for Argo profile data.
Unlike gridded NetCDF files, Argo data is point-based (N_PROF).
It does not support 2D slices or 3D volume raymarching.
The frontend uses the /api/instruments and /api/profile endpoints for Argo,
but this adapter provides the metadata.
"""

from __future__ import annotations
import logging
from pathlib import Path

import xarray as xr
from backend.app.adapters.base import DataSourceAdapter, CFMetadata, SliceResult, VolumeResult

logger = logging.getLogger("tarang.adapters.argo")


class ArgoAdapter(DataSourceAdapter):
    def __init__(self, manifest: dict):
        super().__init__(manifest)

    def open(self) -> xr.Dataset:
        """
        Open the ingested Argo NetCDF (written by ingest/argo_ingest.py via
        direct ERDDAP requests — see §20 Rule 8). Falls back to source_url
        if no local cache exists.
        """
        source = self.local_cache if self.local_cache and Path(self.local_cache).exists() else self.source_url
        if source == self.source_url:
            logger.warning(
                f"Local cache not found at '{self.local_cache}'. "
                f"Falling back to '{self.source_url}'. Run argo_ingest.py before demo day! (§15)"
            )
        else:
            logger.debug(f"Using local cache: {source}")

        for engine in ["netcdf4", "h5netcdf", "scipy"]:
            try:
                ds = xr.open_dataset(source, engine=engine, mask_and_scale=True, decode_times=True)
                logger.info(f"Opened Argo dataset with engine '{engine}': {list(ds.data_vars)}")
                return ds
            except Exception as e:
                logger.debug(f"Engine '{engine}' failed: {e}")
                continue

        raise RuntimeError(
            f"Could not open Argo dataset '{source}' with any available engine "
            "(netCDF4, h5netcdf, scipy). Check installation of netCDF4>=1.6."
        )

    def get_metadata(self) -> dict:
        variable = self.variable
        return {
            "source_id":           self.manifest["id"],
            "label":               self.manifest.get("label", self.manifest["id"]),
            "available_variables": [variable],
            "cf_metadata": {
                variable: {
                    "standard_name": self.manifest.get("standard_name", variable),
                    "long_name":     self.manifest.get("long_name", variable),
                    "units":         self.manifest.get("units", "unknown"),
                    "valid_min":     self.manifest.get("valid_min", -9999.0),
                    "valid_max":     self.manifest.get("valid_max",  9999.0),
                    "missing_value": self.manifest.get("missing_value", 99999.0),
                }
            },
            "depth_levels": [],
            "time_range":   {},
            "dimensions":   {},
        }

    def get_slice(self, variable: str, depth_m: float, time_idx: int, bbox: tuple[float, float, float, float]) -> SliceResult:
        raise NotImplementedError("Argo data does not support slice endpoints; use /api/instruments")

    def get_volume(self, variable: str, time_idx: int, bbox: tuple[float, float, float, float]) -> VolumeResult:
        raise NotImplementedError("Argo data does not support volume endpoints")
