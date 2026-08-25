"""
YAML Plugin Registry Loader

Walks registry/*.yaml, validates schema, instantiates adapters.
Supports hot-reload on SIGHUP so the live demo (§16 Step 5) can add a new
YAML file and have it appear in the frontend layer selector without restart.

This is the concrete implementation of the "extensible design" requirement (§2):
  Adding a new sensor = adding a new YAML file. Zero new code. (§20 Rule 6)
"""

from __future__ import annotations

import logging
import os
import signal
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
    """

    def __init__(self, registry_dir: str):
        self._dir = Path(registry_dir)
        self._manifests: dict[str, dict] = {}
        self._adapters: dict[str, DataSourceAdapter] = {}

    def load_all(self) -> None:
        """Load all *.yaml files from the registry directory."""
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

        logger.info(f"Registry: loaded {len(self._manifests)} manifests: {list(self._manifests.keys())}")

        # ── Register SIGHUP handler for live reload ───────────────────────────
        # On POSIX: `kill -HUP <pid>` triggers reload without restart
        try:
            signal.signal(signal.SIGHUP, lambda sig, frame: self.reload())
        except (AttributeError, OSError):
            pass  # SIGHUP not available on Windows — skip

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

    def reload(self) -> None:
        """Hot-reload all manifests — called on SIGHUP or from the live demo."""
        logger.info("Hot-reloading registry...")
        self.load_all()

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
