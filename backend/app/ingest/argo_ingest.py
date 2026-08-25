"""
Argo Ingest Script — Pre-fetches Argo GDAC data for the demo region.

Run this BEFORE demo day (§15, §20 Rule 8):
  python -m backend.app.ingest.argo_ingest

Downloads Argo profiles for Bay of Bengal + Arabian Sea, saves to local
NetCDF files in data/argo/. These are what /api/instruments and /api/profile
use during the demo — no live network calls during judging.

argopy 1.4.0 — Python >= 3.11 required
argopy incompatible with xarray 2024.3.0–2025.6.1 — pin xarray >= 2025.7.0
"""

import asyncio
import logging
import os
from pathlib import Path

logger = logging.getLogger("tarang.ingest.argo")
logging.basicConfig(level=logging.INFO)


# Demo regions
REGIONS = {
    "BoB": {
        "bbox": (80, 5, 100, 25),    # Bay of Bengal (primary)
        "date_start": "2026-07-01",
        "date_end":   "2026-08-25",
        "output_file": "data/argo/BoB_argo_2026.nc",
    },
    "ArabianSea": {
        "bbox": (55, 5, 75, 25),     # Arabian Sea (secondary)
        "date_start": "2026-07-01",
        "date_end":   "2026-08-25",
        "output_file": "data/argo/ArabianSea_argo_2026.nc",
    },
}


def fetch_argo_region(region_name: str, config: dict) -> None:
    """Fetch Argo data for a region and save to local NetCDF."""
    try:
        import argopy
        from argopy import DataFetcher as ArgoDataFetcher
    except ImportError:
        logger.error("argopy not installed. Run: pip install argopy==1.4.0")
        return

    out_path = Path(config["output_file"])
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if out_path.exists():
        logger.info(f"{region_name}: cache already exists at {out_path} — skipping")
        return

    min_lon, min_lat, max_lon, max_lat = config["bbox"]
    logger.info(f"{region_name}: fetching Argo from GDAC "
                f"bbox=({min_lon},{min_lat},{max_lon},{max_lat}) "
                f"dates={config['date_start']} to {config['date_end']}")

    try:
        loader = ArgoDataFetcher(src="gdac").region([
            min_lon, max_lon,
            min_lat, max_lat,
            0, 2000,             # depth: 0–2000 dbar
            config["date_start"],
            config["date_end"],
        ])
        ds = loader.to_xarray()

        # Save to NetCDF
        ds.to_netcdf(str(out_path))
        n_floats   = len(set(ds["PLATFORM_NUMBER"].values))
        n_profiles = ds.dims.get("N_PROF", 0)
        logger.info(f"{region_name}: saved {n_profiles} profiles from {n_floats} floats → {out_path}")

    except Exception as e:
        logger.error(f"{region_name}: Argo fetch failed: {e}")
        logger.error("If this is a network error, check your internet connection.")
        logger.error("Run this script before the venue (§15).")


def ingest_to_postgis(nc_path: str, db_url: str) -> None:
    """
    Load Argo positions from the cached NetCDF into PostGIS.
    Called after fetch_argo_region() completes.
    """
    import xarray as xr
    import psycopg2

    if not Path(nc_path).exists():
        logger.warning(f"NetCDF not found at {nc_path} — skipping PostGIS ingest")
        return

    ds = xr.open_dataset(nc_path)

    conn = psycopg2.connect(db_url)
    cur  = conn.cursor()

    # Ensure schema
    cur.execute("""
        CREATE TABLE IF NOT EXISTS instruments (
            id SERIAL PRIMARY KEY,
            platform_id TEXT, type TEXT, lat DOUBLE PRECISION, lon DOUBLE PRECISION,
            time_start TIMESTAMPTZ, time_end TIMESTAMPTZ, cycle_number INT,
            geom GEOMETRY(POINT, 4326)
        );
        CREATE INDEX IF NOT EXISTS instruments_geom_idx ON instruments USING GIST(geom);
    """)

    inserted = 0
    n_prof = ds.dims.get("N_PROF", 0)

    for i in range(n_prof):
        try:
            platform_id = str(ds["PLATFORM_NUMBER"].values[i]).strip()
            lat   = float(ds["LATITUDE"].values[i])
            lon   = float(ds["LONGITUDE"].values[i])
            cycle = int(ds["CYCLE_NUMBER"].values[i]) if "CYCLE_NUMBER" in ds else None
            time  = str(ds["JULD"].values[i]) if "JULD" in ds else None

            cur.execute("""
                INSERT INTO instruments (platform_id, type, lat, lon, time_start, cycle_number, geom)
                VALUES (%s, 'argo', %s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
                ON CONFLICT DO NOTHING
            """, (platform_id, lat, lon, time, cycle, lon, lat))
            inserted += 1
        except Exception as e:
            logger.warning(f"Row {i} skipped: {e}")

    conn.commit()
    cur.close()
    conn.close()
    logger.info(f"PostGIS: inserted {inserted} of {n_prof} profiles from {nc_path}")


if __name__ == "__main__":
    # 1. Fetch Argo data for both regions
    for name, cfg in REGIONS.items():
        fetch_argo_region(name, cfg)

    # 2. Ingest to PostGIS if DATABASE_URL is set
    db_url = os.getenv("DATABASE_URL", "")
    if db_url:
        for cfg in REGIONS.values():
            ingest_to_postgis(cfg["output_file"], db_url)
    else:
        logger.info("DATABASE_URL not set — skipping PostGIS ingest. Set it to enable.")

    logger.info("Argo ingest complete. Demo is ready for offline operation. (§15)")
