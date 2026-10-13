import { autoreviewerCall, DEFAULT_AUTOREVIEWER_URL } from "../grants.js";

export interface ReachGrantRequestConfig {
  /** Default http://oasis-autoreviewer:8791 (OASIS_AUTOREVIEWER_URL). */
  autoreviewerUrl?: string;
}

const WAIT_DEFAULT_S = 240;
const WAIT_MAX_S = 540;

/**
 * reach_grant_request (CLAW-119) — ask Mike, through the autoreviewer bot's
 * Telegram card, for a standing grant BEFORE mailing a peer for work. The
 * autoreviewer bot names this bot from its network address, so the request
 * cannot claim to come from another bot. Mike answers with a button; this tool
 * waits for the answer up to wait_s seconds and then reports the status.
 */
export function createReachGrantRequestTool(config: ReachGrantRequestConfig = {}) {
  const base = config.autoreviewerUrl || DEFAULT_AUTOREVIEWER_URL;
  return {
    name: "reach_grant_request",
    description:
      "Ask Mike for a peer grant before you mail a peer for work that would otherwise need his approval. A grant lets the named grantees act on ONE mail thread, within the topic and intent you state, for up to 24 h. Mike sees your topic and intent on a Telegram card and presses Grant or Deny. On approval, send the work with reach_send using the same thread_id and grant_id. Keep the intent concrete and narrow: what the grantee may do, where, and what it must not do.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["grantees", "thread_id", "topic", "intent", "ttl_hours"],
      properties: {
        grantees: { type: "array", items: { type: "string" }, description: "Peer bot keys that may act under the grant." },
        thread_id: { type: "string", description: "The mail thread the grant covers (1-80 chars of A-Z a-z 0-9 _ . : -). Use the same value on reach_send." },
        topic: { type: "string", description: "One line: what the work is about (<= 200 chars)." },
        intent: { type: "string", description: "What the grantees may do, concretely, and any limits (<= 1000 chars)." },
        ttl_hours: { type: "number", description: "Requested duration in hours, at most 24. Mike can choose a different one." },
        families: { type: "array", items: { type: "string", enum: ["exec", "file", "web", "other"] }, description: "Optional: limit the grant to these tool families." },
        path_prefixes: { type: "array", items: { type: "string" }, description: "Optional: limit file work to these absolute path prefixes." },
        max_actions: { type: "number", description: "Optional: at most this many approval-needing actions under the grant (1-500)." },
        wait_s: { type: "number", description: `Seconds to wait for Mike's answer (default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S}). On a timeout the request stays open; call again with the same values to keep waiting.` },
      },
    },
    async execute(_toolCallId: string, args: Record<string, unknown> = {}) {
      const { wait_s, ...proposal } = args;
      const waitS = Math.min(Math.max(Number(wait_s ?? WAIT_DEFAULT_S) || WAIT_DEFAULT_S, 0), WAIT_MAX_S);
      const text = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });
      try {
        const post = await autoreviewerCall(base, "POST", "/v1/grants", proposal, 20_000);
        if (post.status !== 200 && post.status !== 201) {
          return text(`reach_grant_request refused (HTTP ${post.status}): ${String(post.json.error ?? "unknown error")}`);
        }
        const grant = post.json.grant as { id: string; status: string };
        let current = grant;
        if (current.status === "proposed" && waitS > 0) {
          const got = await autoreviewerCall(base, "GET", `/v1/grants/${grant.id}?wait_ms=${waitS * 1000}`, undefined, waitS * 1000 + 15_000);
          current = (got.json.grant as typeof grant) ?? current;
        }
        const next: Record<string, string> = {
          active: `Approved. Send the work with reach_send using thread_id and grant_id "${current.id}".`,
          proposed: "Mike has not answered yet. The request stays open for up to 1 h; call reach_grant_request again with the same values to keep waiting.",
          denied: "Mike denied the grant. Do not send the request under a grant; ask Mike directly if the work is still needed.",
          lapsed: "Mike did not answer in time. Ask again later or ask Mike directly.",
          revoked: "The grant was revoked.",
        };
        return text({ grant: current, next: next[current.status] ?? "" });
      } catch (err) {
        return text(`reach_grant_request failed: ${String((err as Error)?.message ?? err)}. The autoreviewer bot may be down; ask Mike directly.`);
      }
    },
  };
}
