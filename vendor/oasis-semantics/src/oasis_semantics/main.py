"""
HTTP entrypoint. FastAPI app with:

  GET  /healthz                — liveness, no model invocation
  GET  /v1/tiers               — advertise registered tiers + which are loaded
  POST /api/embed              — Ollama-compatible text embeddings
                                 (so the openclaw `ollama` plugin can drive
                                  this service via baseUrl override)
  POST /v1/embed/multimodal    — text + image embeddings in the same vector
                                 space (CLIP/SigLIP). Custom shape — needs
                                 the extensions/oasis-semantics openclaw
                                 plugin to consume.

Backends are loaded lazily on first request (see embedders/__init__.py). Set
OASIS_SEMANTICS_SKIP_WARMUP=1 to skip the boot warmup entirely.
"""

from __future__ import annotations

import os
from dataclasses import asdict
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import embedders
from .tiers import all_tiers, resolve

DEFAULT_TEXT_MODEL = os.environ.get("OASIS_SEMANTICS_DEFAULT_TEXT_MODEL", "default")
DEFAULT_MM_MODEL = os.environ.get("OASIS_SEMANTICS_DEFAULT_MM_MODEL", "clip-lite")
SKIP_WARMUP = os.environ.get("OASIS_SEMANTICS_SKIP_WARMUP", "1") == "1"

app = FastAPI(title="oasis-semantics", version="0.0.1")


# ─── request/response models ─────────────────────────────────────────────────


class OllamaEmbedRequest(BaseModel):
    """Matches Ollama's /api/embed wire format."""
    model: str
    input: str | list[str]
    # Ollama also accepts `truncate`, `options`, `keep_alive` — we ignore.


class OllamaEmbedResponse(BaseModel):
    model: str
    embeddings: list[list[float]]
    total_duration: int = 0  # ns, Ollama-compatible field; we always set 0


class MultimodalInput(BaseModel):
    text: str | None = None
    image_bytes: str | None = None  # base64
    image_url: str | None = None


class MultimodalEmbedRequest(BaseModel):
    model: str = Field(default=DEFAULT_MM_MODEL)
    inputs: list[MultimodalInput]


class MultimodalEmbedResponse(BaseModel):
    model: str
    embeddings: list[list[float]]
    dim: int


# ─── lifecycle ───────────────────────────────────────────────────────────────


@app.on_event("startup")
def warmup() -> None:
    if SKIP_WARMUP:
        print("OASIS_SEMANTICS_SKIP_WARMUP=1 — backends will load on first request", flush=True)
        return
    # Warm the configured defaults only.
    for name in (DEFAULT_TEXT_MODEL, DEFAULT_MM_MODEL):
        try:
            embedders.get(resolve(name))
            print(f"warmed tier: {name}", flush=True)
        except Exception as exc:
            print(f"warmup failed for {name}: {exc}", flush=True)


# ─── endpoints ───────────────────────────────────────────────────────────────


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/tiers")
def list_tiers() -> dict[str, Any]:
    return {
        "default": {"text": DEFAULT_TEXT_MODEL, "multimodal": DEFAULT_MM_MODEL},
        "loaded": embedders.loaded_names(),
        "tiers": [
            {k: v for k, v in asdict(t).items() if k != "sha256"}
            for t in all_tiers().values()
        ],
    }


@app.post("/api/embed", response_model=OllamaEmbedResponse)
def ollama_embed(req: OllamaEmbedRequest) -> OllamaEmbedResponse:
    try:
        tier = resolve(req.model)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    if tier.modality not in ("text", "multimodal"):
        raise HTTPException(
            status_code=400,
            detail=f"tier {tier.name} has modality {tier.modality}; /api/embed only does text",
        )
    inputs = [req.input] if isinstance(req.input, str) else list(req.input)
    if not inputs:
        return OllamaEmbedResponse(model=req.model, embeddings=[])

    try:
        emb = embedders.get(tier).embed_text(inputs)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"embed failed: {exc}")
    return OllamaEmbedResponse(model=req.model, embeddings=emb)


@app.post("/v1/embed/multimodal", response_model=MultimodalEmbedResponse)
def multimodal_embed(req: MultimodalEmbedRequest) -> MultimodalEmbedResponse:
    try:
        tier = resolve(req.model)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    if tier.modality != "multimodal":
        raise HTTPException(
            status_code=400,
            detail=f"tier {tier.name} is {tier.modality}; needs a multimodal tier",
        )
    payload = [i.model_dump(exclude_none=True) for i in req.inputs]
    if not payload:
        return MultimodalEmbedResponse(model=req.model, embeddings=[], dim=tier.dim)

    try:
        emb = embedders.get(tier).embed_multimodal(payload)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"embed failed: {exc}")
    return MultimodalEmbedResponse(model=req.model, embeddings=emb, dim=tier.dim)
