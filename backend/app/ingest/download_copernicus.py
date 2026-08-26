#!/usr/bin/env python3
import os
import sys

try:
    import copernicusmarine
except ImportError:
    print("copernicusmarine not installed")
    sys.exit(1)

out_dir = "/app/data/netcdf"
os.makedirs(out_dir, exist_ok=True)
out_file = os.path.join(out_dir, "copernicus_temp.nc")

print("Downloading Copernicus data...")
copernicusmarine.subset(
    dataset_id="cmems_mod_glo_phy_anfc_0.083deg_P1D-m",
    variables=["thetao"],
    minimum_longitude=80,
    maximum_longitude=100,
    minimum_latitude=5,
    maximum_latitude=25,
    minimum_depth=0,
    maximum_depth=2000,
    start_datetime="2024-01-01",  # Recent past to ensure data exists
    end_datetime="2024-01-05",
    output_filename=out_file,
    force_download=True,
    username=os.environ.get("COPERNICUS_USERNAME"),
    password=os.environ.get("COPERNICUS_PASSWORD"),
    overwrite_output_data=True
)
print("Done!")
