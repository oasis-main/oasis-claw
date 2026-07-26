# oasis-voice — agent notes

Survival notes for the in-container agent (you) when something is wrong with the voice sidecar. Read before you start poking at containers.

## Where things live

- Sidecar source (canonical): sister repo `oasis-voice/`. Vendored submodule at `vendor/oasis-voice/` is what the image builds from.
- Image: `oasis-voice:cpu`. Built once via `(cd vendor/oasis-voice && docker build -f docker/Dockerfile.cpu -t oasis-voice:cpu .)`.
- Container: named `oasis-voice` on the `oasis_runtime` bridge network. No host port — only reachable from inside the openclaw container at `http://oasis-voice:8731`.
- Weights live on the named volume `oasis_voice_weights` mounted at `/srv/weights` (`XDG_CACHE_HOME`). Wiping Docker also wipes this volume; weights redownload on first boot (~50 MB, ~60 s).

## Routes

- `GET /healthz` — cheap liveness. Post-fix it reports `stt_loaded`/`tts_loaded` based on actual warmup state, and a separate `stt_instantiated`/`tts_instantiated` for the "did the FastAPI lifespan create the backend object" question.
- `GET /v1/tiers` — what tier each backend is on and what's compiled in.
- `POST /v1/stt/transcribe` (multipart, field `audio`) — single-shot STT, returns `{text, is_final, start_ms, end_ms, confidence, language}`.
- `WS /v1/stt/stream?sample_rate=16000` — frames in, partial+final chunks out.
- `POST /v1/tts/speak?format=wav|opus` (JSON body `{text, voice?}`) — full WAV (or OGG/Opus voice-note) back.
- `WS /v1/tts/stream` — sentence-by-sentence streaming PCM.
- `POST /v1/voice/clone` / `GET /v1/voices` — only meaningful on tiers that support cloning.

## Warmup behavior (post-fix, 2026-05-13)

The compose file sets `VOICE_SKIP_WARMUP=1` so boot is fast and the healthcheck passes inside its 30 s grace window. Models lazy-load on the first real request. The first call to `/v1/stt/transcribe` or `/v1/tts/speak` will be ~200–500 ms slower than subsequent calls (Moonshine's first call also has to download the model from HF — that's a one-off ~30 s on a fresh volume). Concurrent first requests are safe: the warmup is guarded by an asyncio.Lock per backend.

**If you see `RuntimeError: MoonshineBackend.warmup() must be called first` in the logs**, the image you're running predates the lazy-load fix. Rebuild the image from `vendor/oasis-voice` HEAD. The pre-fix `_require_stt` checked only `_stt is not None` and never actually loaded the model when `VOICE_SKIP_WARMUP=1` was set.

## Voice + weights (post-fix, 2026-05-13)

Default voice is **`en_GB-aru-medium`** (UK Aru, RP accent, medium quality), set via `VOICE_PIPER_DEFAULT_VOICE` in compose. Don't rely on `piper.py`'s upstream default — that's `en_US-lessac-high` and doesn't match what we ship.

Multi-speaker models (e.g. `en_GB-vctk-medium`, 109 speakers) are supported via `#speaker` suffix: `piper:en_GB-vctk-medium#p236`. The speaker name is resolved from the model's `.onnx.json` sidecar `speaker_id_map`. Numeric IDs also work (`#0`).

Both `XDG_CACHE_HOME` AND `XDG_DATA_HOME` must point to `/srv/weights` in compose. They serve different consumers — `XDG_DATA_HOME` is what `piper.py` and `download_weights.py` use to resolve voice files; `XDG_CACHE_HOME` is the HF/onnxruntime cache home (Moonshine downloads via `hf_hub_download` land at `$XDG_CACHE_HOME/huggingface`).

Volume layout after first-boot population:
```
/srv/weights/
  oasis-voice/piper/en_GB-aru-medium.onnx        # ~63 MB
  oasis-voice/piper/en_GB-aru-medium.onnx.json
  huggingface/                                    # Moonshine model + tokenizer (~140 MB)
```

If you hit `PermissionError: '/srv/weights/huggingface'` on a fresh volume, the Dockerfile.cpu fix (mkdir + chmod 1777 at build time) wasn't picked up. Recover with `docker exec --user root oasis-voice sh -c 'chmod 1777 /srv/weights && mkdir -p /srv/weights/huggingface && chmod 777 /srv/weights/huggingface'` once, then retry. Note `cap_drop: ALL` blocks chown from inside the container — chmod from root works because the container's root maps through to the host's docker-volume metadata.

## Diagnosis order when voice breaks

1. **Is the container up?** `docker ps --filter name=oasis-voice`. Status `Exited` means rebuild/restart; check `docker logs oasis-voice` for crash reason.
2. **Can openclaw reach it?** From inside the openclaw container: `curl -s http://oasis-voice:8731/healthz`. The sidecar is *not* reachable from the host Mac — that's intentional.
3. **TTS first, STT second.** TTS exercises piper + the audio module without the model-load gauntlet. `curl -sX POST http://oasis-voice:8731/v1/tts/speak -H 'content-type: application/json' -d '{"text":"hi"}' -o /tmp/t.wav`. If that 500s, the entire sidecar is sick; if it succeeds and STT still 500s, suspect Moonshine specifically.
4. **STT roundtrip.** Feed the TTS WAV back: `curl -sX POST -F audio=@/tmp/t.wav http://oasis-voice:8731/v1/stt/transcribe`.

## TTS input rules (injected into the gateway's memory prompt)

The plugin pushes a behavioural rule into every agent's memory prompt via `api.registerMemoryPromptSupplement` (see `TTS_INPUT_RULES` at the top of `index.ts`). The rule tells the model: **strip emojis from any reply destined for `/v1/tts/speak`** (Telegram voice notes, Twilio telephony) because Piper reads emoji aloud as their literal Unicode name ("face with tears of joy") — jarring in audio. Punctuation, em-dashes and ellipses map to prosody and stay. Narrow exception: keep the emoji if the *audible pronunciation itself* is the joke.

If you need to edit the rule, do it in `index.ts` (the runtime source of truth). Don't duplicate the text here — it'll drift.

## Don't

- Don't change `VOICE_SKIP_WARMUP=1` to `0` to "fix" missing warmup. The lazy-load gate exists; if it's broken, fix the gate. Removing the env var makes container boot block on model load (Moonshine + Piper can take 10–20 s) and the healthcheck `start_period: 30s` may not be enough on a busy laptop, leading to restart loops.
- Don't add a `contracts` block to `openclaw.plugin.json`. The long `_contracts_NOTE` field explains why — the openclaw 2026.4.26 loader flips `startup.sidecar` to false when any provider-capability key is declared, and the lazy-load fallback never fires for non-bundled plugins like this one. Eager-load at boot is the working path.
- Don't expose port 8731 to the host. The sidecar has no auth; the bridge-network boundary is the only thing keeping it private.
