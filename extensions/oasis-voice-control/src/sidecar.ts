const DEFAULT_ENDPOINT = "http://oasis-voice:8731";

export type VoicePreset = {
  voice_id: string;
  speakers: string[];
};

export type VoicesResponse = {
  presets: VoicePreset[];
  cloned: VoicePreset[];
  backend?: string;
  supports_cloning?: boolean;
};

export type SidecarConfig = {
  endpoint: string;
  bearer?: string;
};

export function resolveSidecar(cfg: { endpoint?: string; bearer_token?: string }): SidecarConfig {
  return {
    endpoint: (process.env.OASIS_VOICE_ENDPOINT || cfg.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, ""),
    bearer: process.env.OASIS_VOICE_BEARER_TOKEN || cfg.bearer_token || undefined,
  };
}

/**
 * Fetch the installed voice registry.
 *
 * GET /v1/voices is deliberately cheap on the sidecar side — it is a directory
 * walk and does NOT warm the TTS backend, so calling it to decide which voice to
 * use costs nothing. See TTSBackend.list_presets in oasis-voice.
 */
export async function fetchVoices(sc: SidecarConfig, timeoutMs = 10_000): Promise<VoicesResponse> {
  const headers: Record<string, string> = {};
  if (sc.bearer) {
    headers["Authorization"] = `Bearer ${sc.bearer}`;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${sc.endpoint}/v1/voices`, { headers, signal: ctl.signal });
    if (!res.ok) {
      throw new Error(`oasis-voice /v1/voices returned ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as VoicesResponse;
    return {
      presets: Array.isArray(body?.presets) ? body.presets : [],
      cloned: Array.isArray(body?.cloned) ? body.cloned : [],
      backend: body?.backend,
      supports_cloning: body?.supports_cloning,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Every selectable id, including "voice#speaker" forms for multi-speaker voices. */
export function selectableIds(v: VoicesResponse): string[] {
  const out: string[] = [];
  for (const p of [...v.presets, ...v.cloned]) {
    if (!p?.voice_id) {
      continue;
    }
    if (Array.isArray(p.speakers) && p.speakers.length > 0) {
      // A multi-speaker model has no meaningful "bare" identity — the caller
      // must pick a speaker, so only the qualified forms are offered.
      for (const s of p.speakers) {
        out.push(`${p.voice_id}#${s}`);
      }
    } else {
      out.push(p.voice_id);
    }
  }
  return out;
}
