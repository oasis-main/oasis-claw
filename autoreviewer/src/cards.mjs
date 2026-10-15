// Grant card text and buttons (CLAW-119). Plain text only (no parse_mode).
// The autoreviewer bot writes the fixed fields itself; the bot-written topic
// and intent are shown under a label that names their author.

const TELEGRAM_TEXT_MAX = 4096;
// Telegram limits callback_data to 64 bytes. "g:GRANT-0001:24" is 15.
export const CALLBACK = {
  grant: (id, hours) => `g:${id}:${hours}`,
  deny: (id) => `g:${id}:deny`,
  revoke: (id) => `r:${id}`,
  ghApprove: (id) => `h:${id}:ok`,
  ghDeny: (id) => `h:${id}:no`,
  ghRevoke: (id) => `hr:${id}`,
  dirApprove: (id, hours) => `d:${id}:${hours}`,
  dirDeny: (id) => `d:${id}:no`,
  dirRenew: (id) => `dr:${id}`,
  watch: (bot) => `w:${bot}`,
};

export function parseCallback(data) {
  const m = /^g:(GRANT-\d{4,}):(\d{1,2}|deny)$/.exec(String(data ?? ""));
  if (m) return { kind: "decide", id: m[1], ttlHours: m[2] === "deny" ? null : Number(m[2]) };
  const d = /^d:(DIR-\d{4,}):(\d{1,3}|no)$/.exec(String(data ?? ""));
  if (d) return { kind: "dir-decide", id: d[1], hours: d[2] === "no" ? null : Number(d[2]) };
  const dr = /^dr:(DIR-\d{4,})$/.exec(String(data ?? ""));
  if (dr) return { kind: "dir-renew", id: dr[1] };
  const r = /^r:((?:GRANT|DIR)-\d{4,})$/.exec(String(data ?? ""));
  if (r) return { kind: "revoke", id: r[1] };
  const h = /^h:(GH-\d{4,}):(ok|no)$/.exec(String(data ?? ""));
  if (h) return { kind: "gh-decide", id: h[1], approve: h[2] === "ok" };
  const hr = /^hr:(GH-\d{4,})$/.exec(String(data ?? ""));
  if (hr) return { kind: "gh-revoke", id: hr[1] };
  const w = /^w:([a-z][a-z0-9_-]{0,31})$/.exec(String(data ?? ""));
  if (w) return { kind: "watch", bot: w[1] };
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

// ── GitHub access requests (CLAW-121) ──

export function ghCardText(r) {
  return [
    `GITHUB ACCESS REQUEST ${r.id}`,
    `Requested by: ${r.requester}`,
    `For bot: ${r.bot}`,
    `Account: ${r.account}`,
    `Repos: ${r.repos.join(", ")}`,
    `Access: ${r.access === "write" ? "WRITE (contents, pull requests, issues)" : "read"}`,
    "Durable until revoked (/ghrevoke). The minter applies it within 30 minutes.",
    "",
    `Reason (written by ${r.requester}):`,
    r.reason,
  ].join("\n");
}

export function ghOutcome(r, minter) {
  switch (r.status) {
    case "approved":
      return `APPROVED by Mike. Minter: ${minter ?? "not applied yet"}.`;
    case "denied":
      return "DENIED by Mike.";
    case "revoked":
      return "REVOKED. The minter drops it on its next run; a live token can last up to 1 h more.";
    default:
      return "";
  }
}

export function ghDecidedText(r, minter) {
  return `${ghCardText(r)}\n\n>> ${ghOutcome(r, minter)}`;
}

export function ghKeyboard(r) {
  return {
    inline_keyboard: [[
      { text: "Approve", callback_data: CALLBACK.ghApprove(r.id) },
      { text: "Deny", callback_data: CALLBACK.ghDeny(r.id) },
    ]],
  };
}

// ── Directives (CLAW-124) ──

export function directiveCardText(d) {
  return [
    `STANDING DIRECTIVE ${d.id} for ${d.grantees[0]}${d.lane ? ` (${d.lane})` : ""}`,
    `Proposed by: ${d.requester === "mike" ? "you" : d.requester}`,
    `Length asked: ${Math.round(d.requested_ttl_hours / 24 * 10) / 10} days (rolling)`,
    "",
    `Goal: ${d.topic}`,
    `May: ${d.intent}`,
    `Must not: ${d.must_not}`,
    d.path_prefixes ? `Paths: ${d.path_prefixes.join(", ")}` : null,
    "",
    "Covers this bot's own work in any session. Never covers deletes, data out, infra, money or trades.",
  ].filter((x) => x !== null).join("\n");
}

export function directiveDecidedText(d) {
  const tail =
    d.status === "active" ? `ACTIVE until ${utc(d.expires)}.` :
    d.status === "denied" ? "DENIED." :
    d.status === "revoked" ? "REVOKED." :
    d.status === "expired" ? `ENDED ${utc(d.expires)}.` :
    d.status === "lapsed" ? "LAPSED: no answer." : "";
  return `${directiveCardText(d)}\n\n>> ${tail}`;
}

export function directiveKeyboard(d) {
  return {
    inline_keyboard: [
      [
        { text: "Approve 7 d", callback_data: CALLBACK.dirApprove(d.id, 168) },
        { text: "Approve 3 d", callback_data: CALLBACK.dirApprove(d.id, 72) },
      ],
      [{ text: "Deny", callback_data: CALLBACK.dirDeny(d.id) }],
    ],
  };
}

/** Parse "/directive <bot> <goal> | may: … | must not: … | lane: …". */
export function parseDirectiveCommand(args) {
  const [head, ...parts] = String(args ?? "").split("|").map((x) => x.trim());
  const m = /^(\S+)\s+([\s\S]+)$/.exec(head ?? "");
  if (!m) return null;
  const out = { bot: m[1].toLowerCase(), goal: m[2].trim() };
  for (const p of parts) {
    const kv = /^(may|must not|must_not|lane|days)\s*:\s*([\s\S]*)$/i.exec(p);
    if (!kv) continue;
    const key = kv[1].toLowerCase().replace(" ", "_");
    if (key === "days") out.ttl_hours = Math.round(Number(kv[2]) * 24);
    else out[key] = kv[2].trim();
  }
  return out;
}
