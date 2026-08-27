"""
Redis Cache Layer

Wraps redis-py with a simple get_or_compute(key, ttl, fn) pattern.
Used by every endpoint to cache hot slices so timeline scrubbing feels instant.

Cache key conventions:
  slice:    slice:{source_id}:{var}:{depth_m}:{time_idx}:{bbox_str}
  volume:   volume:{source_id}:{var}:{time_idx}:{bbox_str}
  iso:      iso:{source_id}:{var}:{threshold}:{time_idx}:{bbox_str}
  meta:     meta:{source_id}

TTLs:
  slice     300 s  (5 min — hot during active scrubbing)
  volume    600 s  (10 min — large payload, hold longer)
  isosurface 120 s (recomputed often when threshold changes)
  metadata  3600 s (1 hour — rarely changes)
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Awaitable

import redis.asyncio as aioredis

logger = logging.getLogger("tarang.cache")

TTL_SLICE      = 300
TTL_VOLUME     = 600
TTL_ISOSURFACE = 120
TTL_METADATA   = 3600


class RedisCache:

    def __init__(self, redis_url: str):
        self._url = redis_url
        self._client: aioredis.Redis | None = None

    async def connect(self) -> None:
        if not self._url:
            logger.warning("REDIS_URL not set — caching disabled, every request recomputes")
            return

        self._client = aioredis.from_url(
            self._url,
            encoding="utf-8",
            decode_responses=False,  # binary — our payloads are raw bytes
        )
        await self._client.ping()
        logger.info(f"Redis connected: {self._url}")

    async def disconnect(self) -> None:
        if self._client:
            await self._client.aclose()

    async def get_bytes(self, key: str) -> bytes | None:
        """Return cached bytes or None if cache miss."""
        if not self._client:
            return None
        try:
            return await self._client.get(key)
        except Exception as e:
            logger.warning(f"Redis GET failed for key '{key}': {e}")
            return None

    async def set_bytes(self, key: str, value: bytes, ttl: int) -> None:
        """Cache raw bytes with a TTL (seconds)."""
        if not self._client:
            return
        try:
            await self._client.setex(key, ttl, value)
        except Exception as e:
            logger.warning(f"Redis SET failed for key '{key}': {e}")

    async def get_or_compute(
        self,
        key: str,
        ttl: int,
        compute_fn: Callable[[], Awaitable[bytes]],
    ) -> bytes:
        """
        Cache-aside pattern:
          1. Check Redis for key
          2. On miss: call compute_fn(), cache result, return it
          3. On hit: return cached bytes directly
        """
        cached = await self.get_bytes(key)
        if cached is not None:
            logger.debug(f"Cache HIT: {key}")
            return cached

        logger.debug(f"Cache MISS: {key} — computing...")
        result = await compute_fn()
        await self.set_bytes(key, result, ttl)
        return result

    @staticmethod
    def bbox_to_str(bbox: tuple) -> str:
        """Normalise bbox to a cache-key-safe string."""
        return f"{bbox[0]:.2f}_{bbox[1]:.2f}_{bbox[2]:.2f}_{bbox[3]:.2f}"

    def slice_key(self, source_id: str, var: str, depth_m: float, time_idx: int, bbox: tuple) -> str:
        return f"slice:{source_id}:{var}:{depth_m:.1f}:{time_idx}:{self.bbox_to_str(bbox)}"

    def volume_key(self, source_id: str, var: str, time_idx: int, bbox: tuple) -> str:
        return f"volume:{source_id}:{var}:{time_idx}:{self.bbox_to_str(bbox)}"

    def isosurface_key(self, source_id: str, var: str, threshold: float, time_idx: int, bbox: tuple) -> str:
        return f"iso:{source_id}:{var}:{threshold:.4f}:{time_idx}:{self.bbox_to_str(bbox)}"

    def metadata_key(self, source_id: str) -> str:
        return f"meta:{source_id}"
