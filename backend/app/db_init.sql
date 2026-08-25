-- TARANG PostGIS Schema Initialization
-- Run by Docker entrypoint on first container start.
-- Idempotent: safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS postgis;

-- Instruments table: Argo, Glider, CTD, BGC floats
CREATE TABLE IF NOT EXISTS instruments (
    id           SERIAL PRIMARY KEY,
    platform_id  TEXT NOT NULL,
    type         TEXT NOT NULL,        -- argo | glider | ctd | bgc
    lat          DOUBLE PRECISION NOT NULL,
    lon          DOUBLE PRECISION NOT NULL,
    time_start   TIMESTAMPTZ,
    time_end     TIMESTAMPTZ,
    cycle_number INTEGER,
    geom         GEOMETRY(POINT, 4326)
);

-- Spatial index (GIST) for bbox queries:
--   ST_Within(geom, ST_MakeEnvelope(minLon, minLat, maxLon, maxLat, 4326))
CREATE INDEX IF NOT EXISTS instruments_geom_idx
    ON instruments USING GIST(geom);

-- Type index for fast filtering by instrument class
CREATE INDEX IF NOT EXISTS instruments_type_idx
    ON instruments(type);

-- Platform ID index for profile lookups
CREATE INDEX IF NOT EXISTS instruments_platform_idx
    ON instruments(platform_id);
