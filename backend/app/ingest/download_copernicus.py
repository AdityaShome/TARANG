#!/usr/bin/env python3
"""
download_copernicus.py — TARANG SIH 2026 PS 26067

Fetches live Copernicus Marine Service data (temperature + salinity) for the
Bay of Bengal demo region (80-100°E, 5-25°N) and writes it to the same
filenames the registry manifests (registry/copernicus_temp.yaml,
registry/copernicus_salinity.yaml) and thredds/catalog.xml expect:

  data/netcdf/copernicus_bob_temp.nc      (variable: thetao)
  data/netcdf/copernicus_bob_salinity.nc  (variable: so)

Requires COPERNICUS_USERNAME / COPERNICUS_PASSWORD (see .env).

Run inside the backend container:
  docker compose exec backend python backend/app/ingest/download_copernicus.py

Or directly on the host (needs `pip install copernicusmarine`):
  python backend/app/ingest/download_copernicus.py
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

# NOT cmems_mod_glo_phy_anfc_0.083deg_P1D-m — that dataset_id only carries surface/derived
# fields (mlotst, zos, sea ice, bottom temp/salinity...), no depth-resolved thetao/so at all.
# Each 3D physics variable is its own dataset_id. Verified directly against the Copernicus
# Marine API (`describe`/`open_dataset` against the old id raised VariableDoesNotExistInTheDataset).
JOBS = [
    ("cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m", "thetao", "copernicus_bob_temp.nc"),
    ("cmems_mod_glo_phy-so_anfc_0.083deg_P1D-m",     "so",     "copernicus_bob_salinity.nc"),
]
BBOX = dict(minimum_longitude=80, maximum_longitude=100, minimum_latitude=5, maximum_latitude=25)

# 8-day analysis window ending today, so the data stays current on re-run.
END = datetime.utcnow()
START = END - timedelta(days=7)

for dataset_id, variable, filename in JOBS:
    out_file = OUT_DIR / filename
    print(f"Downloading {variable} -> {out_file} ...")
    copernicusmarine.subset(
        dataset_id=dataset_id,
        variables=[variable],
        minimum_depth=0,
        maximum_depth=2000,
        start_datetime=START.strftime("%Y-%m-%dT00:00:00"),
        end_datetime=END.strftime("%Y-%m-%dT00:00:00"),
        output_filename=str(out_file),
        username=os.environ.get("COPERNICUS_USERNAME"),
        password=os.environ.get("COPERNICUS_PASSWORD"),
        # copernicusmarine>=2.4: was `overwrite_output_data`; `force_download` was removed.
        overwrite=True,
        **BBOX,
    )
    print(f"  done: {out_file}")

print("All Copernicus downloads complete.")
