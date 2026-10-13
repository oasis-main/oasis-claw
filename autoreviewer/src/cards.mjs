// Grant card text and buttons (CLAW-119). Plain text only (no parse_mode).
// The autoreviewer bot writes the fixed fields itself; the bot-written topic
// and intent are shown under a label that names their author.

const TELEGRAM_TEXT_MAX = 4096;
// Telegram limits callback_data to 64 bytes. "g:GRANT-0001:24" is 15.
export const CALLBACK = {
  grant: (id, hours) => `g:${id}:${hours}`,
  deny: (id) => `g:${id}:deny`,
  revoke: (id) => `r:${id}`,
};

export function parseCallback(data) {
  const m = /^g:(GRANT-\d{4,}):(\d{1,2}|deny)$/.exec(String(data ?? ""));
  if (m) return { kind: "decide", id: m[1], ttlHours: m[2] === "deny" ? null : Number(m[2]) };
  const r = /^r:(GRANT-\d{4,})$/.exec(String(data ?? ""));
  if (r) return { kind: "revoke", id: r[1] };
  return null;
}

export function utc(iso) {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "-";
}

function limitsLine(g) {
  const parts = [];
  if (g.families) parts.push(`tool families ${g.families.join(", ")}`);
  if (g.path_prefixes) parts.push(`paths ${g.path_prefixes.join(", ")}`);
  if (g.max_actions) parts.push(`at most ${g.max_actions} actions`);
  return parts.length ? parts.join("; ") : "none beyond topic and intent";
}

export function grantCardText(g) {
  const lines = [
    `FLEET GRANT REQUEST ${g.id}`,
    `From: ${g.requester}`,
    `To: ${g.grantees.join(", ")}`,
    `Thread: ${g.thread_id}`,
    `Requested TTL: ${g.requested_ttl_hours} h`,
    `Limits: ${limitsLine(g)}`,
    `Unanswered, it lapses at ${utc(g.proposal_expires)}.`,
    "",
    `Topic (written by ${g.requester}):`,
    g.topic,
    "",
    `Intent (written by ${g.requester}):`,
    g.intent,
  ];
  return lines.join("\n");
}

export function outcomeLine(g) {
  switch (g.status) {
    case "active":
      return `GRANTED by Mike until ${utc(g.expires)}.`;
    case "denied":
      return "DENIED by Mike.";
    case "lapsed":
      return "LAPSED: no answer before the proposal expired.";
    case "revoked":
      return `REVOKED${g.revoke_reason ? `: ${g.revoke_reason}` : "."}`;
    case "expired":
      return `EXPIRED at ${utc(g.expires)}.`;
    default:
      return "";
  }
}

/** The card after a decision: same text, an outcome line, no buttons. */
export function decidedCardText(g) {
  const text = `${grantCardText(g)}\n\n>> ${outcomeLine(g)}`;
  return text.length > TELEGRAM_TEXT_MAX ? text.slice(0, TELEGRAM_TEXT_MAX - 1) + "…" : text;
}

export function grantKeyboard(g, ttlButtons) {
  const allowed = ttlButtons.filter((h) => h > 0 && h <= 24);
  return {
    inline_keyboard: [
      allowed.map((h) => ({ text: `Grant ${h} h`, callback_data: CALLBACK.grant(g.id, h) })),
      [{ text: "Deny", callback_data: CALLBACK.deny(g.id) }],
    ],
  };
}

export function grantSummaryLine(g) {
  const when = g.status === "active" ? `until ${utc(g.expires)}` : `lapses ${utc(g.proposal_expires)}`;
  return `${g.id} [${g.status}] ${g.requester} -> ${g.grantees.join(", ")} (${g.thread_id}), ${when}\n  ${g.topic}`;
}
