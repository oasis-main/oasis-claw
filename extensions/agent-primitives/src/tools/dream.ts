import fs from "node:fs";
import path from "node:path";
import {
  distillEvents,
  parseSessionFile,
  renderDistillationAsMarkdown,
} from "../jsonl-parser.js";
import { appendTrailEvent } from "../trail.js";

export type DreamToolConfig = {
  swarmDir: string;
  historyDir: string;
};

/**
 * dream tool — consolidate recent session activity into .swarm/memory.md.
 *
 * FS-side (done):
 *   - Scans historyDir for the N most-recently-modified .jsonl session files
 *   - Parses each file: extracts tool calls, assistant text excerpts, token usage
 *   - Renders a markdown distillation and appends it to .swarm/memory.md
 *   - Writes a DREAM event to .swarm/trail.log
 *
 * Host integration (remaining, ORG-050):
 *   - LLM-driven summarization: dispatch the JSONL to a low-context model for
 *     higher-quality prose synthesis (currently we extract raw assistant text)
 *   - Importance scoring: rank excerpts before writing
 *   - Deduplication: skip sessions already present in memory.md
 */
export function createDreamTool(config: DreamToolConfig) {
  return {
    name: "dream",
    description: [
      "Consolidate recent session activity into .swarm/memory.md.",
      "Parses session JSONL transcripts, extracts tool calls and assistant outputs,",
      "and appends a structured distillation to memory.md.",
      "Use during low-activity intervals or before compact() to capture what happened.",
    ].join(" "),
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

      // Scan historyDir for recent JSONL files
      const recentFiles = collectRecentFiles(config.historyDir, maxFiles);

      // Parse + distill each session
      const distillations = recentFiles.map((filePath) => {
        const events = parseSessionFile(filePath);
        return distillEvents(events);
      });

      // Build memory.md entry
      const ts = new Date().toISOString();
      const topicLine = args.topic
        ? `**Topic**: ${args.topic}`
        : "**Topic**: (all recent sessions)";

      const sections: string[] = [
        "",
        `## ${ts} — DREAM`,
        "",
        topicLine,
        `- Sessions scanned: ${distillations.length}`,
        `- Files found: ${recentFiles.length}`,
        "",
      ];

      if (distillations.length === 0) {
        sections.push("_No session files found in historyDir._");
      } else {
        distillations.forEach((d, i) => {
          const label = d.sessionId ?? `session-${i + 1}`;
          sections.push(`### ${label}`);
          sections.push("");
          sections.push(renderDistillationAsMarkdown(d));
          sections.push("");
        });
      }

      sections.push("---");
      sections.push("");

      const memoryEntry = sections.join("\n");
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

      const totalTokens = distillations.reduce((sum, d) => sum + d.tokensUsed, 0);
      const totalToolCalls = distillations.reduce((sum, d) => sum + d.toolCalls.length, 0);

      const trail = appendTrailEvent(config.swarmDir, {
        kind: "DREAM",
        topic: args.topic ?? null,
        filesScanned: recentFiles.length,
        sessionsDistilled: distillations.length,
        totalTokens,
        totalToolCalls,
        memoryWritten,
      });

      return {
        status: "consolidated",
        topic: args.topic ?? null,
        sessionsDistilled: distillations.length,
        filesScanned: recentFiles.length,
        totalTokens,
        totalToolCalls,
        memoryPath,
        memoryWritten,
        memoryError,
        trailWritten: trail.written,
        hostIntegrationNote:
          "dream uses deterministic JSONL extraction. LLM-driven distillation (richer prose summaries) is pending ORG-050.",
      };
    },
  };
}

function collectRecentFiles(historyDir: string, maxFiles: number): string[] {
  if (!fs.existsSync(historyDir)) return [];
  try {
    return fs
      .readdirSync(historyDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => {
        // `e.path` (Node 20+) contains the directory; fall back to historyDir
        const dir = (e as { path?: string }).path ?? historyDir;
        const fullPath = path.join(dir, e.name);
        const stat = fs.statSync(fullPath);
        return { fullPath, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxFiles)
      .map((e) => e.fullPath);
  } catch {
    return [];
  }
}
