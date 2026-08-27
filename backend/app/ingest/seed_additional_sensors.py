#!/usr/bin/env python3
"""
seed_additional_sensors.py — TARANG SIH 2026 PS 26067

Seeds synthetic moored-buoy and ADCP (Acoustic Doppler Current Profiler) station positions into
the SAME `instruments` PostGIS table Argo floats already use — demonstrating the "Extensible
Design" requirement's named sensor types (moorings, HF-radar, ADCP) for POINT instruments with
genuinely zero new backend code: /api/instruments already accepts an arbitrary `type` value and
has no allow-list, InstrumentMarkerLayer.ts already renders whatever markers come back, and the
click handler already resolves whichever platform_id a marker carries. Only new DATA was needed.

Positions are illustrative placements within the Bay of Bengal (NOT claimed to match any real
INCOIS OMNI buoy or ADCP deployment's exact coordinates) — clearly labeled as demo data via the
platform_id prefix, same convention as registry/mock_bgc_chlorophyll.yaml.

Run inside the backend container:
  docker compose exec backend python -m backend.app.ingest.seed_additional_sensors
"""

import logging
import os

logger = logging.getLogger("tarang.ingest.additional_sensors")
logging.basicConfig(level=logging.INFO)

# (platform_id, type, lat, lon) — spread across the Bay of Bengal demo region (80-100E, 5-25N).
MOORINGS = [
    ("DEMO-MOORING-01", "mooring", 13.5, 88.0),
    ("DEMO-MOORING-02", "mooring", 17.0, 89.5),
    ("DEMO-MOORING-03", "mooring", 10.0, 92.0),
    ("DEMO-MOORING-04", "mooring", 20.0, 86.5),
]

ADCP_STATIONS = [
    ("DEMO-ADCP-01", "adcp", 15.0, 84.0),
    ("DEMO-ADCP-02", "adcp", 8.5, 90.0),
    ("DEMO-ADCP-03", "adcp", 19.0, 91.5),
]


def seed(db_url: str) -> None:
    import psycopg2

    conn = psycopg2.connect(db_url)
    cur = conn.cursor()

    # Same schema Argo ingestion (argo_ingest.py) and the app's own startup (db.py) create —
    # CREATE TABLE IF NOT EXISTS is a no-op if it already exists, just guards standalone runs.
    cur.execute("""
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

    inserted = 0
    for platform_id, sensor_type, lat, lon in MOORINGS + ADCP_STATIONS:
        cur.execute("""
            INSERT INTO instruments (platform_id, type, lat, lon, cycle_number, geom)
            VALUES (%s, %s, %s, %s, 0, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
            ON CONFLICT (platform_id, cycle_number) DO NOTHING
        """, (platform_id, sensor_type, lat, lon, lon, lat))
        inserted += 1

    conn.commit()
    cur.close()
    conn.close()
    logger.info(f"Seeded {inserted} mooring/ADCP demo stations into PostGIS.")


if __name__ == "__main__":
    db_url = os.getenv("DATABASE_URL", "")
    if not db_url:
        logger.error("DATABASE_URL not set — cannot seed instruments table.")
    else:
        seed(db_url)
