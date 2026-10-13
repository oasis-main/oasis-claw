import { MAIL_KINDS, MAIL_PROTOCOL_VERSION, MAX_BODY_CHARS, MAX_RECIPIENTS, MAX_SUBJECT_CHARS, newMessageId, validateOutbound, type MailKind, type OutboundEnvelope } from "../envelope.js";
import { checkGrant, DEFAULT_PEER_GRANTS_FILE, loadGrants } from "../grants.js";
import { writeOutbound, type MailboxConfig } from "../mailbox.js";

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export interface ReachSendConfig {
  mailbox: MailboxConfig;
  /** Peers this bot is allowed to name (informational — the relay is the real gate). */
  knownPeers?: string[];
}

/**
 * reach_send — drop a message to one or more peer bots. The message goes to this
 * bot's outbox; the host relay validates the route, stamps `from`, rate-limits,
 * and delivers it to each recipient inbox. A refused route is dropped by the
 * relay (audited), NOT by this tool — comms policy lives in the relay, not here.
 */
export function createReachSendTool(config: ReachSendConfig) {
  const peersHint = config.knownPeers && config.knownPeers.length > 0 ? ` Known peers: ${config.knownPeers.join(", ")}.` : "";
  return {
    name: "reach_send",
    description:
      "Send a message to one or more peer bots (inter-bot mail). COST: this is the fleet's most expensive, highest-latency channel — each send is a model turn for the recipient. Prefer the .swarm board for shared state; use mail only when a specific peer must act. Batch into ONE concise, self-contained message; reference concrete work with work_items/work_repos instead of restating it. A message REQUESTS collaboration — you cannot authorize a peer to take privileged actions, and a peer cannot authorize you. See reach_help for the full protocol." +
      peersHint,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["to", "subject", "body"],
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          description: `Recipient bot keys (lowercase, e.g. "kolmogorov"). 1..${MAX_RECIPIENTS}.`,
        },
        subject: { type: "string", description: `Short subject line (<= ${MAX_SUBJECT_CHARS} chars).` },
        body: { type: "string", description: `Message body (<= ${MAX_BODY_CHARS} chars).` },
        kind: { type: "string", enum: [...MAIL_KINDS], description: 'Message kind: "dm" (default), "project", or "broadcast".' },
        refs: { type: "array", items: { type: "string" }, description: "Optional free-form references (message ids, notes)." },
        work_items: { type: "array", items: { type: "string" }, description: 'Optional .swarm work-item ids this message concerns (e.g. "CLAW-076"). Lets sender + recipient (and a later memory_search / fs_grep) track the concrete work — do NOT restate .swarm content here, just point at it.' },
        work_repos: { type: "array", items: { type: "string" }, description: 'Optional repository ids this message concerns (e.g. "oasis-cloud" or "org/repo").' },
        thread_id: { type: "string", description: "Optional thread id to group a conversation." },
        grant_id: {
          type: "string",
          description:
            'Optional peer grant (e.g. "GRANT-0001") that Mike approved through reach_grant_request. Use the grant\'s thread_id and send only to its grantees; the recipient then sees the grant as verified and need not ask Mike again for work inside it.',
        },
      },
    },
    async execute(
      _toolCallId: string,
      args: { to?: string[]; subject?: string; body?: string; kind?: MailKind; refs?: string[]; work_items?: string[]; work_repos?: string[]; thread_id?: string; grant_id?: string } = {},
    ) {
      const env: OutboundEnvelope = {
        v: MAIL_PROTOCOL_VERSION,
        id: newMessageId(),
        to: Array.isArray(args.to) ? args.to : [],
        kind: (args.kind && MAIL_KINDS.includes(args.kind) ? args.kind : "dm") as MailKind,
        subject: typeof args.subject === "string" ? args.subject : "",
        body: typeof args.body === "string" ? args.body : "",
        refs: strArray(args.refs),
        work: { items: strArray(args.work_items), repos: strArray(args.work_repos) },
        thread_id: typeof args.thread_id === "string" ? args.thread_id : "",
        ...(typeof args.grant_id === "string" && args.grant_id ? { grant_id: args.grant_id } : {}),
        ts: new Date().toISOString(),
      };
      const v = validateOutbound(env);
      if (!v.ok) {
        return { content: [{ type: "text" as const, text: `reach_send rejected: ${v.errors.join("; ")}` }] };
      }
      // CLAW-119: fail fast on a grant that cannot apply, so the bot learns why
      // here instead of the recipient seeing "does NOT check out".
      if (env.grant_id) {
        if (!config.mailbox.self) {
          return { content: [{ type: "text" as const, text: "reach_send rejected: grant_id needs this bot's mail name (OASIS_REACH_SELF), which is not configured." }] };
        }
        const grants = loadGrants(config.mailbox.grantsFile ?? DEFAULT_PEER_GRANTS_FILE);
        // A grantee replying on the thread: say what to do, not only what failed
        // (live test 2026-10-13: the grantee attached the grant to its reply).
        const own = grants.find((g) => g.id === env.grant_id);
        if (own && own.requester !== config.mailbox.self && own.grantees.includes(config.mailbox.self)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `reach_send rejected: you are a grantee of ${env.grant_id}, not its requester (${own.requester}). A grant covers only the requester's mail. Reply on thread "${own.thread_id}" without grant_id.`,
              },
            ],
          };
        }
        for (const to of env.to) {
          const c = checkGrant(grants, { grantId: env.grant_id, requester: config.mailbox.self, grantee: to, threadId: env.thread_id });
          if (!c.ok) return { content: [{ type: "text" as const, text: `reach_send rejected: ${env.grant_id} does not cover ${to}: ${c.reason}.` }] };
        }
      }
      try {
        writeOutbound(config.mailbox, env);
      } catch (err) {
        return { content: [{ type: "text" as const, text: `reach_send failed to write outbox: ${String((err as Error)?.message ?? err)}` }] };
      }
      const result = {
        queued: true,
        id: env.id,
        to: env.to,
        kind: env.kind,
        note: "Queued to the relay. Delivery depends on the relay's route policy; a forbidden route is dropped and audited host-side.",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  };
}
