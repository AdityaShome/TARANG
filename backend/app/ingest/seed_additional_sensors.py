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


def _synthetic_current_profile(lat: float, lon: float):
    """A plausible ADCP current profile: a wind-driven surface jet (~0.5 m/s) decaying with
    depth, a weak reversing undercurrent near 150 m, near-zero below 800 m. Direction rotates
    slowly with depth (Ekman-like veering)."""
    import numpy as np
    d = np.array(_DEPTHS, dtype=float)
    surf_speed = 0.45 + 0.1 * np.cos(np.radians(lat * 7))
    speed = surf_speed * np.exp(-d / 180.0) - 0.06 * np.exp(-((d - 150.0) ** 2) / (2 * 70.0 ** 2))
    speed = np.abs(speed)
    heading = np.radians(50.0 + 0.12 * d)          # veers with depth
    u = speed * np.sin(heading)
    v = speed * np.cos(heading)
    return {"depth": d, "current_u": u, "current_v": v, "current_speed": speed}


def _write_current_profiles_nc(path: Path, stations) -> None:
    """Flat per-measurement table for ADCP current profiles — same 'row' shape as the T/S
    profile files, with u/v/speed columns instead of temp/psal."""
    if path.exists():
        return
    import numpy as np
    from netCDF4 import Dataset

    rows_pid, rows_cyc, rows_pres, rows_u, rows_v, rows_spd, rows_lat, rows_lon = ([] for _ in range(8))
    for pid, _type, lat, lon in stations:
        p = _synthetic_current_profile(lat, lon)
        n = len(p["depth"])
        rows_pid += [pid] * n
        rows_cyc += [1] * n
        rows_pres += list(p["depth"])
        rows_u += list(p["current_u"])
        rows_v += list(p["current_v"])
        rows_spd += list(p["current_speed"])
        rows_lat += [lat] * n
        rows_lon += [lon] * n

    path.parent.mkdir(parents=True, exist_ok=True)
    ds = Dataset(path, "w", format="NETCDF4")
    ds.createDimension("row", len(rows_pid))
    ds.Conventions = "CF-1.6"
    ds.title = "TARANG synthetic ADCP demo current profiles"

    v = ds.createVariable("platform_number", str, ("row",)); v[:] = np.array(rows_pid, dtype=object)
    ds.createVariable("cycle_number", "i4", ("row",))[:] = rows_cyc
    pr = ds.createVariable("pres", "f4", ("row",)); pr.units = "dbar"; pr.standard_name = "sea_water_pressure"; pr[:] = rows_pres
    cu = ds.createVariable("current_u", "f4", ("row",)); cu.units = "m s-1"; cu.standard_name = "eastward_sea_water_velocity"; cu[:] = rows_u
    cv = ds.createVariable("current_v", "f4", ("row",)); cv.units = "m s-1"; cv.standard_name = "northward_sea_water_velocity"; cv[:] = rows_v
    cs = ds.createVariable("current_speed", "f4", ("row",)); cs.units = "m s-1"; cs.standard_name = "sea_water_speed"; cs[:] = rows_spd
    la = ds.createVariable("latitude", "f4", ("row",)); la.units = "degrees_north"; la[:] = rows_lat
    lo = ds.createVariable("longitude", "f4", ("row",)); lo.units = "degrees_east"; lo[:] = rows_lon
    ds.close()
    logger.info(f"Wrote {len(stations)} synthetic ADCP current profiles → {path}")


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
        # BGC-Argo also carries oxygen / nitrate / pH — a shallow oxygen minimum zone
        # (classic north Indian Ocean), nutricline near the thermocline, pH falling with depth.
        out["oxygen"] = np.clip(215.0 - 170.0 * np.exp(-((d - 350.0) ** 2) / (2 * 250.0 ** 2)), 10.0, 230.0)
        out["nitrate"] = 0.4 + 28.0 / (1.0 + np.exp(-(d - 140.0) / 45.0))
        out["ph"] = 8.10 - 0.32 / (1.0 + np.exp(-(d - 280.0) / 110.0))
    return out


def _write_profiles_nc(path: Path, stations, with_chl: bool) -> None:
    """Flat per-measurement table (dim 'row') matching what /api/profile's _load_from_local_cache
    expects (platform_number / cycle_number / pres / temp / psal [/ chlorophyll] / lat / lon / time)."""
    if path.exists():
        return
    import numpy as np
    from netCDF4 import Dataset

    rows_pid, rows_cyc, rows_pres, rows_t, rows_s, rows_lat, rows_lon = ([] for _ in range(7))
    rows_chl, rows_o2, rows_no3, rows_ph = [], [], [], []
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
            rows_o2 += list(p["oxygen"])
            rows_no3 += list(p["nitrate"])
            rows_ph += list(p["ph"])

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
        o = ds.createVariable("oxygen", "f4", ("row",))
        o.units = "micromole kg-1"; o.standard_name = "moles_of_oxygen_per_unit_mass_in_sea_water"
        o[:] = rows_o2
        nn = ds.createVariable("nitrate", "f4", ("row",))
        nn.units = "micromole kg-1"; nn.standard_name = "moles_of_nitrate_per_unit_mass_in_sea_water"
        nn[:] = rows_no3
        ph = ds.createVariable("ph", "f4", ("row",))
        ph.units = "1"; ph.standard_name = "sea_water_ph_reported_on_total_scale"
        ph[:] = rows_ph
    ds.close()
    logger.info(f"Wrote {len(stations)} synthetic profiles → {path}")


def seed(db_url: str) -> None:
    import psycopg2

    data_dir = Path(os.getenv("DATA_DIR", "data"))
    _write_profiles_nc(data_dir / "ctd" / "ctd_demo.nc", CTD_CASTS, with_chl=False)
    _write_profiles_nc(data_dir / "bgc" / "bgc_demo.nc", BGC_FLOATS, with_chl=True)
    _write_profiles_nc(data_dir / "mooring" / "mooring_demo.nc", MOORINGS, with_chl=False)
    _write_current_profiles_nc(data_dir / "adcp" / "adcp_demo.nc", ADCP_STATIONS)

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
