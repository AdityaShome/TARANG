"""
Glider ingest — IOOS Glider DAC (ERDDAP tabledap) → PostGIS instruments (type='glider').

Discovers which deployments have data in each demo region's bbox, fetches them,
and writes one marker per (glider, profile). Region bboxes are shared with
argo_ingest.py. Runs from backend-entrypoint.sh on boot; OFFLINE_MODE skips
discovery and ingests whatever is already cached in data/glider/.
"""

import glob
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from backend.app.ingest.argo_ingest import REGIONS

logger = logging.getLogger("tarang.ingest.glider")
logging.basicConfig(level=logging.INFO)


ERDDAP_BASE = "https://gliders.ioos.us/erddap"
GLIDER_DIR = Path(os.getenv("DATA_DIR", "data")) / "glider"

# Standard IOOS Glider DAC profile variables (common template across deployments).
_ERDDAP_VARS = "trajectory,profile_id,time,latitude,longitude,depth,temperature,salinity"
_MAX_DATASETS_PER_REGION = 3


def discover_glider_datasets(bbox: tuple[float, float, float, float], timeout: int = 30) -> list[str]:
    """datasetIDs whose envelope intersects bbox=(min_lon,min_lat,max_lon,max_lat). [] on error."""
    min_lon, min_lat, max_lon, max_lat = bbox
    query = (
        "datasetID,minLongitude,maxLongitude,minLatitude,maxLatitude"
        f"&minLongitude<={max_lon}&maxLongitude>={min_lon}"
        f"&minLatitude<={max_lat}&maxLatitude>={min_lat}"
    )
    url = f"{ERDDAP_BASE}/tabledap/allDatasets.json?{urllib.parse.quote(query, safe='=&<>,')}"
    logger.info(f"Discovering glider deployments in bbox={bbox} via ERDDAP allDatasets")
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            payload = json.load(resp)
        rows = payload["table"]["rows"]
        ids = [r[0] for r in rows if r[0] and r[0] != "allDatasets"]  # drop the meta-row
        logger.info(f"  found {len(ids)} deployment(s): {ids[:_MAX_DATASETS_PER_REGION]}"
                    + (" (capped)" if len(ids) > _MAX_DATASETS_PER_REGION else ""))
        return ids[:_MAX_DATASETS_PER_REGION]
    except urllib.error.HTTPError as e:
        # ERDDAP returns 404 when a query matches zero rows — not an error.
        if e.code == 404:
            logger.info("  no glider deployments in this region")
        else:
            logger.warning(f"  glider discovery failed (HTTP {e.code}) — using cached files only")
        return []
    except Exception as e:
        logger.warning(f"  glider discovery unavailable ({e}) — using cached files only (offline?)")
        return []


def fetch_glider_dataset(dataset_id: str) -> Path | None:
    """Download one deployment's flat measurement table → data/glider/<id>.nc (cache-skip)."""
    GLIDER_DIR.mkdir(parents=True, exist_ok=True)
    out_path = GLIDER_DIR / f"{dataset_id}.nc"

    if out_path.exists():
        logger.info(f"{dataset_id}: cache exists at {out_path} — skipping fetch")
        return out_path

    url = (
        f"{ERDDAP_BASE}/tabledap/{urllib.parse.quote(dataset_id)}.nc?{_ERDDAP_VARS}"
        f"&temperature>=-5&temperature<=40"
    )
    logger.info(f"{dataset_id}: downloading from {url}")
    try:
        import requests
        r = requests.get(url, timeout=180)
        r.raise_for_status()
        out_path.write_bytes(r.content)
        logger.info(f"{dataset_id}: saved → {out_path} ({out_path.stat().st_size} bytes)")
        return out_path
    except Exception as e:
        logger.error(f"{dataset_id}: glider fetch failed: {e}")
        logger.error("If this is a network error, run this script before the venue (§15).")
        return None


def ingest_to_postgis(nc_path: str, db_url: str) -> None:
    """Load glider positions from a cached flat per-measurement NetCDF into PostGIS."""
    import xarray as xr

    if not Path(nc_path).exists():
        logger.warning(f"NetCDF not found at {nc_path} — skipping PostGIS ingest")
        return

    import psycopg2

    ds = xr.open_dataset(nc_path)

    conn = psycopg2.connect(db_url)
    cur = conn.cursor()

    # Same schema as argo_ingest / db.py; the UNIQUE index makes the INSERT idempotent.
    cur.execute("""
        CREATE EXTENSION IF NOT EXISTS postgis;
        CREATE TABLE IF NOT EXISTS instruments (
            id SERIAL PRIMARY KEY,
            platform_id TEXT, type TEXT, lat DOUBLE PRECISION, lon DOUBLE PRECISION,
            time_start TIMESTAMPTZ, time_end TIMESTAMPTZ, cycle_number INT,
            geom GEOMETRY(POINT, 4326)
        );
        CREATE INDEX IF NOT EXISTS instruments_geom_idx ON instruments USING GIST(geom);
        CREATE UNIQUE INDEX IF NOT EXISTS instruments_platform_cycle_idx
            ON instruments (platform_id, cycle_number);
    """)

    def _col(*candidates: str) -> str:
        for name in candidates:
            if name in ds.variables:
                return name
        raise KeyError(f"None of {candidates} found in {nc_path}; variables: {list(ds.variables)}")

    col_traj    = _col("trajectory", "TRAJECTORY", "wmo_id")
    col_profile = _col("profile_id", "PROFILE_ID", "profile")
    col_lat     = _col("latitude", "LATITUDE", "lat")
    col_lon     = _col("longitude", "LONGITUDE", "lon")
    col_time    = _col("time", "TIME")

    # One marker per (glider, profile) — collapse the depth-level rows to one position.
    df = ds[[col_traj, col_profile, col_lat, col_lon, col_time]].to_dataframe()
    df = df.rename(columns={
        col_traj: "trajectory", col_profile: "profile_id",
        col_lat: "latitude", col_lon: "longitude", col_time: "time",
    })
    df = df.dropna(subset=["profile_id", "latitude", "longitude"])
    profiles = df.groupby(["trajectory", "profile_id"], as_index=False).first()

    inserted = 0
    for _, row in profiles.iterrows():
        try:
            platform_id = str(row["trajectory"]).strip()
            lat   = float(row["latitude"])
            lon   = float(row["longitude"])
            cycle = int(row["profile_id"])
            time  = str(row["time"])

            cur.execute("""
                INSERT INTO instruments (platform_id, type, lat, lon, time_start, cycle_number, geom)
                VALUES (%s, 'glider', %s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
                ON CONFLICT (platform_id, cycle_number) DO NOTHING
            """, (platform_id, lat, lon, time, cycle, lon, lat))
            inserted += 1
        except Exception as e:
            logger.warning(f"Glider profile {row.get('trajectory')}/{row.get('profile_id')} skipped: {e}")

    conn.commit()
    n_prof = len(profiles)
    cur.close()
    conn.close()
    logger.info(f"PostGIS: inserted {inserted} of {n_prof} glider profiles from {nc_path}")


if __name__ == "__main__":
    offline = os.getenv("OFFLINE_MODE", "false").strip().lower() in ("1", "true", "yes", "on")

    # OFFLINE_MODE: skip discovery/fetch, ingest whatever is cached in data/glider/.
    if offline:
        logger.info("OFFLINE_MODE: skipping ERDDAP glider discovery — using cached files only.")
    else:
        for region_name, cfg in REGIONS.items():
            for dataset_id in discover_glider_datasets(tuple(cfg["bbox"])):
                fetch_glider_dataset(dataset_id)

    db_url = os.getenv("DATABASE_URL", "")
    cached = sorted(glob.glob(str(GLIDER_DIR / "*.nc")))
    if not cached:
        logger.warning(f"No glider NetCDF files in {GLIDER_DIR} — nothing to ingest.")
    elif db_url:
        for nc_path in cached:
            ingest_to_postgis(nc_path, db_url)
    else:
        logger.info("DATABASE_URL not set — skipping PostGIS ingest. Set it to enable.")

    logger.info("Glider ingest complete. Demo is ready for offline operation. (§15)")
