"""
Text embeddings via sentence-transformers. Handles tiers: lite, default,
multi, large.
"""

from __future__ import annotations

from typing import Any

from ..tiers import TierSpec


class TextEmbedder:
    tier: TierSpec

    def __init__(self, tier: TierSpec):
        # Local import — defer the torch + sentence-transformers cost until a
        # tier of this backend is actually requested.
        from sentence_transformers import SentenceTransformer

        self.tier = tier
        self._model = SentenceTransformer(
            tier.weights,
            revision=tier.revision if tier.revision != "TBD" else None,
            device="cpu" if not tier.requires_gpu else "cuda",
        )

    def embed_text(self, texts: list[str]) -> list[list[float]]:
        # `normalize_embeddings=True` is the standard for cosine-similarity
        # downstream; memory-core assumes unit-norm vectors.
        vectors = self._model.encode(
            texts,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        return vectors.tolist()

    def embed_multimodal(self, inputs: list[dict[str, Any]]) -> list[list[float]]:
        raise NotImplementedError(
            f"tier {self.tier.name} is text-only; use a multimodal tier for image inputs"
        )


def build(tier: TierSpec) -> TextEmbedder:
    return TextEmbedder(tier)
