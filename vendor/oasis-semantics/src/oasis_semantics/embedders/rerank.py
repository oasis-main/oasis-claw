"""
Cross-encoder reranking. Handles the `rerank` backend (tier bge-base /
BAAI/bge-reranker-base).

A reranker is NOT an embedder, and the difference is the whole point of having
one. An embedder maps a query and a document into a vector space SEPARATELY,
then compares them by cosine distance — cheap, indexable, and lossy, because the
two texts never meet before the comparison. A cross-encoder feeds the query and
the document through the model TOGETHER and emits a single relevance score, so
it can weigh terms in the document against the specific question asked. That is
much more accurate and far too expensive to run over a whole corpus.

So the two compose, they do not compete: embeddings pick a candidate pool out of
thousands of chunks, and the cross-encoder reorders that pool. A reranker cannot
retrieve — score a document it never receives and the answer is silence. Whatever
the embedding stage misses is missed for good.

This backend lives under embedders/ so the lazy `embedders.get(tier)` registry
in __init__.py can find it by `tier.backend` like any other. It satisfies the
Embedder protocol by REFUSING both embed methods rather than by faking them: a
reranker emits a scalar score (tier.dim == 1), not a vector, and returning that
scalar where a caller expects an embedding would corrupt an index silently.
"""

from __future__ import annotations

from typing import Any

from ..tiers import TierSpec


class Reranker:
    tier: TierSpec

    def __init__(self, tier: TierSpec):
        # Local import — defer the torch + sentence-transformers cost until a
        # tier of this backend is actually requested (same rule as text.py).
        from sentence_transformers import CrossEncoder

        self.tier = tier
        self._model = CrossEncoder(
            tier.weights,
            revision=tier.revision if tier.revision != "TBD" else None,
            # The cross-encoder truncates the CONCATENATED query+document pair,
            # so an over-long document silently loses its tail — and with it the
            # passage that may have made it relevant. Pinning to the tier's own
            # declared budget keeps that limit visible in tiers.py instead of
            # buried in a model default.
            max_length=tier.max_input_tokens,
            device="cpu" if not tier.requires_gpu else "cuda",
        )

    def rerank(self, query: str, documents: list[str]) -> list[float]:
        """Score each document against the query. Order matches `documents`."""
        if not documents:
            return []
        pairs = [[query, doc] for doc in documents]
        scores = self._model.predict(
            pairs,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        # num_labels == 1, so sentence-transformers applies Sigmoid by default
        # and the score is a 0..1 relevance, NOT a raw logit. Measured range on
        # this tier: 0.9998 for an obviously-correct pair, 0.0 for an unrelated
        # one — so a threshold IS meaningful here, unlike with a logit model.
        # Calibrate it per corpus rather than assuming 0.5.
        #
        # CAVEAT worth knowing before trusting a score: bge-reranker-base is
        # trained on natural-language question/passage pairs. It scores PROSE
        # well and raw code signatures poorly — measured 0.0006 for a correct
        # `def process_exit_fires(...)` match against a plain-English question,
        # even though it still ranked that document FIRST. Ordering stayed
        # right; the absolute number did not. Feed it docstrings and prose
        # summaries, not bare signatures.
        return [float(s) for s in scores]

    def embed_text(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError(
            f"tier {self.tier.name} is a reranker; it scores query/document pairs "
            "and cannot produce embeddings — use a text tier"
        )

    def embed_multimodal(self, inputs: list[dict[str, Any]]) -> list[list[float]]:
        raise NotImplementedError(
            f"tier {self.tier.name} is a reranker; use a multimodal tier for image inputs"
        )


def build(tier: TierSpec) -> Reranker:
    return Reranker(tier)
