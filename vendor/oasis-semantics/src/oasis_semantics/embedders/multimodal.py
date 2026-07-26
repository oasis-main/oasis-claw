"""
Multimodal embeddings via transformers (CLIP / SigLIP). Both text and image
go through the same model and land in the same vector space — that's the
whole point of CLIP-style training.

Input format per item:
  {"text": "..."}                       — text
  {"image_bytes": <base64 or bytes>}    — image, raw bytes or base64-encoded
  {"image_url": "https://..."}          — image, fetched via httpx
"""

from __future__ import annotations

import base64
import io
from typing import Any

from ..tiers import TierSpec


class MultimodalEmbedder:
    tier: TierSpec

    def __init__(self, tier: TierSpec):
        from transformers import AutoModel, AutoProcessor
        import torch

        self.tier = tier
        self._torch = torch
        device = "cuda" if tier.requires_gpu else "cpu"
        self._device = device
        kwargs = {}
        if tier.revision != "TBD":
            kwargs["revision"] = tier.revision
        self._processor = AutoProcessor.from_pretrained(tier.weights, **kwargs)
        self._model = AutoModel.from_pretrained(tier.weights, **kwargs).to(device).eval()

    def embed_text(self, texts: list[str]) -> list[list[float]]:
        torch = self._torch
        with torch.no_grad():
            inputs = self._processor(text=texts, return_tensors="pt", padding=True, truncation=True).to(self._device)
            features = self._model.get_text_features(**inputs)
            features = torch.nn.functional.normalize(features, dim=-1)
        return features.cpu().tolist()

    def embed_multimodal(self, inputs: list[dict[str, Any]]) -> list[list[float]]:
        torch = self._torch
        from PIL import Image

        # Split into text vs image batches, embed separately, reassemble in
        # original order. Cleaner than per-item single calls.
        text_items: list[tuple[int, str]] = []
        image_items: list[tuple[int, Image.Image]] = []

        for idx, item in enumerate(inputs):
            if "text" in item:
                text_items.append((idx, item["text"]))
            elif "image_bytes" in item:
                raw = item["image_bytes"]
                if isinstance(raw, str):
                    raw = base64.b64decode(raw)
                image_items.append((idx, Image.open(io.BytesIO(raw)).convert("RGB")))
            elif "image_url" in item:
                # Synchronous fetch — sidecar callers run their own concurrency.
                import httpx
                resp = httpx.get(item["image_url"], timeout=15.0, follow_redirects=True)
                resp.raise_for_status()
                image_items.append((idx, Image.open(io.BytesIO(resp.content)).convert("RGB")))
            else:
                raise ValueError(f"input item {idx} has no text/image_bytes/image_url")

        results: dict[int, list[float]] = {}

        if text_items:
            texts = [t for _, t in text_items]
            text_vecs = self.embed_text(texts)
            for (idx, _), vec in zip(text_items, text_vecs, strict=True):
                results[idx] = vec

        if image_items:
            images = [im for _, im in image_items]
            with torch.no_grad():
                img_inputs = self._processor(images=images, return_tensors="pt").to(self._device)
                feats = self._model.get_image_features(**img_inputs)
                feats = torch.nn.functional.normalize(feats, dim=-1)
            for (idx, _), vec in zip(image_items, feats.cpu().tolist(), strict=True):
                results[idx] = vec

        return [results[i] for i in range(len(inputs))]


def build(tier: TierSpec) -> MultimodalEmbedder:
    return MultimodalEmbedder(tier)
