"""
Lazy backend registry. Backends are imported only when the first request for a
tier of that backend type arrives — avoids paying the torch + transformers
import cost (~3-5s) at boot when nothing has called yet.

Pattern mirrors oasis-voice/src/oasis_voice/loader.py.
"""

from __future__ import annotations

import importlib
import threading
from typing import Protocol

from ..tiers import TierSpec


class Embedder(Protocol):
    """Common interface every backend implements."""

    tier: TierSpec

    def embed_text(self, texts: list[str]) -> list[list[float]]: ...
    def embed_multimodal(self, inputs: list[dict]) -> list[list[float]]: ...
    # `inputs` items shaped {"text": "..."} | {"image_bytes": b"..."} | {"image_url": "..."}


_loaded: dict[str, Embedder] = {}
_lock = threading.Lock()


def get(tier: TierSpec) -> Embedder:
    """Return the embedder for `tier`, loading on first request."""
    if tier.name in _loaded:
        return _loaded[tier.name]
    with _lock:
        if tier.name in _loaded:
            return _loaded[tier.name]
        module = importlib.import_module(f"oasis_semantics.embedders.{tier.backend}")
        embedder = module.build(tier)
        _loaded[tier.name] = embedder
        return embedder


def loaded_names() -> list[str]:
    return sorted(_loaded.keys())
