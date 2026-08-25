"""Adapter package — re-exports for convenience."""
from backend.app.adapters.base import DataSourceAdapter, CFMetadata, SliceResult, VolumeResult
from backend.app.adapters.netcdf_adapter import NetCDFAdapter
from backend.app.adapters.delimited_text_adapter import DelimitedTextAdapter
from backend.app.adapters.argo_adapter import ArgoAdapter

ADAPTER_REGISTRY: dict[str, type[DataSourceAdapter]] = {
    "NetCDFAdapter":        NetCDFAdapter,
    "DelimitedTextAdapter": DelimitedTextAdapter,
    "ArgoAdapter":          ArgoAdapter,
}

__all__ = [
    "DataSourceAdapter", "CFMetadata", "SliceResult", "VolumeResult",
    "NetCDFAdapter", "DelimitedTextAdapter", "ArgoAdapter", "ADAPTER_REGISTRY",
]
