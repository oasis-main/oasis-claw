// /genroute — choose where THIS bot's oasis-generation calls are served:
// "local" (the gateway on the Mac) or "cloud" (the Hetzner VM gateway).
//
// The switch lives in the Mac gateway (oasis-generation remote.py, GEN-008), keyed
// by this bot's service token. The bot keeps one provider and one baseUrl, so no
// egress, config or recreate changes. The gateway lets a token switch only its
// own client, and audits every change. The observatory switches any bot with an
// admin token that no bot holds.
//
// Deliberately a slash command only, never an agent tool: plugin commands run
// before the agent and only for authorised senders (requireAuth), so the model
// itself has no tool to move its own traffic.

export type RouteTarget = "local" | "remote";

export interface SelfRoute {
  client: string;
  target: RouteTarget;
  targets: RouteTarget[];
  remote_configured: boolean;
  may_switch: boolean;
}

type SecretRef = { source?: string; provider?: string; id?: string };

const ARG_TARGETS: Readonly<Record<string, RouteTarget>> = {
  local: "local",
  mac: "local",
  cloud: "remote",
  remote: "remote",
  vm: "remote",
  hetzner: "remote",
};

export function parseRouteArg(raw: string): RouteTarget | "status" | null {
  const arg = raw.trim().toLowerCase();
  if (!arg || arg === "status" || arg === "help") return "status";
  return ARG_TARGETS[arg] ?? null;
}

/** Resolve the provider apiKey: a plain string, or an env SecretRef. Never logs it. */
export function resolveApiKey(apiKey: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof apiKey === "string") return apiKey;
  const ref = apiKey as SecretRef | undefined;
  if (ref && ref.source === "env" && typeof ref.id === "string") return env[ref.id] ?? "";
  return "";
}

export function label(target: RouteTarget): string {
  return target === "remote" ? "cloud (Hetzner VM gateway)" : "local (Mac gateway)";
}

export function renderRouteStatus(r: SelfRoute): string {
  const lines = [
    `oasis-generation route for ${r.client}: ${label(r.target)}`,
    `Cloud gateway configured: ${r.remote_configured ? "yes" : "no"}`,
  ];
  if (!r.may_switch) lines.push("This bot may not switch itself; use the observatory.");
  lines.push("", "Usage: /genroute local | /genroute cloud | /genroute status");
  return lines.join("\n");
}

export async function routeRequest(
  baseUrl: string,
  token: string,
  method: "GET" | "PUT",
  target?: RouteTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/routing/self`;
  try {
    const resp = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method === "PUT" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "PUT" ? JSON.stringify({ target }) : undefined,
    });
    const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (!resp.ok) {
      const detail = typeof body.detail === "string" ? body.detail : `HTTP ${resp.status}`;
      return { ok: false, error: detail };
    }
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: `gateway unreachable: ${(err as Error).message}` };
  }
}
