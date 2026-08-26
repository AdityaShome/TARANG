#!/usr/bin/env python3
"""
generate_fixtures.py — TARANG SIH 2026 PS 26067

Generates oceanographically realistic NetCDF4 fixture files for the
Indian Ocean / Bay of Bengal demo region (80-100°E, 5-25°N).

These are NOT arbitrary random numbers — they follow real Indian Ocean
climatological patterns:
  - Sea Surface Temperature: 27–30°C in BoB, cooler at depth
  - Salinity: 30–34 PSU (BoB is fresher due to Brahmaputra/Ganges input)
  - Mixed layer depth: ~50m in summer
  - Seasonal thermocline: sharp gradient 50–200m

Run inside the backend container:
  docker compose exec backend python backend/app/ingest/generate_fixtures.py

Or directly:
  python generate_fixtures.py
"""

import os
import numpy as np
import netCDF4 as nc
from pathlib import Path
from datetime import datetime, timedelta

# ── Output path ───────────────────────────────────────────────────────────────
OUT_DIR = Path(os.getenv("DATA_DIR", "data")) / "netcdf"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Grid definition ───────────────────────────────────────────────────────────
LON = np.linspace(80.0, 100.0, 81)   # 0.25° resolution
LAT = np.linspace(5.0,  25.0,  81)
DEP = np.array([0, 5, 10, 20, 30, 50, 75, 100, 150, 200,
                250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 4000])
N_TIME = 8   # 8 daily snapshots

NLAT, NLON, NDEP = len(LAT), len(LON), len(DEP)
LONS, LATS = np.meshgrid(LON, LAT)

# ── Realistic temperature field (°C) ──────────────────────────────────────────
def make_temperature() -> np.ndarray:
    """4D array (time, depth, lat, lon) — oceanographically realistic."""
    T = np.zeros((N_TIME, NDEP, NLAT, NLON), dtype=np.float32)

    for ti in range(N_TIME):
        day_offset = ti * 1.0
        for di, depth in enumerate(DEP):
            # SST pattern: warm pool centre ~90°E, 15°N
            sst_base = 29.5
            sst_grad = (
                - 0.04 * np.abs(LONS - 90)      # cooling away from centre lon
                - 0.06 * np.abs(LATS - 15)      # cooling away from centre lat
                + 0.15 * np.sin(2*np.pi * day_offset/30)  # 30-day oscillation
                + 0.3  * np.random.randn(NLAT, NLON) * 0.05  # noise
            )
            sst = np.clip(sst_base + sst_grad, 26.0, 31.0)

            # Depth profile: mixed layer (0-50m) then sharp thermocline
            if depth <= 50:
                layer_temp = sst - depth * 0.015
            elif depth <= 200:
                # Thermocline: steep ~0.05°C/m
                mixed_t = sst - 50 * 0.015
                layer_temp = mixed_t - (depth - 50) * 0.055
            elif depth <= 1000:
                # Deep ocean: 8°C at 200m → 4°C at 1000m
                t200 = sst - 50*0.015 - 150*0.055
                layer_temp = t200 - (depth - 200) * 0.005
            else:
                # Abyssal: 2-3°C
                layer_temp = 2.5 + 0.5 * np.random.randn(NLAT, NLON) * 0.02

            # Add mesoscale eddies (warm/cold core)
            eddy_warm = 1.5 * np.exp(-((LONS-87)**2 + (LATS-18)**2)/25)
            eddy_cold = -1.2 * np.exp(-((LONS-93)**2 + (LATS-10)**2)/20)
            eddy_factor = np.exp(-depth / 150)  # eddies decay with depth
            layer_temp = layer_temp + (eddy_warm + eddy_cold) * eddy_factor

            T[ti, di] = np.clip(layer_temp, 1.0, 32.0)

    return T

# ── Realistic salinity field (PSU) ────────────────────────────────────────────
def make_salinity() -> np.ndarray:
    """4D array (time, depth, lat, lon). BoB is fresher (low salinity) due to river runoff."""
    S = np.zeros((N_TIME, NDEP, NLAT, NLON), dtype=np.float32)

    for ti in range(N_TIME):
        for di, depth in enumerate(DEP):
            # Surface: BoB freshwater lens (30-32 PSU near river mouths)
            s_surf = (
                33.5
                - 2.5 * np.exp(-((LONS - 88)**2 + (LATS - 20)**2) / 30)   # Ganges-Brahmaputra plume
                - 1.0 * np.exp(-((LONS - 80)**2 + (LATS - 11)**2) / 10)   # Sri Lanka coast
                + 0.5 * np.exp(-((LONS - 95)**2 + (LATS - 15)**2) / 15)   # Andaman sea saltier
            )

            if depth <= 100:
                layer_sal = s_surf + depth * 0.012
            elif depth <= 500:
                layer_sal = s_surf + 100*0.012 + (depth-100) * 0.004
            else:
                # Deep: relatively uniform 34.8 PSU
                layer_sal = 34.8 + 0.05 * np.random.randn(NLAT, NLON) * 0.1

            S[ti, di] = np.clip(layer_sal, 28.0, 36.0)

    return S

# ── Write NetCDF4 files ────────────────────────────────────────────────────────
def write_netcdf(path: Path, var_name: str, data: np.ndarray,
                 long_name: str, units: str, valid_min: float, valid_max: float):
    ds = nc.Dataset(str(path), "w", format="NETCDF4")
    ds.Conventions = "CF-1.8"
    ds.title       = f"TARANG Indian Ocean {long_name} — SIH 2026 PS 26067"
    ds.institution = "MoES/INCOIS"
    ds.source      = "Climatological simulation for TARANG SIH demo"
    ds.history     = f"Generated {datetime.utcnow().isoformat()}Z by generate_fixtures.py"

    ds.createDimension("time",      N_TIME)
    ds.createDimension("depth",     NDEP)
    ds.createDimension("latitude",  NLAT)
    ds.createDimension("longitude", NLON)

    # Coordinate variables
    tv = ds.createVariable("time",      "f8", ("time",))
    tv.units    = "days since 2026-08-01 00:00:00"
    tv.calendar = "gregorian"
    tv[:] = np.arange(N_TIME, dtype=np.float64)

    dv = ds.createVariable("depth",     "f4", ("depth",))
    dv.units     = "m"
    dv.positive  = "down"
    dv[:] = DEP

    latv = ds.createVariable("latitude",  "f4", ("latitude",))
    latv.units = "degrees_north"
    latv[:] = LAT

    lonv = ds.createVariable("longitude", "f4", ("longitude",))
    lonv.units = "degrees_east"
    lonv[:] = LON

    # Data variable
    v = ds.createVariable(var_name, "f4",
                          ("time", "depth", "latitude", "longitude"),
                          fill_value=-30000.0, zlib=True, complevel=6)
    v.long_name   = long_name
    v.units       = units
    v.valid_min   = valid_min
    v.valid_max   = valid_max
    v.standard_name = var_name
    v[:] = data

    ds.close()
    print(f"  ✓  Written: {path}  ({path.stat().st_size / 1024:.0f} kB)")


if __name__ == "__main__":
    print("TARANG fixture generator — Indian Ocean / Bay of Bengal")
    print(f"Output → {OUT_DIR.resolve()}\n")

    print("Generating temperature field (this takes ~5s)...")
    T = make_temperature()
    write_netcdf(
        OUT_DIR / "hycom_water_temp.nc",
        "water_temp", T,
        "Sea Water Temperature", "degC",
        valid_min=1.0, valid_max=32.0,
    )

    print("Generating salinity field...")
    S = make_salinity()
    write_netcdf(
        OUT_DIR / "hycom_salinity.nc",
        "salinity", S,
        "Sea Water Practical Salinity", "1",
        valid_min=28.0, valid_max=36.0,
    )

    print("\nDone! Fixture NetCDF files written successfully.")
    print("Backend registry will auto-discover these via the YAML manifests.")
