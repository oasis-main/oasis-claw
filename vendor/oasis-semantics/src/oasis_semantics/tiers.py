"""
Declarative registry of embedding tiers.

Mirrors the oasis-voice tiers.py structure (TierSpec dataclass, frozen,
permissive-license-only literal). Selected tiers are loaded lazily on first
request — only the model named in OASIS_SEMANTICS_DEFAULT_TEXT_MODEL /
OASIS_SEMANTICS_DEFAULT_MM_MODEL is warmed at boot, the rest stay cold.

Adding a tier:
  1. Add an entry below with a real sha256 from upstream weights (or {} to skip
     verification until the first download_weights run pins them).
  2. Add the matching backend module under embedders/.
  3. Add a smoke fixture under tests/fixtures/<tier> if you want CI coverage.

Removing a tier:
  - Delete the entry; tests that reference it will fail loudly. Do not leave
    a non-permissive model in place behind a "feature flag" — the license
    posture is a hard constraint, not a default.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ModalityT = Literal["text", "multimodal", "rerank"]
LicenseT = Literal["MIT", "Apache-2.0", "CC-BY-4.0"]
# Hard constraint at type-check time. CC-BY-NC, CPML, research-only entries
# do not type-check here — they cannot be silently added.


@dataclass(frozen=True)
class TierSpec:
    name: str                     # short id, used in /api/embed `model` field
    modality: ModalityT
    backend: str                  # python module under embedders/, e.g. "text", "multimodal"
    weights: str                  # HF repo id, "<org>/<repo>"
    revision: str                 # commit sha or release tag — never "main"
    sha256: dict[str, str]        # filename → expected hash for download verifier
    dim: int                      # output embedding dimension
    max_input_tokens: int         # truncation budget
    requires_gpu: bool
    vram_gb: int                  # 0 if CPU is enough; informational
    license: LicenseT
    languages: tuple[str, ...]    # ISO-639-1 codes; ("multi",) for many
    notes: str = ""


# ────────────────────────────────── TEXT ────────────────────────────────────

TEXT_TIERS: dict[str, TierSpec] = {
    "lite": TierSpec(
        name="lite",
        modality="text",
        backend="text",
        weights="sentence-transformers/all-MiniLM-L6-v2",
        revision="TBD",                  # pin before first deploy
        sha256={},
        dim=384,
        max_input_tokens=256,
        requires_gpu=False,
        vram_gb=0,
        license="Apache-2.0",
        languages=("en",),
        notes="22M params. Cheapest baseline; good enough for the memory-core "
              "anchor while we benchmark heavier tiers.",
    ),
    "default": TierSpec(
        name="default",
        modality="text",
        backend="text",
        weights="BAAI/bge-small-en-v1.5",
        revision="TBD",
        sha256={},
        dim=384,
        max_input_tokens=512,
        requires_gpu=False,
        vram_gb=0,
        license="MIT",
        languages=("en",),
        notes="33M params, beats MiniLM on MTEB. Recommended default for English-only.",
    ),
    "multi": TierSpec(
        name="multi",
        modality="text",
        backend="text",
        weights="BAAI/bge-m3",
        revision="TBD",
        sha256={},
        dim=1024,
        max_input_tokens=8192,
        requires_gpu=False,
        vram_gb=0,
        license="MIT",
        languages=("multi",),
        notes="100+ languages, dense + sparse + colbert. ~570M params, still CPU-viable but slower than default.",
    ),
    "large": TierSpec(
        name="large",
        modality="text",
        backend="text",
        weights="nomic-ai/nomic-embed-text-v1.5",
        revision="TBD",
        sha256={},
        dim=768,
        max_input_tokens=8192,
        requires_gpu=False,
        vram_gb=2,
        license="Apache-2.0",
        languages=("en",),
        notes="Matryoshka — dims truncatable to 256/512/768. GPU optional.",
    ),
}


# ─────────────────────────────── MULTIMODAL ─────────────────────────────────

MULTIMODAL_TIERS: dict[str, TierSpec] = {
    "clip-lite": TierSpec(
        name="clip-lite",
        modality="multimodal",
        backend="multimodal",
        weights="openai/clip-vit-base-patch32",
        revision="TBD",
        sha256={},
        dim=512,
        max_input_tokens=77,             # CLIP's notorious context limit
        requires_gpu=False,
        vram_gb=0,
        license="MIT",
        languages=("en",),
        notes="~150 MB. CPU OK. Image + text in same embedding space. Image search by description, etc.",
    ),
    "siglip": TierSpec(
        name="siglip",
        modality="multimodal",
        backend="multimodal",
        weights="google/siglip-base-patch16-224",
        revision="TBD",
        sha256={},
        dim=768,
        max_input_tokens=64,
        requires_gpu=False,
        vram_gb=2,
        license="Apache-2.0",
        languages=("en",),
        notes="Sigmoid-loss CLIP variant; better zero-shot. GPU recommended; CPU usable for low throughput.",
    ),
    # NOTE: jinaai/jina-clip-v2 is CC-BY-NC-4.0 → excluded by LicenseT.
    # If we ever need it we'd quarantine it behind a separate non-commercial
    # build, not feature-flag it into this image.
}


# ─────────────────────────────── RERANK ─────────────────────────────────────

RERANK_TIERS: dict[str, TierSpec] = {
    "bge-base": TierSpec(
        name="bge-base",
        modality="rerank",
        backend="rerank",
        weights="BAAI/bge-reranker-base",
        revision="TBD",
        sha256={},
        dim=1,                            # rerankers emit a score, not a vector
        max_input_tokens=512,
        requires_gpu=False,
        vram_gb=0,
        license="MIT",
        languages=("en",),
        notes="Pair with text:default. Boosts recall@k for retrieval pipelines.",
    ),
}


def all_tiers() -> dict[str, TierSpec]:
    """Used by /v1/tiers — flat view for the HTTP API."""
    return {**TEXT_TIERS, **MULTIMODAL_TIERS, **RERANK_TIERS}


def resolve(name: str) -> TierSpec:
    table = all_tiers()
    if name not in table:
        # Also accept the full HF repo id so callers can pass either form.
        for tier in table.values():
            if tier.weights == name or tier.weights.split("/")[-1] == name:
                return tier
        raise KeyError(
            f"Unknown tier '{name}'. Available: {sorted(table)}"
        )
    return table[name]
