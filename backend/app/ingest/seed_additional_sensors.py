#!/usr/bin/env python3
"""
Seed synthetic mooring + ADCP station positions into the `instruments` PostGIS table
(type='mooring'/'adcp'). Illustrative Bay of Bengal placements, labelled as demo data
via the platform_id prefix. Runs from backend-entrypoint.sh on boot.
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

    # Same schema as argo_ingest / db.py (guards a standalone run).
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
