import fs from "node:fs";
import path from "node:path";
import { appendTrailEvent } from "../trail.js";

export type DreamToolConfig = {
  swarmDir: string;
  historyDir: string;
};

/**
 * dream tool — consolidate recent activity into long-term memory.
 *
 * What this stub does:
 *   - Reads up to N most recent JSONL session files from historyDir
 *   - Appends a DREAM section to .swarm/memory.md with file count, byte
 *     count, and the user-supplied topic (no LLM-driven distillation)
 *   - Writes a DREAM event to trail.log
 *
 * What full integration would add (TODO, ORG-050):
 *   - Sub-agent invocation that actually summarizes the JSONL transcripts
 *     (e.g., dispatch to a dedicated low-context model)
 *   - Importance scoring (which entries are worth keeping vs. discarding)
 *   - Deduplication against existing memory.md entries
 *
 * The point of the stub is to verify the FS-side of the pipeline (history
 * is found, .swarm/ is writable, the trail and memory.md grow correctly)
 * without committing to a particular distillation strategy.
 */
export function createDreamTool(config: DreamToolConfig) {
  return {
    name: "dream",
    description:
      "Consolidate recent session activity into .swarm/memory.md. Pass an optional topic to scope the consolidation. Use during low-activity intervals or before compact().",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        topic: {
          type: "string",
          description: "Optional scope — if absent, consolidates all recent activity.",
        },
        maxFiles: {
          type: "number",
          minimum: 1,
          maximum: 100,
          description: "Cap on how many recent JSONL files to consider (default 10).",
        },
      },
    },
    async invoke(args: { topic?: string; maxFiles?: number }) {
      const maxFiles = args.maxFiles ?? 10;
      const summary = collectHistorySummary(config.historyDir, maxFiles);

      const memoryEntry = renderMemoryEntry(args.topic, summary);
      const memoryPath = path.join(config.swarmDir, "memory.md");
      let memoryWritten = false;
      let memoryError: string | undefined;
      try {
        fs.mkdirSync(config.swarmDir, { recursive: true });
        fs.appendFileSync(memoryPath, memoryEntry, "utf8");
        memoryWritten = true;
      } catch (err) {
        memoryError = err instanceof Error ? err.message : String(err);
      }

      const trail = appendTrailEvent(config.swarmDir, {
        kind: "DREAM",
        topic: args.topic ?? null,
        filesScanned: summary.fileCount,
        bytesScanned: summary.byteCount,
        memoryWritten,
      });

      return {
        status: "consolidated",
        topic: args.topic ?? null,
        filesScanned: summary.fileCount,
        bytesScanned: summary.byteCount,
        memoryPath,
        memoryWritten,
        memoryError,
        trailWritten: trail.written,
        hostIntegrationNote:
          "This stub records that a dream happened and snapshots history sizes. It does NOT yet run a sub-agent to distill transcripts — wire that per oasis-x ORG-050.",
      };
    },
  };
}

function collectHistorySummary(
  historyDir: string,
  maxFiles: number,
): { fileCount: number; byteCount: number; mostRecentPath?: string } {
  if (!fs.existsSync(historyDir)) {
    return { fileCount: 0, byteCount: 0 };
  }
  const entries = fs
    .readdirSync(historyDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => {
      const fullPath = path.join(historyDir, e.name);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles);

  return {
    fileCount: entries.length,
    byteCount: entries.reduce((sum, e) => sum + e.size, 0),
    mostRecentPath: entries[0]?.fullPath,
  };
}

function renderMemoryEntry(
  topic: string | undefined,
  summary: { fileCount: number; byteCount: number; mostRecentPath?: string },
): string {
  const ts = new Date().toISOString();
  const topicLine = topic ? `**Topic**: ${topic}` : "**Topic**: (no topic — global consolidation)";
  return [
    `\n## ${ts} — DREAM (agent-primitives stub)`,
    "",
    topicLine,
    `- Files scanned: ${summary.fileCount}`,
    `- Bytes scanned: ${summary.byteCount}`,
    summary.mostRecentPath ? `- Most recent: ${summary.mostRecentPath}` : "",
    "",
    "_NB: this is a stub entry from agent-primitives — full LLM-driven distillation is pending ORG-050._",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}
