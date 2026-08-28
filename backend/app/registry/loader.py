"""
YAML Plugin Registry Loader — TARANG SIH 2026 PS 26067

Walks registry/*.yaml, validates schema, instantiates adapters.

Hot-reload is triggered three ways (§20 Rule 6 — zero code changes per new sensor):
  1. SIGHUP signal:      `kill -HUP <pid>` on POSIX systems
  2. Filesystem watcher: watchdog detects new/modified/deleted YAML files automatically
  3. HTTP endpoint:      POST /api/registry/reload  (demo-friendly, no shell access needed)

This is the concrete implementation of the "extensible design" requirement (§2):
  Adding a new sensor = dropping a new YAML file in registry/. Zero new code.
"""

from __future__ import annotations

import logging
import os
import signal
import threading
from pathlib import Path
from typing import Iterator

import yaml

from backend.app.adapters import ADAPTER_REGISTRY, DataSourceAdapter

logger = logging.getLogger("tarang.registry")

# Required fields in every manifest
REQUIRED_FIELDS = {"id", "adapter", "source", "variable"}


class RegistryLoader:
    """
    Loads and validates YAML manifests from the registry directory.
    Provides adapter instances keyed by manifest ID.

    Supports three hot-reload triggers:
    - SIGHUP (POSIX kill signal)
    - Filesystem watcher via watchdog (auto-detects YAML changes)
    - HTTP POST /api/registry/reload endpoint (demo-friendly)
    """

    def __init__(self, registry_dir: str):
        self._dir = Path(registry_dir)
        self._manifests: dict[str, dict] = {}
        self._adapters: dict[str, DataSourceAdapter] = {}
        self._observer = None          # watchdog Observer thread
        self._reload_lock = threading.Lock()
        self._reload_count: int = 0    # incremented each reload, useful for debugging

    # ── Load ──────────────────────────────────────────────────────────────────

    def load_all(self) -> None:
        """Load (or hot-reload) all *.yaml files from the registry directory."""
        with self._reload_lock:
            if not self._dir.exists():
                logger.warning(f"Registry directory '{self._dir}' not found — no plugins loaded")
                return

            self._manifests.clear()
            self._adapters.clear()

            yaml_files = sorted(self._dir.glob("*.yaml"))
            if not yaml_files:
                logger.warning(f"No YAML manifests found in '{self._dir}'")

            for path in yaml_files:
                try:
                    self._load_one(path)
                except Exception as e:
                    logger.error(f"Failed to load manifest '{path.name}': {e}")

            self._reload_count += 1
            logger.info(
                f"Registry (reload #{self._reload_count}): "
                f"loaded {len(self._manifests)} manifests: {list(self._manifests.keys())}"
            )

        # ── Register SIGHUP handler (POSIX only) ─────────────────────────────
        try:
            signal.signal(signal.SIGHUP, lambda sig, frame: self.reload())
        except (AttributeError, OSError, ValueError):
            pass  # no SIGHUP on Windows / not the main thread (e.g. under TestClient)

    def _load_one(self, path: Path) -> None:
        """Parse and validate a single YAML manifest file."""
        with open(path, "r", encoding="utf-8") as f:
            manifest = yaml.safe_load(f)

        if not isinstance(manifest, dict):
            raise ValueError(f"Manifest must be a YAML mapping, got {type(manifest)}")

        missing = REQUIRED_FIELDS - set(manifest.keys())
        if missing:
            raise ValueError(f"Missing required fields: {missing}")

        manifest_id = manifest["id"]
        adapter_name = manifest["adapter"]

        if adapter_name not in ADAPTER_REGISTRY:
            raise ValueError(
                f"Unknown adapter '{adapter_name}'. "
                f"Available: {list(ADAPTER_REGISTRY.keys())}"
            )

        adapter_cls = ADAPTER_REGISTRY[adapter_name]
        self._manifests[manifest_id] = manifest
        self._adapters[manifest_id] = adapter_cls(manifest)
        logger.debug(f"Loaded: {manifest_id} ({adapter_name})")

    # ── Hot-reload triggers ───────────────────────────────────────────────────

    def reload(self) -> dict:
        """
        Hot-reload all manifests.
        Safe to call from any thread (lock protected).
        Returns summary dict for the HTTP endpoint response.
        """
        logger.info("Hot-reload triggered — re-reading registry YAML files...")
        self.load_all()
        return {
            "status": "reloaded",
            "reload_count": self._reload_count,
            "sources": list(self._manifests.keys()),
        }

    def start_watcher(self) -> None:
        """
        Start a watchdog filesystem observer that automatically hot-reloads
        whenever a *.yaml file is created, modified, or deleted in registry/.

        Called from main.py lifespan startup so the watcher runs for the entire
        lifetime of the application — no manual triggers needed during the demo.
        """
        if not self._dir.exists():
            logger.warning(f"Registry directory '{self._dir}' not found — filesystem watcher not started")
            return

        try:
            from watchdog.observers import Observer
            from watchdog.events import FileSystemEventHandler, FileModifiedEvent, FileCreatedEvent, FileDeletedEvent
        except ImportError:
            logger.warning("watchdog not installed — filesystem hot-reload disabled. Run: pip install watchdog")
            return

        registry_loader = self  # capture reference for the handler closure

        class YAMLChangeHandler(FileSystemEventHandler):
            """Watchdog event handler — reacts to YAML file changes."""

            def _is_yaml(self, path: str) -> bool:
                return path.endswith(".yaml") or path.endswith(".yml")

            def on_modified(self, event):
                if not event.is_directory and self._is_yaml(event.src_path):
                    fname = Path(event.src_path).name
                    logger.info(f"Registry watcher: '{fname}' modified — reloading...")
                    registry_loader.reload()

            def on_created(self, event):
                if not event.is_directory and self._is_yaml(event.src_path):
                    fname = Path(event.src_path).name
                    logger.info(f"Registry watcher: '{fname}' created — reloading...")
                    registry_loader.reload()

            def on_deleted(self, event):
                if not event.is_directory and self._is_yaml(event.src_path):
                    fname = Path(event.src_path).name
                    logger.info(f"Registry watcher: '{fname}' deleted — reloading...")
                    registry_loader.reload()

        observer = Observer()
        observer.schedule(YAMLChangeHandler(), str(self._dir), recursive=False)
        observer.daemon = True  # dies cleanly when main process exits
        observer.start()
        self._observer = observer
        logger.info(f"Registry watcher started — watching '{self._dir}' for YAML changes")

    def stop_watcher(self) -> None:
        """Stop the filesystem observer. Called from lifespan shutdown."""
        if self._observer and self._observer.is_alive():
            self._observer.stop()
            self._observer.join(timeout=3)
            logger.info("Registry watcher stopped")

    # ── Accessors ─────────────────────────────────────────────────────────────

    def get_manifest(self, manifest_id: str) -> dict:
        if manifest_id not in self._manifests:
            raise KeyError(f"Unknown source ID: '{manifest_id}'. Available: {list(self._manifests.keys())}")
        return self._manifests[manifest_id]

    def get_adapter(self, manifest_id: str) -> DataSourceAdapter:
        if manifest_id not in self._adapters:
            raise KeyError(f"Unknown source ID: '{manifest_id}'")
        return self._adapters[manifest_id]

    def manifest_ids(self) -> Iterator[str]:
        return iter(self._manifests.keys())

    def all_manifests(self) -> list[dict]:
        return list(self._manifests.values())

    @property
    def reload_count(self) -> int:
        return self._reload_count
