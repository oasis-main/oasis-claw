import { listInbox, markAllRead, type MailboxConfig } from "../mailbox.js";

export interface ReachInboxConfig {
  mailbox: MailboxConfig;
}

/**
 * reach_inbox — list peer messages (METADATA ONLY: id, from, subject, kind, ts,
 * unread). Bodies are never returned here; use reach_read <id> to read one body
 * (which arrives nonce-delimited and tagged untrusted). Keeping the listing
 * body-free is deliberate: it is what lets the memory supplement inject just an
 * unread count instead of burning cache-write on message bodies every turn.
 */
export function createReachInboxTool(config: ReachInboxConfig) {
  return {
    name: "reach_inbox",
    description:
      "List your peer-message inbox (metadata only: id, from, subject, kind, timestamp, unread). Read a body with reach_read <id>. Optionally mark everything read without reading it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        unread_only: { type: "boolean", description: "If true, list only unread messages." },
        mark_all_read: { type: "boolean", description: "If true, mark every listed message read WITHOUT rendering bodies (use to dismiss noise)." },
      },
    },
    async execute(_toolCallId: string, args: { unread_only?: boolean; mark_all_read?: boolean } = {}) {
      if (args.mark_all_read) {
        const n = markAllRead(config.mailbox);
        return { content: [{ type: "text" as const, text: JSON.stringify({ marked_read: n }, null, 2) }] };
      }
      const items = listInbox(config.mailbox)
        .filter((i) => (args.unread_only ? i.unread : true))
        .map(({ id, from, kind, subject, ts, unread, work }) => ({ id, from, kind, subject, ts, unread, work }));
      const result = { count: items.length, unread: items.filter((i) => i.unread).length, messages: items };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  };
}
