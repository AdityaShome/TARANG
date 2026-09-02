#!/bin/sh
# Seed instrument overlay data into PostGIS before uvicorn starts. Idempotent,
# offline-safe, non-fatal. Disable with SEED_ON_BOOT=false.
set -e

if [ -n "$DATABASE_URL" ] && [ "${SEED_ON_BOOT:-true}" = "true" ]; then
    echo "[entrypoint] Seeding instrument overlay data into PostGIS..."

    echo "[entrypoint] â†’ Argo floats (cached NetCDF â†’ PostGIS)"
    python -m backend.app.ingest.argo_ingest \
        || echo "[entrypoint] WARN: argo_ingest failed â€” instrument overlay may be incomplete"

    echo "[entrypoint] â†’ Glider trajectories (cached NetCDF â†’ PostGIS)"
    python -m backend.app.ingest.glider_ingest \
        || echo "[entrypoint] WARN: glider_ingest failed â€” glider overlay may be missing"

    echo "[entrypoint] â†’ Moorings / ADCP demo stations"
    python -m backend.app.ingest.seed_additional_sensors \
        || echo "[entrypoint] WARN: seed_additional_sensors failed â€” mooring/ADCP overlay may be missing"

    echo "[entrypoint] Instrument seeding done."
else
    echo "[entrypoint] SEED_ON_BOOT disabled or DATABASE_URL unset â€” skipping instrument seed."
fi

exec "$@"
