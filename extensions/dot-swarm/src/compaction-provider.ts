/**
 * SwarmCompactionProvider — openclaw compaction provider backed by .swarm/state.md.
 *
 * When openclaw's built-in compaction fires (context approaching limit), instead
 * of running its default summarizeInStages() pipeline, this provider:
 *   1. Reads the most recent HANDOFF section from .swarm/state.md (written by the
 *      `compact` tool when the agent called it proactively)
 *   2. Returns that handoff as the compaction summary, so the fresh context
 *      starts from the agent's own carefully-written state snapshot
 *   3. Falls back to a digest of the conversation messages if no HANDOFF exists
 *
 * The `compact` tool (FS-write) + this provider (context-lifecycle) are two
 * halves of the same feature: the agent writes the snapshot, the provider serves
 * it back to the runtime at compaction time. Both live in dot-swarm because both
 * operate on the .swarm/ stigmergy surface.
 *
 * Only active when agents.defaults.compaction.provider = "swarm-compact" is set
 * in config (registration alone does not activate it). Registered in index.ts
 * via api.registerCompactionProvider().
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Provider interface (mirrors openclaw's CompactionProvider)
// ---------------------------------------------------------------------------

export type CompactionParams = {
  messages: unknown[];
  signal?: AbortSignal;
  compressionRatio?: number;
  customInstructions?: string;
  previousSummary?: string;
};

export interface CompactionProvider {
  id: string;
  label: string;
  summarize(params: CompactionParams): Promise<string>;
}

// ---------------------------------------------------------------------------
// State.md parser — extract latest HANDOFF section
// ---------------------------------------------------------------------------

// Matches the real handoff headers found in a shared state.md — both the
// compact tool's own format ("## Handoff Note — <tag>", written below in
// tools/compact.ts) and plain, hand-written ones with no em dash and no tag
// ("## Handoff Note", "## Handoff Note (archived)"). The old em-dash-only
// match never fired against hand-written headers, so every read silently
// fell through to digestMessages() with no error. Found during the
// 2026-08-13 House-bot incident review — not the cause of that incident,
// a separate, pre-existing defect.
const HANDOFF_HEADER_RE = /^##\s+Handoff Note\b(.*)$/m;

/**
 * Parse .swarm/state.md and return the body of the most recent HANDOFF section.
 * Returns null if no HANDOFF section is found.
 *
 * `opts.botKey`, when given, restricts matches to sections tagged for that
 * bot (a tag written as "<botKey>: <rest>" by the compact tool). This
 * directory is shared, read-write, between more than one bot for at least
 * one deployment (House and Yes Man both mount the same host state.md —
 * see bots/docker-compose.house-reach.yml and
 * bots/docker-compose.yesman-reach.yml). Without botKey, this function
 * ALWAYS returns null — it deliberately does not serve back a handoff note
 * of unknown origin on a directory that may be shared. A caller must opt in
 * to scoped reading by configuring botKey; until then, the caller's own
 * fallback (its own conversation digest) applies, matching pre-fix
 * behavior for every bot exactly, since none configure botKey yet.
 */
export function readLatestHandoff(stateMdPath: string, opts: { botKey?: string } = {}): string | null {
  if (!opts.botKey) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(stateMdPath, "utf8");
  } catch {
    return null;
  }

  const sections = raw.split(/\n---\n/);
  const handoffSections = sections.filter((s) => {
    const m = s.match(HANDOFF_HEADER_RE);
    if (!m) return false;
    // Strip the "— " (em dash) separator the compact tool writes between
    // "Handoff Note" and the tag, if present, before checking the tag itself.
    const tag = m[1].trim().replace(/^—\s*/, "");
    return tag.startsWith(`${opts.botKey}:`);
  });

  if (handoffSections.length === 0) return null;

  // Use the LAST handoff (most recent append)
  const latest = handoffSections[handoffSections.length - 1];

  // Strip the header lines (## heading + *Compacted at...* line)
  const lines = latest.split("\n");
  const bodyStart = lines.findIndex(
    (line, i) => i > 0 && !line.startsWith("#") && !line.startsWith("*Compacted at") && line.trim() !== "",
  );
  if (bodyStart === -1) return latest.trim();

  return lines.slice(bodyStart).join("\n").trim();
}

// ---------------------------------------------------------------------------
// Fallback: digest messages when no HANDOFF exists
// ---------------------------------------------------------------------------

/**
 * Extract a plain-text digest from the conversation messages array.
 * Handles the Anthropic message format: { role: "user"|"assistant", content: string|array }
 */
export function digestMessages(messages: unknown[], maxChars = 4000): string {
  const lines: string[] = ["## Session Digest (auto-generated — no handoff note found)", ""];

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const { role, content } = msg as { role?: string; content?: unknown };
    if (!role || role === "system") continue;

    const text = extractTextFromMessage(content);
    if (!text.trim()) continue;

    const prefix = role === "assistant" ? "**Agent**: " : "**User**: ";
    lines.push(`${prefix}${text.slice(0, 300).replace(/\n/g, " ").trim()}`);
  }

  const result = lines.join("\n");
  return result.length > maxChars ? result.slice(0, maxChars) + "\n…(truncated)" : result;
}

function extractTextFromMessage(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text",
      )
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export type SwarmCompactionProviderConfig = {
  swarmDir: string;
  /**
   * Restricts handoff reads to notes tagged for this bot. Required on any
   * swarmDir shared read-write between more than one bot (see the
   * readLatestHandoff doc comment above) — leave unset for a private
   * swarmDir, or if bot-scoped tagging hasn't been turned on yet.
   */
  botKey?: string;
};

export function createSwarmCompactionProvider(
  config: SwarmCompactionProviderConfig,
): CompactionProvider {
  const stateMdPath = path.join(config.swarmDir, "state.md");

  return {
    id: "swarm-compact",
    label: "Swarm State Compaction (oasis-claw/dot-swarm)",

    async summarize(params: CompactionParams): Promise<string> {
      // 1. Try to read the agent's own handoff note
      const handoff = readLatestHandoff(stateMdPath, { botKey: config.botKey });
      if (handoff) {
        return [
          "## Compaction Summary (from agent handoff note)",
          "",
          handoff,
          "",
          `---`,
          `*Compaction source: .swarm/state.md — written by the dot-swarm \`compact\` tool.*`,
        ].join("\n");
      }

      // 2. Fall back to message digest (no handoff written yet)
      const digest = digestMessages(params.messages);
      return [
        digest,
        "",
        "---",
        "*Compaction source: auto-digest of conversation messages (no agent handoff note found in .swarm/state.md).*",
        "*Have the agent call \`compact\` before context fills to provide a richer handoff.*",
      ].join("\n");
    },
  };
}
