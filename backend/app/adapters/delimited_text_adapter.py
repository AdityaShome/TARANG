"""
DelimitedTextAdapter — pandas-backed CSV/ASCII ingestion adapter.

Satisfies the "Multi-format ingestion (NetCDF, ASCII)" MVP requirement (§2).
Converts tabular data to xarray-compatible arrays for the same Layer pipeline.

Expected CSV format:
  lat,lon,depth,time,<variable>
  12.5,88.3,0,2026-08-01,0.45
  ...
"""

from __future__ import annotations

import logging
import numpy as np
import pandas as pd
import xarray as xr

from backend.app.adapters.base import DataSourceAdapter, CFMetadata, SliceResult, VolumeResult

logger = logging.getLogger("tarang.adapters.csv")


class DelimitedTextAdapter(DataSourceAdapter):
    """
    Adapter for CSV/ASCII delimited data files.
    Reads into a pandas DataFrame, pivots into a gridded xarray structure
    compatible with the rest of the pipeline.
    """

    def __init__(self, manifest: dict):
        super().__init__(manifest)
        self._df: pd.DataFrame | None = None
        self._ds: xr.Dataset | None = None

    def open(self) -> xr.Dataset:
        """Load CSV and pivot to a minimal xarray Dataset."""
        if self._ds is not None:
            return self._ds

        source = self.local_cache or self.source_url
        logger.info(f"Loading delimited text: {source}")

        df = pd.read_csv(source)

        # Normalise column names to lowercase
        df.columns = [c.lower().strip() for c in df.columns]

        variable = self.variable
        required = {"lat", "lon", variable}
        if not required.issubset(set(df.columns)):
            raise ValueError(
                f"CSV must have columns: {required}. Found: {list(df.columns)}"
            )

        # Build a minimal xarray Dataset from the tabular data
        # Pivot to (lat, lon) grid if depth/time columns not present
        lats = np.sort(df["lat"].unique())
        lons = np.sort(df["lon"].unique())

        # Simple 2D surface grid for now
        grid = df.pivot_table(
            index="lat", columns="lon", values=variable, aggfunc="mean"
        ).reindex(index=lats, columns=lons)

        self._ds = xr.Dataset(
            {variable: xr.DataArray(
                data=grid.values.astype(np.float32),
                coords={"lat": lats, "lon": lons},
                dims=["lat", "lon"],
                attrs={
                    "standard_name": self.manifest.get("standard_name", variable),
                    "long_name":     self.manifest.get("long_name", variable),
                    "units":         self.manifest.get("units", "unknown"),
                    "valid_min":     self.manifest.get("valid_min", float(grid.min().min())),
                    "valid_max":     self.manifest.get("valid_max", float(grid.max().max())),
                    "_FillValue":    self.manifest.get("missing_value", np.nan),
                }
            )}
        )
        return self._ds

    def get_metadata(self) -> dict:
        ds = self.open()
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
                    "valid_min":     float(ds[variable].attrs.get("valid_min", -9999)),
                    "valid_max":     float(ds[variable].attrs.get("valid_max",  9999)),
                    "missing_value": float(ds[variable].attrs.get("_FillValue", np.nan)),
                }
            },
            "depth_levels": self.manifest.get("depth_levels") or [0],
            "time_range":   {},
            "dimensions":   {k: int(v) for k, v in ds.sizes.items()},
        }

    def get_slice(
        self,
        variable: str,
        depth_m: float,
        time_idx: int,
        bbox: tuple[float, float, float, float],
    ) -> SliceResult:
        ds = self.open()
        min_lon, min_lat, max_lon, max_lat = bbox

        subset = ds[variable].sel(
            lat=slice(min_lat, max_lat),
            lon=slice(min_lon, max_lon),
        )
        arr = subset.values.astype(np.float32)

        meta = self._extract_cf_meta(ds, variable, [0])
        meta.bounds = {
            "lat":   [float(min_lat), float(max_lat)],
            "lon":   [float(min_lon), float(max_lon)],
            "depth": [0.0],
        }

        return SliceResult(
            data=arr,
            meta=meta,
            lat=subset.coords["lat"].values.astype(np.float32),
            lon=subset.coords["lon"].values.astype(np.float32),
            depth_m=0.0,
            time_str="static",
        )

    def get_volume(
        self,
        variable: str,
        time_idx: int,
        bbox: tuple[float, float, float, float],
    ) -> VolumeResult:
        # CSV data is 2D surface-only; wrap in a degenerate depth dimension
        slice_result = self.get_slice(variable, 0, time_idx, bbox)
        volume_data = slice_result.data[np.newaxis, :, :]  # (1, lat, lon)

        return VolumeResult(
            data=volume_data,
            meta=slice_result.meta,
            lat=slice_result.lat,
            lon=slice_result.lon,
            time_str=slice_result.time_str,
        )
