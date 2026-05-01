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
 * This means the `compact` tool (FS-write) + this provider (context-lifecycle) are
 * two halves of the same feature. The agent writes the snapshot, the provider serves
 * it back to the runtime at compaction time.
 *
 * Registered in: index.ts via api.registerCompactionProvider()
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Provider interface (mirrors openclaw's CompactionProvider from compaction-provider.ts)
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

/**
 * Parse .swarm/state.md and return the body of the most recent HANDOFF section.
 * Returns null if no HANDOFF section is found.
 */
export function readLatestHandoff(stateMdPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(stateMdPath, "utf8");
  } catch {
    return null;
  }

  // Find all HANDOFF section headers
  // Pattern: "## Handoff Note — <tag>\n\n*Compacted at ...*\n\n<body>"
  const sections = raw.split(/\n---\n/);
  const handoffSections = sections.filter((s) => s.includes("## Handoff Note —"));

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
};

export function createSwarmCompactionProvider(
  config: SwarmCompactionProviderConfig,
): CompactionProvider {
  const stateMdPath = path.join(config.swarmDir, "state.md");

  return {
    id: "swarm-compact",
    label: "Swarm State Compaction (oasis-claw/agent-primitives)",

    async summarize(params: CompactionParams): Promise<string> {
      // 1. Try to read the agent's own handoff note
      const handoff = readLatestHandoff(stateMdPath);
      if (handoff) {
        return [
          "## Compaction Summary (from agent handoff note)",
          "",
          handoff,
          "",
          `---`,
          `*Compaction source: .swarm/state.md — written by agent-primitives \`compact\` tool.*`,
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
