"""
TARANG — FastAPI Application Entrypoint
SIH 2026 · PS 26067 · MoES/INCOIS

Lifespan:
  startup  → load YAML registry, warm Redis, init PostGIS pool
  shutdown → close DB pool, flush Redis connection

Routers mounted:
  /api/metadata       → endpoints/metadata.py
  /api/slice          → endpoints/slice.py
  /api/volume         → endpoints/volume.py
  /api/isosurface     → endpoints/isosurface.py
  /api/instruments    → endpoints/instruments.py
  /api/profile        → endpoints/profile.py
  /wms                → wms_wcs/wms.py  (Option B only, skipped if THREDDS up)
  /wcs                → wms_wcs/wcs.py  (Option B only)
"""

from contextlib import asynccontextmanager
import logging
import os

# Loads .env into os.environ if present — docker-compose substitutes .env values itself, but
# nothing did this for a plain `uvicorn backend.app.main:app` run outside Docker, so
# COPERNICUS_USERNAME/PASSWORD (and anything else in .env.example) were silently ignored unless
# exported into the shell by hand. python-dotenv is already a pinned dependency for exactly this.
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.app.registry.loader import RegistryLoader
from backend.app.cache import RedisCache
from backend.app.db import Database
from backend.app.endpoints import metadata, slice_, volume, isosurface, instruments, profile, eddy, metrics, preview, registry as registry_endpoint
logger = logging.getLogger("tarang")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "info").upper())

# Global singletons — set during startup, used by all endpoints via app.state
_registry: RegistryLoader | None = None
_cache: RedisCache | None = None
_db: Database | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup / shutdown lifecycle."""
    global _registry, _cache, _db

    logger.info("TARANG backend starting up...")

    # ── Load YAML plugin registry ─────────────────────────────────────────────
    registry_dir = os.getenv("REGISTRY_DIR", "registry")
    _registry = RegistryLoader(registry_dir)
    _registry.load_all()
    logger.info(f"Registry loaded: {list(_registry.manifest_ids())} plugins")
    app.state.registry = _registry

    # ── Start filesystem watcher (auto hot-reload on YAML changes) ─────────────
    # Drops a new YAML → live layer appears in frontend within 1s — no restart
    _registry.start_watcher()

    # ── Connect to Redis ──────────────────────────────────────────────────────
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    _cache = RedisCache(redis_url)
    await _cache.connect()
    app.state.cache = _cache

    # ── Connect to PostGIS ────────────────────────────────────────────────────
    database_url = os.getenv("DATABASE_URL", "")
    if database_url:
        _db = Database(database_url)
        await _db.connect()
        await _db.ensure_schema()
        logger.info("PostGIS connected and schema verified")
    else:
        logger.warning("DATABASE_URL not set — instrument endpoints will return empty results")
        _db = None
    app.state.db = _db

    logger.info("TARANG backend ready ✓")
    yield  # ── Application runs ─────────────────────────────────────────────

    # ── Shutdown ──────────────────────────────────────────────────────────────
    logger.info("TARANG backend shutting down...")
    if _cache:
        await _cache.disconnect()
    if _db:
        await _db.disconnect()
    if _registry:
        _registry.stop_watcher()
    logger.info("TARANG backend shutdown complete")


# ── FastAPI App ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="TARANG Ocean Visualization API",
    description=(
        "Backend API for TARANG — Web-Based Interactive 3D Ocean Visualization Platform. "
        "SIH 2026 · PS 26067 · MoES/INCOIS. "
        "Provides binary-serialized depth-slice, volume, and isosurface data from "
        "HYCOM/INCOIS-GODAS/Copernicus ocean model output, plus Argo float profiles."
    ),
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    lifespan=lifespan,
)

# ── CORS (Nginx handles prod; this is for local dev without Nginx) ────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://localhost"],
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(metadata.router,          prefix="/api")
app.include_router(slice_.router,            prefix="/api")
app.include_router(volume.router,            prefix="/api")
app.include_router(isosurface.router,        prefix="/api")
app.include_router(instruments.router,       prefix="/api")
app.include_router(profile.router,           prefix="/api")
app.include_router(eddy.router,              prefix="/api")
app.include_router(metrics.router,           prefix="/api")
app.include_router(preview.router,           prefix="/api")
app.include_router(registry_endpoint.router, prefix="/api")

# Option B: hand-rolled OGC endpoints (only active when OPTION_B_MODE=true)
if os.getenv("OPTION_B_MODE", "false").lower() == "true":
    from backend.app.wms_wcs import wms, wcs
    app.include_router(wms.router)
    app.include_router(wcs.router)
    logger.info("Option B mode: hand-rolled WMS/WCS endpoints mounted")


# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/health", tags=["system"])
async def health():
    """Smoke test endpoint — used by Docker healthcheck and CI."""
    return JSONResponse({
        "status": "ok",
        "service": "tarang-backend",
        "registry_size": len(list(app.state.registry.manifest_ids())) if app.state.registry else 0,
    })


# ── Root redirect ─────────────────────────────────────────────────────────────
@app.get("/", include_in_schema=False)
async def root():
    return JSONResponse({"message": "TARANG API. See /api/docs for endpoints."})
