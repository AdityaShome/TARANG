"""
Backend Test Suite — Phase 0 smoke tests.

Run: pytest backend/tests/ -v

Tests:
  1. Registry loads all YAML manifests
  2. NetCDFAdapter opens the fixture dataset
  3. /api/metadata returns valid JSON with depth_levels
  4. /api/slice returns binary (correct content-type + parseable header)
  5. /api/health returns 200
  6. Binary response header is valid JSON with required fields
"""

import io
import json
import struct
import sys
import os
from pathlib import Path

import numpy as np
import pytest

# Ensure the project root is on the path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def fixture_nc_path(tmp_path_factory):
    """Create a tiny synthetic NetCDF file for testing (no network required)."""
    try:
        import xarray as xr
    except ImportError:
        pytest.skip("xarray not installed")

    tmp = tmp_path_factory.mktemp("data")
    nc_path = tmp / "fixture_air.nc"

    # Build a minimal CF-compliant ocean NetCDF in memory
    lat = np.linspace(5, 25, 20, dtype=np.float32)
    lon = np.linspace(80, 100, 40, dtype=np.float32)
    depth = np.array([0, 10, 50, 100, 200, 500], dtype=np.float32)
    time = np.array([0, 1, 2], dtype=np.float64)

    rng = np.random.default_rng(42)
    water_temp = rng.uniform(5, 35, size=(len(time), len(depth), len(lat), len(lon))).astype(np.float32)

    ds = xr.Dataset({
        "water_temp": xr.DataArray(
            data=water_temp,
            dims=["time", "depth", "lat", "lon"],
            coords={"time": time, "depth": depth, "lat": lat, "lon": lon},
            attrs={
                "standard_name": "sea_water_temperature",
                "long_name":     "Water Temperature",
                "units":         "degC",
                "_FillValue":    -30000.0,
                "valid_min":     -5.0,
                "valid_max":     40.0,
            }
        )
    }, attrs={"Conventions": "CF-1.6", "title": "Test fixture"})

    ds.to_netcdf(str(nc_path))
    return str(nc_path)


# ── Registry tests ────────────────────────────────────────────────────────────

def test_registry_loads(tmp_path):
    """Registry loader should load all YAML manifests from registry/."""
    from backend.app.registry.loader import RegistryLoader

    registry_dir = Path(__file__).parent.parent.parent / "registry"
    if not registry_dir.exists():
        pytest.skip("registry/ directory not found")

    loader = RegistryLoader(str(registry_dir))
    loader.load_all()

    ids = list(loader.manifest_ids())
    assert len(ids) >= 1, "Expected at least one manifest"
    assert "hycom_water_temp" in ids, "hycom_water_temp manifest missing"


# ── Adapter tests ─────────────────────────────────────────────────────────────

def test_netcdf_adapter_open(fixture_nc_path):
    """NetCDFAdapter should open the fixture dataset."""
    from backend.app.adapters.netcdf_adapter import NetCDFAdapter

    manifest = {
        "id":           "test_temp",
        "label":        "Test Temperature",
        "adapter":      "NetCDFAdapter",
        "source":       fixture_nc_path,
        "local_cache":  fixture_nc_path,
        "variable":     "water_temp",
        "standard_name": "sea_water_temperature",
        "units":        "degC",
        "valid_min":    -5.0,
        "valid_max":    40.0,
        "missing_value": -30000.0,
        "depth_levels": [0, 10, 50, 100, 200, 500],
    }
    adapter = NetCDFAdapter(manifest)
    ds = adapter.open()
    assert "water_temp" in ds.data_vars
    assert ds.sizes["depth"] == 6


def test_netcdf_adapter_metadata(fixture_nc_path):
    """NetCDFAdapter.get_metadata() should return non-uniform depth_levels."""
    from backend.app.adapters.netcdf_adapter import NetCDFAdapter

    manifest = {
        "id": "test_temp", "label": "Test", "adapter": "NetCDFAdapter",
        "source": fixture_nc_path, "local_cache": fixture_nc_path,
        "variable": "water_temp", "standard_name": "sea_water_temperature",
        "units": "degC", "valid_min": -5.0, "valid_max": 40.0,
        "missing_value": -30000.0, "depth_levels": [0, 10, 50, 100, 200, 500],
    }
    adapter = NetCDFAdapter(manifest)
    meta = adapter.get_metadata()

    assert "depth_levels" in meta
    assert len(meta["depth_levels"]) == 6
    assert meta["depth_levels"] == [0.0, 10.0, 50.0, 100.0, 200.0, 500.0]
    assert "water_temp" in meta["cf_metadata"]
    assert meta["cf_metadata"]["water_temp"]["units"] == "degC"


def test_netcdf_adapter_slice(fixture_nc_path):
    """NetCDFAdapter.get_slice() should return float32 array with CF metadata."""
    from backend.app.adapters.netcdf_adapter import NetCDFAdapter

    manifest = {
        "id": "test_temp", "label": "Test", "adapter": "NetCDFAdapter",
        "source": fixture_nc_path, "local_cache": fixture_nc_path,
        "variable": "water_temp", "standard_name": "sea_water_temperature",
        "units": "degC", "valid_min": -5.0, "valid_max": 40.0,
        "missing_value": -30000.0, "depth_levels": [0, 10, 50, 100, 200, 500],
    }
    adapter = NetCDFAdapter(manifest)
    result  = adapter.get_slice("water_temp", depth_m=10, time_idx=0, bbox=(80, 5, 100, 25))

    assert result.data.dtype == np.float32
    assert result.data.ndim  == 2     # (lat, lon)
    assert result.meta.units == "degC"
    assert result.meta.standard_name == "sea_water_temperature"
    # depth must have snapped to an actual level
    assert result.depth_m in [0.0, 10.0, 50.0, 100.0, 200.0, 500.0]


# ── Binary response tests ─────────────────────────────────────────────────────

def test_binary_response_format():
    """make_binary_response() should produce the correct [len][header][body] format."""
    from backend.app.endpoints.binary import make_binary_response

    data   = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)
    header = {
        "variable": "water_temp", "units": "degC",
        "standard_name": "sea_water_temperature",
        "missing_value": -30000.0, "valid_min": -5.0, "valid_max": 40.0,
        "depth_levels": [0, 10, 50], "bounds": {},
    }
    response = make_binary_response(header, data)
    buf = response.body

    # Parse header length
    header_len = struct.unpack("<I", buf[:4])[0]
    parsed_header = json.loads(buf[4:4+header_len])
    body = np.frombuffer(buf[4+header_len:], dtype=np.float32)

    assert parsed_header["variable"] == "water_temp"
    assert parsed_header["units"]    == "degC"
    assert parsed_header["shape"]    == [2, 2]
    assert len(body) == 4
    assert float(body[0]) == pytest.approx(1.0)


# ── FastAPI endpoint smoke tests ──────────────────────────────────────────────

@pytest.fixture
def app_client(fixture_nc_path):
    """Create a test client with the fixture dataset registered, bypassing lifespan."""
    from fastapi.testclient import TestClient
    from backend.app.registry.loader import RegistryLoader
    from backend.app.main import app

    # Build a minimal registry pointing at the fixture
    manifest = {
        "id": "fixture_temp", "label": "Fixture", "adapter": "NetCDFAdapter",
        "source": fixture_nc_path, "local_cache": fixture_nc_path,
        "variable": "water_temp", "standard_name": "sea_water_temperature",
        "units": "degC", "valid_min": -5.0, "valid_max": 40.0,
        "missing_value": -30000.0, "depth_levels": [0, 10, 50, 100, 200, 500],
    }
    from backend.app.adapters.netcdf_adapter import NetCDFAdapter
    adapter = NetCDFAdapter(manifest)

    registry = RegistryLoader.__new__(RegistryLoader)
    registry._manifests = {"fixture_temp": manifest}
    registry._adapters  = {"fixture_temp": adapter}
    registry.manifest_ids   = lambda: iter(registry._manifests.keys())
    registry.all_manifests  = lambda: list(registry._manifests.values())
    registry.get_adapter    = lambda id: registry._adapters[id]
    registry.get_manifest   = lambda id: registry._manifests[id]

    # No-op cache (no Redis needed in tests)
    class NoopCache:
        async def connect(self): pass
        async def close(self): pass
        # metric=... kwarg mirrors the real RedisCache.get_or_compute signature
        # (added in db53db1 for the /metrics last-updated tracking). The no-op cache
        # ignores it — it records no metrics — but must accept it or every
        # slice/volume/isosurface endpoint call raises TypeError under test.
        async def get_or_compute(self, key, ttl, fn, metric=None): return await fn()
        def metadata_key(self, s):    return f"meta:{s}"
        def slice_key(self, *a):      return "slice:test"
        def volume_key(self, *a):     return "volume:test"
        def isosurface_key(self, *a): return "iso:test"

    app.state.registry = registry
    app.state.cache    = NoopCache()
    app.state.db       = None

    # We need to mock RedisCache so the lifespan doesn't try to connect
    from unittest.mock import patch
    patcher1 = patch("backend.app.cache.RedisCache.connect", return_value=None)
    patcher1.start()

    with TestClient(app, raise_server_exceptions=True) as client:
        # Override state again just to be safe
        client.app.state.registry = registry
        client.app.state.cache    = NoopCache()
        client.app.state.db       = None
        yield client

    patcher1.stop()


def test_health(app_client):
    """Health check must return 200."""
    r = app_client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_metadata_endpoint(app_client):
    """Metadata endpoint must return depth_levels and CF metadata."""
    r = app_client.get("/api/metadata?source=fixture_temp")
    assert r.status_code == 200
    data = r.json()
    assert "depth_levels" in data
    assert len(data["depth_levels"]) == 6
    assert "cf_metadata" in data


def test_slice_endpoint_binary(app_client):
    """Slice endpoint must return binary with correct header."""
    r = app_client.get("/api/slice?source=fixture_temp&var=water_temp&depth=10&time=0&bbox=80,5,100,25")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/octet-stream"

    buf = r.content
    header_len = struct.unpack("<I", buf[:4])[0]
    header = json.loads(buf[4:4+header_len])

    assert header["variable"]      == "water_temp"
    assert header["units"]         == "degC"
    assert header["standard_name"] == "sea_water_temperature"
    assert "depth_levels" in header
    assert len(header["shape"])    == 2
