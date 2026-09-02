#!/usr/bin/env python3
"""
Seed synthetic mooring + ADCP + CTD + BGC-float positions into the `instruments` PostGIS table,
and (for CTD / BGC) write matching depth profiles to data/ctd/ and data/bgc/ so a click on the
marker opens a real depth-vs-variable chart. Illustrative Bay of Bengal + Arabian Sea placements,
labelled as demo data via the platform_id prefix. Runs from backend-entrypoint.sh on boot;
idempotent and offline-safe.
"""

import logging
import os
from pathlib import Path

logger = logging.getLogger("tarang.ingest.additional_sensors")
logging.basicConfig(level=logging.INFO)

# (platform_id, type, lat, lon)
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
# CTD casts — single-cast T/S profiles.
CTD_CASTS = [
    ("DEMO-CTD-01", "ctd", 12.0, 85.0),
    ("DEMO-CTD-02", "ctd", 16.5, 87.5),
    ("DEMO-CTD-03", "ctd", 9.0, 89.0),
    ("DEMO-CTD-04", "ctd", 18.5, 90.0),
    ("DEMO-CTD-05", "ctd", 14.0, 68.0),   # Arabian Sea
    ("DEMO-CTD-06", "ctd", 19.0, 66.0),   # Arabian Sea
]
# BGC floats — T/S + chlorophyll profiles.
BGC_FLOATS = [
    ("DEMO-BGC-01", "bgc", 13.0, 86.0),
    ("DEMO-BGC-02", "bgc", 17.5, 88.0),
    ("DEMO-BGC-03", "bgc", 10.5, 91.0),
    ("DEMO-BGC-04", "bgc", 15.5, 70.0),   # Arabian Sea
    ("DEMO-BGC-05", "bgc", 20.0, 67.5),   # Arabian Sea
]

_DEPTHS = [0, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000]


def _synthetic_profile(lat: float, lon: float, with_chl: bool):
    """A plausible tropical Indian-Ocean profile: warm mixed layer, sharp thermocline, cool deep;
    fresher surface, saltier at depth; sub-surface chlorophyll maximum near the thermocline."""
    import numpy as np
    d = np.array(_DEPTHS, dtype=float)
    sst = 29.5 - 0.02 * abs(lat - 12)            # slight latitudinal gradient
    temp = 4.0 + (sst - 4.0) / (1.0 + (d / 120.0) ** 2.2)
    sal = 35.4 - 1.1 * np.exp(-d / 60.0) + 0.15 * np.exp(-d / 800.0)
    out = {"depth": d, "temperature": temp, "salinity": sal}
    if with_chl:
        chl = 0.12 + 0.85 * np.exp(-((d - 55.0) ** 2) / (2 * 28.0 ** 2))   # DCM ~55 m
        out["chlorophyll"] = np.maximum(chl, 0.02)
    return out


def _write_profiles_nc(path: Path, stations, with_chl: bool) -> None:
    """Flat per-measurement table (dim 'row') matching what /api/profile's _load_from_local_cache
    expects (platform_number / cycle_number / pres / temp / psal [/ chlorophyll] / lat / lon / time)."""
    if path.exists():
        return
    import numpy as np
    from netCDF4 import Dataset

    rows_pid, rows_cyc, rows_pres, rows_t, rows_s, rows_chl, rows_lat, rows_lon = ([] for _ in range(8))
    for pid, _type, lat, lon in stations:
        p = _synthetic_profile(lat, lon, with_chl)
        n = len(p["depth"])
        rows_pid += [pid] * n
        rows_cyc += [1] * n
        rows_pres += list(p["depth"])
        rows_t += list(p["temperature"])
        rows_s += list(p["salinity"])
        rows_lat += [lat] * n
        rows_lon += [lon] * n
        if with_chl:
            rows_chl += list(p["chlorophyll"])

    path.parent.mkdir(parents=True, exist_ok=True)
    ds = Dataset(path, "w", format="NETCDF4")
    ds.createDimension("row", len(rows_pid))
    ds.Conventions = "CF-1.6"
    ds.title = f"TARANG synthetic {'BGC' if with_chl else 'CTD'} demo profiles"

    v = ds.createVariable("platform_number", str, ("row",)); v[:] = np.array(rows_pid, dtype=object)
    ds.createVariable("cycle_number", "i4", ("row",))[:] = rows_cyc
    p = ds.createVariable("pres", "f4", ("row",)); p.units = "dbar"; p.standard_name = "sea_water_pressure"; p[:] = rows_pres
    t = ds.createVariable("temp", "f4", ("row",)); t.units = "degree_Celsius"; t.standard_name = "sea_water_temperature"; t[:] = rows_t
    s = ds.createVariable("psal", "f4", ("row",)); s.units = "psu"; s.standard_name = "sea_water_practical_salinity"; s[:] = rows_s
    la = ds.createVariable("latitude", "f4", ("row",)); la.units = "degrees_north"; la[:] = rows_lat
    lo = ds.createVariable("longitude", "f4", ("row",)); lo.units = "degrees_east"; lo[:] = rows_lon
    if with_chl:
        c = ds.createVariable("chlorophyll", "f4", ("row",))
        c.units = "mg m-3"; c.standard_name = "mass_concentration_of_chlorophyll_a_in_sea_water"
        c[:] = rows_chl
    ds.close()
    logger.info(f"Wrote {len(stations)} synthetic profiles → {path}")


def seed(db_url: str) -> None:
    import psycopg2

    data_dir = Path(os.getenv("DATA_DIR", "data"))
    _write_profiles_nc(data_dir / "ctd" / "ctd_demo.nc", CTD_CASTS, with_chl=False)
    _write_profiles_nc(data_dir / "bgc" / "bgc_demo.nc", BGC_FLOATS, with_chl=True)

    conn = psycopg2.connect(db_url)
    cur = conn.cursor()
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
    for platform_id, sensor_type, lat, lon in MOORINGS + ADCP_STATIONS + CTD_CASTS + BGC_FLOATS:
        cur.execute("""
            INSERT INTO instruments (platform_id, type, lat, lon, cycle_number, geom)
            VALUES (%s, %s, %s, %s, 0, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
            ON CONFLICT (platform_id, cycle_number) DO NOTHING
        """, (platform_id, sensor_type, lat, lon, lon, lat))
        inserted += 1

    conn.commit()
    cur.close()
    conn.close()
    logger.info(f"Seeded {inserted} mooring/ADCP/CTD/BGC demo stations into PostGIS.")


if __name__ == "__main__":
    db_url = os.getenv("DATABASE_URL", "")
    if not db_url:
        logger.error("DATABASE_URL not set — cannot seed instruments table.")
    else:
        seed(db_url)
