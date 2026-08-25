"""
PostGIS Database Layer — instrument metadata + spatial queries.

Schema:
  instruments(id SERIAL, platform_id TEXT, type TEXT, lat DOUBLE, lon DOUBLE,
              time_start TIMESTAMPTZ, time_end TIMESTAMPTZ, geom GEOMETRY(POINT, 4326))

Indexed with GIST on geom for fast bounding-box queries:
  "floats within this bbox" → ST_Within(geom, ST_MakeEnvelope(...))
"""

from __future__ import annotations

import logging
from typing import Any

import asyncpg

logger = logging.getLogger("tarang.db")


class Database:

    def __init__(self, database_url: str):
        self._url = database_url
        self._pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        self._pool = await asyncpg.create_pool(
            dsn=self._url,
            min_size=2,
            max_size=10,
        )
        logger.info("PostGIS pool established")

    async def disconnect(self) -> None:
        if self._pool:
            await self._pool.close()

    async def ensure_schema(self) -> None:
        """Create tables and indexes if they don't exist."""
        async with self._pool.acquire() as conn:
            await conn.execute("""
                CREATE EXTENSION IF NOT EXISTS postgis;
                CREATE TABLE IF NOT EXISTS instruments (
                    id          SERIAL PRIMARY KEY,
                    platform_id TEXT NOT NULL,
                    type        TEXT NOT NULL,       -- argo | glider | ctd | bgc
                    lat         DOUBLE PRECISION,
                    lon         DOUBLE PRECISION,
                    time_start  TIMESTAMPTZ,
                    time_end    TIMESTAMPTZ,
                    cycle_number INT,
                    geom        GEOMETRY(POINT, 4326)
                );
                CREATE INDEX IF NOT EXISTS instruments_geom_idx
                    ON instruments USING GIST(geom);
                CREATE INDEX IF NOT EXISTS instruments_type_idx
                    ON instruments(type);
            """)
        logger.info("PostGIS schema verified")

    async def query_instruments(
        self,
        bbox: tuple[float, float, float, float],
        instrument_type: str | None = None,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """
        Return instrument positions within bbox.
        bbox = (minLon, minLat, maxLon, maxLat)
        """
        if not self._pool:
            return []

        min_lon, min_lat, max_lon, max_lat = bbox

        type_clause = "AND type = $5" if instrument_type else ""
        params: list = [min_lon, min_lat, max_lon, max_lat]
        if instrument_type:
            params.append(instrument_type)

        query = f"""
            SELECT platform_id, type, lat, lon,
                   time_start, time_end, cycle_number
            FROM instruments
            WHERE ST_Within(
                geom,
                ST_MakeEnvelope($1, $2, $3, $4, 4326)
            )
            {type_clause}
            LIMIT {limit}
        """

        async with self._pool.acquire() as conn:
            rows = await conn.fetch(query, *params)
            return [dict(row) for row in rows]

    async def upsert_instrument(
        self,
        platform_id: str,
        type_: str,
        lat: float,
        lon: float,
        time_start: Any = None,
        time_end: Any = None,
        cycle_number: int | None = None,
    ) -> None:
        """Insert or update a single instrument record."""
        if not self._pool:
            return

        async with self._pool.acquire() as conn:
            await conn.execute("""
                INSERT INTO instruments
                    (platform_id, type, lat, lon, time_start, time_end, cycle_number, geom)
                VALUES ($1, $2, $3, $4, $5, $6, $7, ST_SetSRID(ST_MakePoint($4, $3), 4326))
                ON CONFLICT DO NOTHING
            """, platform_id, type_, lat, lon, time_start, time_end, cycle_number)

    async def get_profile_meta(self, platform_id: str) -> dict | None:
        """Return basic metadata for a single platform."""
        if not self._pool:
            return None
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM instruments WHERE platform_id=$1 LIMIT 1",
                platform_id
            )
            return dict(row) if row else None
