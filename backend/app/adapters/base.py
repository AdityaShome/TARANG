"""
DataSourceAdapter — Abstract base class for all TARANG data source adapters.

Every adapter (NetCDFAdapter, DelimitedTextAdapter, ArgoAdapter, etc.) must
implement this interface. The Layer registry (§9) instantiates adapters by
their string name from the YAML manifest.

Design rule (§20 Rule 6):
  Adding a new sensor = adding a new YAML manifest + potentially a new Adapter
  subclass. NEVER add a new FastAPI endpoint for a new sensor type.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import xarray as xr


@dataclass
class CFMetadata:
    """
    CF Convention metadata extracted from a variable.
    Captured ONCE in the ingestion layer and passed through to every layer above.
    NEVER hand-typed in the frontend (§20 Rule 2, §8.6).
    """
    variable: str
    standard_name: str
    long_name: str
    units: str
    missing_value: float
    valid_min: float
    valid_max: float
    dtype: str = "float32"

    # Non-uniform depth levels — NEVER assume linear spacing (§8.1, §20 Rule 4)
    depth_levels: list[float] = field(default_factory=list)

    # Spatial and temporal bounds of the last loaded subset
    bounds: dict[str, Any] = field(default_factory=dict)

    def to_header_dict(self) -> dict:
        """
        Serialise to the JSON header that travels with every binary response (§8.6).
        This is the dict the frontend reads to drive colorbar labels, units, range.
        """
        return {
            "variable":      self.variable,
            "standard_name": self.standard_name,
            "long_name":     self.long_name,
            "units":         self.units,
            "missing_value": self.missing_value,
            "valid_min":     self.valid_min,
            "valid_max":     self.valid_max,
            "dtype":         self.dtype,
            "depth_levels":  self.depth_levels,
            "bounds":        self.bounds,
        }


@dataclass
class SliceResult:
    """Output of a depth-slice request: a 2D array + CF metadata + shape info."""
    data: np.ndarray          # shape (lat, lon), dtype float32
    meta: CFMetadata
    lat: np.ndarray           # 1D coordinate array
    lon: np.ndarray           # 1D coordinate array
    depth_m: float            # actual depth level used (nearest-matched)
    time_str: str             # ISO 8601 timestamp of the slice


@dataclass
class VolumeResult:
    """Output of a volume request: a 3D array + CF metadata."""
    data: np.ndarray          # shape (depth, lat, lon), dtype float32
    meta: CFMetadata
    lat: np.ndarray
    lon: np.ndarray
    # depth_levels list is in meta.depth_levels (non-uniform)
    time_str: str


class DataSourceAdapter(abc.ABC):
    """
    Abstract base for all TARANG data source adapters.

    Subclasses:
      NetCDFAdapter       — xarray over local NetCDF / OPeNDAP URLs
      DelimitedTextAdapter — pandas CSV/ASCII ingestion
      ArgoAdapter         — argopy 1.4.0 wrapper (Argo GDAC profiles)

    All bbox parameters follow the convention: [minLon, minLat, maxLon, maxLat]
    All requests MUST be bbox-scoped — never load a full global dataset (§20 Rule 5).
    """

    def __init__(self, manifest: dict):
        """
        Args:
            manifest: the parsed YAML manifest dict for this data source.
        """
        self.manifest = manifest
        self.source_url: str = manifest["source"]
        self.local_cache: str = manifest.get("local_cache", "")
        self.variable: str = manifest["variable"]
        # Geographic extent actually covered by local_cache (§20 Rule 8's "cache before you
        # query live" only holds when the request falls inside that cache). [minLon, minLat,
        # maxLon, maxLat]; None means "no known extent" (e.g. a global file, or no local cache).
        self.local_cache_bbox: list[float] | None = manifest.get("local_cache_bbox")
        # Copernicus Marine dataset_id to query live (via copernicusmarine.open_dataset,
        # bbox-scoped, lazy) when a request falls outside local_cache_bbox — lets a researcher
        # search any sea, not just whatever region happens to be pre-downloaded.
        self.live_dataset_id: str | None = manifest.get("live_dataset_id")

    @abc.abstractmethod
    def open(self, bbox: tuple[float, float, float, float] | None = None) -> xr.Dataset:
        """
        Open the data source lazily. Must use the local_cache path if it exists AND covers
        `bbox` (§20 Rule 8 — cache before you query live). Falls back to a live, bbox-scoped
        fetch (via live_dataset_id) or source_url otherwise.
        Returns an xarray Dataset opened lazily (no data pulled yet).
        """

    @abc.abstractmethod
    def get_metadata(self) -> dict:
        """
        Return a JSON-serialisable dict with:
          - available_variables (list of str)
          - dimensions (dict: name → size)
          - cf_metadata (dict: var → CFMetadata.to_header_dict())
          - depth_levels (list of float, non-uniform)
          - time_range (dict: start, end, steps)
        This drives all frontend selectors (VariableSelector, DepthSlider, TimeSlider).
        """

    @abc.abstractmethod
    def get_slice(
        self,
        variable: str,
        depth_m: float,
        time_idx: int,
        bbox: tuple[float, float, float, float],
    ) -> SliceResult:
        """
        Return a 2D (lat, lon) depth-slice at the nearest depth level to depth_m.
        bbox = (minLon, minLat, maxLon, maxLat).
        NEVER load a full global grid — subset first (§20 Rule 5).
        """

    @abc.abstractmethod
    def get_volume(
        self,
        variable: str,
        time_idx: int,
        bbox: tuple[float, float, float, float],
    ) -> VolumeResult:
        """
        Return the full depth column as a 3D (depth, lat, lon) array.
        Used for raymarching. Cache aggressively — this is the largest payload.
        """

    def _extract_cf_meta(self, ds: xr.Dataset, variable: str, depth_levels: list[float]) -> CFMetadata:
        """
        Extract CF attributes from an xarray Dataset variable.
        Called by subclasses — ensures CF metadata is captured once (§8.1).
        """
        var = ds[variable]
        attrs = var.attrs
        # xarray's mask_and_scale=True decoding (used by every adapter's open()) converts
        # _FillValue-marked cells to real NaN in the data AND moves _FillValue/missing_value out
        # of .attrs into .encoding — so after decode, .attrs never has it. Without this fallback,
        # missing_value silently became NaN (via the np.nan default below), which orjson then
        # serializes as JSON `null`, breaking every consumer that compares against it numerically
        # (the frontend's u_missing shader uniform, np.nan_to_num's fill target on the wire).
        missing_value = attrs.get("_FillValue", attrs.get("missing_value", var.encoding.get(
            "_FillValue", var.encoding.get("missing_value", np.nan)
        )))
        return CFMetadata(
            variable=variable,
            standard_name=attrs.get("standard_name", variable),
            long_name=attrs.get("long_name", variable),
            units=attrs.get("units", "unknown"),
            missing_value=float(missing_value),
            valid_min=float(attrs.get("valid_min", float(np.nanmin(var.values[:1])))),
            valid_max=float(attrs.get("valid_max", float(np.nanmax(var.values[:1])))),
            dtype="float32",
            depth_levels=depth_levels,
        )
