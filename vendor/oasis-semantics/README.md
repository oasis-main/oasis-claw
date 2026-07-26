# oasis-semantics

Multimodal embedding sidecar for openclaw / oasis-claw. License-clean
(MIT / Apache-2.0 / CC-BY-4.0 only — same posture as oasis-voice).

## Why

memory-core needs an embedding provider. OpenAI's API quota is fragile and
expensive; we want a local-first option that also lets us experiment with
multimodal (image + text) embeddings down the road. This is the sidecar.

## Wire formats

The service speaks two shapes. Both are consumed by the dedicated
`extensions/oasis-semantics/` openclaw plugin (NOT via the ollama plugin —
ollama's embedding path is a bolt-on to an inference engine and would force
every future hook through a shape that wasn't designed for it).

### Text-only (`/api/embed`)

```
POST /api/embed
{
  "model": "default",                  // or "lite" / "multi" / "large" / HF repo id
  "input": "string OR [strings]"
}
→ {"model": "default", "embeddings": [[...], ...], "total_duration": 0}
```

Happens to match Ollama's wire format. Useful for curl/Postman ad-hoc
debugging and as an interop point if something external ever wants text
embeddings, but it is NOT the architectural rationale — the openclaw plugin
calls this directly, not via the ollama plugin's baseUrl override.

### Multimodal (`/v1/embed/multimodal`)

```
POST /v1/embed/multimodal
{
  "model": "clip-lite",                // or "siglip"
  "inputs": [
    {"text": "a coral reef"},
    {"image_bytes": "<base64 PNG/JPEG>"},
    {"image_url": "https://..."}
  ]
}
→ {"model": "clip-lite", "embeddings": [[...]], "dim": 512}
```

Text and images embed into the **same vector space** (the whole point of
CLIP-style training). This is what makes "find the photo Mike sent that
looked like this description" work. The plugin wires this into memory-core
via the multimodal `embedBatchInputs` hook.

## Tiers

See [tiers.py](src/oasis_semantics/tiers.py). Briefly:

| Modality | Tier | Backend / weights | CPU? | License | Notes |
|---|---|---|---|---|---|
| text | `lite` | `sentence-transformers/all-MiniLM-L6-v2` | ✅ | Apache-2.0 | 384-d, 22M params |
| text | `default` | `BAAI/bge-small-en-v1.5` | ✅ | MIT | 384-d, **recommended default** |
| text | `multi` | `BAAI/bge-m3` | ✅ (slow) | MIT | 1024-d, 100+ languages, 8192-tok context |
| text | `large` | `nomic-ai/nomic-embed-text-v1.5` | GPU rec. | Apache-2.0 | 768-d matryoshka |
| mm   | `clip-lite` | `openai/clip-vit-base-patch32` | ✅ | MIT | 512-d, image+text shared |
| mm   | `siglip`    | `google/siglip-base-patch16-224` | GPU rec. | Apache-2.0 | 768-d, better zero-shot |
| rerank | `bge-base` | `BAAI/bge-reranker-base` | ✅ | MIT | future endpoint |

**Memory-core re-embed cost.** The initial tier choice is load-bearing
because changing dimensions or model family invalidates every stored vector.
Migration IS supported, but only as an explicit, expensive operation: an
openclaw command that walks the memory store, re-embeds each record with
the new tier, writes the new vectors, and drops the old ones — atomic
per-record so a crash mid-migration leaves the store usable. Not silent
fallback, not auto-detect on dim mismatch. Run on purpose when there is a
real reason to switch (e.g. moving from English-only `default` to
multilingual `multi`). `default` (bge-small) is my recommendation for
English-only; `multi` (bge-m3) if multilingual ever matters.

## Local dev

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[text-lite]"            # minimal — just MiniLM
uvicorn oasis_semantics.main:app --reload --port 8732
curl http://localhost:8732/v1/tiers
curl -s http://localhost:8732/api/embed \
  -H 'Content-Type: application/json' \
  -d '{"model":"lite","input":["hello world"]}' | jq '.embeddings[0] | length'
# → 384
```

## Docker

```sh
cd vendor/oasis-semantics
docker build -f docker/Dockerfile.cpu -t oasis-semantics:cpu .
```

Then add the service block to `oasis-claw/docker-compose.runtime.yml` (see
oasis-voice's block for the pattern — same `oasis_runtime` network, no host
port, weights on a named volume).

## License posture

Hard constraint at type-check time: `LicenseT = Literal["MIT", "Apache-2.0",
"CC-BY-4.0"]` in `tiers.py`. Adding a CC-BY-NC / research-only model to the
registry fails to type-check; you can't slip one past with a feature flag.

Notable exclusions:
- **`jinaai/jina-clip-v2`** — CC-BY-NC-4.0. Would otherwise be a great
  multimodal upgrade. Quarantined to a non-commercial build if ever needed,
  not added here.
