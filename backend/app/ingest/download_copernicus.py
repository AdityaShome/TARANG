#!/usr/bin/env python3
"""
download_copernicus.py — TARANG SIH 2026 PS 26067

Fetches LIVE Copernicus Marine Service data (temperature, salinity, currents) for
India's full EEZ / northern Indian Ocean (58-100°E, 2-26°N) and writes it to the
filenames the registry manifests and thredds/catalog.xml expect:

  data/netcdf/copernicus_bob_temp.nc      (variable: thetao)
  data/netcdf/copernicus_bob_salinity.nc  (variable: so)
  data/netcdf/copernicus_currents.nc      (variables: uo, vo)
  data/netcdf/copernicus_chlorophyll.nc   (variable: chl)

This is REAL model output — the global analysis/forecast product at 1/12° (~9 km).
Run it before demo day; the app then serves these files even with OFFLINE_MODE=true.

Requires COPERNICUS_USERNAME / COPERNICUS_PASSWORD (see .env).

Run inside the backend container:
  docker compose exec backend python backend/app/ingest/download_copernicus.py

Swapping in real INCOIS model files later: just drop a CF-compliant NetCDF into
data/netcdf/ and point the matching registry/*.yaml `local_cache` at it — no code change.
"""

import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

try:
    import copernicusmarine
except ImportError:
    print("copernicusmarine not installed. `pip install copernicusmarine`")
    sys.exit(1)

OUT_DIR = Path(os.getenv("DATA_DIR", "data")) / "netcdf"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def _compress(path: Path):
    """zlib-compress + float32 in place — the raw EEZ subsets are ~200 MB/var otherwise."""
    try:
        import xarray as xr
        ds = xr.open_dataset(path).load()
        enc = {v: {"zlib": True, "complevel": 4, "dtype": "float32"} for v in ds.data_vars}
        tmp = path.with_suffix(".tmp")
        ds.to_netcdf(tmp, encoding=enc)
        ds.close()
        tmp.replace(path)
        print(f"  compressed → {path.stat().st_size/1e6:.0f} MB")
    except Exception as e:
        print(f"  (compression skipped: {e})")

# Each 3D physics variable is its own dataset_id in the CMEMS global analysis-forecast
# product (the bundled *_anfc_0.083deg_P1D-m id only carries surface/derived fields).
# Verified directly against the Copernicus Marine API.
JOBS = [
    ("cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m", ["thetao"],     "copernicus_bob_temp.nc"),
    ("cmems_mod_glo_phy-so_anfc_0.083deg_P1D-m",     ["so"],         "copernicus_bob_salinity.nc"),
    ("cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m",    ["uo", "vo"],   "copernicus_currents.nc"),
    ("cmems_mod_glo_bgc-pft_anfc_0.25deg_P1D-m",     ["chl"],        "copernicus_chlorophyll.nc"),
]
BBOX = dict(minimum_longitude=58, maximum_longitude=100, minimum_latitude=2, maximum_latitude=26)

# 8-day analysis window ending today, so the data stays current on re-run.
END = datetime.utcnow()
START = END - timedelta(days=7)

failed = []
for dataset_id, variables, filename in JOBS:
    out_file = OUT_DIR / filename
    print(f"Downloading {variables} -> {out_file} ...")
    try:
        copernicusmarine.subset(
            dataset_id=dataset_id,
            variables=variables,
            minimum_depth=0,
            maximum_depth=2000,
            start_datetime=START.strftime("%Y-%m-%dT00:00:00"),
            end_datetime=END.strftime("%Y-%m-%dT00:00:00"),
            output_filename=str(out_file),
            username=os.environ.get("COPERNICUS_USERNAME"),
            password=os.environ.get("COPERNICUS_PASSWORD"),
            overwrite=True,
            **BBOX,
        )
        print(f"  done: {out_file}")
        _compress(out_file)
    except Exception as e:
        print(f"  FAILED: {type(e).__name__}: {e}")
        failed.append(filename)

if failed:
    print(f"\n{len(failed)} download(s) failed: {failed}")
    print("The app falls back to the synthetic fixtures for those (generate_fixtures.py).")
    sys.exit(1)

# Merge T/S/currents into one multi-variable file — this is the `copernicus_marine` registry
# source, whose Variable selector switches between thetao / so / uo / vo (like hycom_bob).
try:
    import xarray as xr
    parts = [xr.open_dataset(OUT_DIR / f) for f in
             ("copernicus_bob_temp.nc", "copernicus_bob_salinity.nc", "copernicus_currents.nc")]
    merged = xr.merge(parts, compat="override", join="override")
    merged.attrs.update(title="Copernicus Marine analysis-forecast — India EEZ (T/S/currents)",
                        institution="Copernicus Marine Service")
    enc = {v: {"zlib": True, "complevel": 4, "dtype": "float32"} for v in merged.data_vars}
    merged.to_netcdf(OUT_DIR / "copernicus_marine.nc", encoding=enc)
    print(f"  merged → copernicus_marine.nc  vars={list(merged.data_vars)}")
except Exception as e:
    print(f"  merge skipped: {e}")

print("\nAll Copernicus downloads complete.")
