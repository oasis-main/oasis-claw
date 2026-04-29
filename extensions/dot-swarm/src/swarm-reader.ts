import fs from "node:fs";
import path from "node:path";

export type SwarmReaderConfig = {
  swarmDir: string;
  includeFiles: string[];
  maxBytes: number;
};

export type SwarmFileSnapshot = {
  filename: string;
  exists: boolean;
  bytes: number;
  truncated: boolean;
  content: string;
};

/**
 * Read the configured .swarm/ files into a deterministic snapshot.
 *
 * - Missing files are reported with `exists: false` rather than throwing.
 * - The total byte budget is honored across all files (in `includeFiles`
 *   order). If exhausted, remaining files report `truncated: true`.
 * - Per-file byte budget is the remaining budget at the time of read.
 */
export function readSwarmSnapshot(config: SwarmReaderConfig): SwarmFileSnapshot[] {
  const out: SwarmFileSnapshot[] = [];
  let remaining = config.maxBytes;

  for (const filename of config.includeFiles) {
    const fullPath = path.join(config.swarmDir, filename);
    if (!fs.existsSync(fullPath)) {
      out.push({ filename, exists: false, bytes: 0, truncated: false, content: "" });
      continue;
    }

    const stat = fs.statSync(fullPath);
    if (remaining <= 0) {
      out.push({
        filename,
        exists: true,
        bytes: stat.size,
        truncated: true,
        content: "",
      });
      continue;
    }

    const buf = fs.readFileSync(fullPath, "utf8");
    if (buf.length <= remaining) {
      remaining -= buf.length;
      out.push({
        filename,
        exists: true,
        bytes: buf.length,
        truncated: false,
        content: buf,
      });
    } else {
      const truncatedContent = buf.slice(0, remaining) + "\n\n... [truncated by dot-swarm maxBytes cap] ...\n";
      out.push({
        filename,
        exists: true,
        bytes: buf.length,
        truncated: true,
        content: truncatedContent,
      });
      remaining = 0;
    }
  }

  return out;
}

/**
 * Render a snapshot as the array of prompt-section lines that
 * registerMemoryPromptSupplement expects.
 */
export function renderSnapshotAsPromptLines(
  swarmDir: string,
  snapshot: SwarmFileSnapshot[],
): string[] {
  const lines: string[] = [];
  lines.push(`### Stigmergic coordination state (.swarm/ at ${swarmDir})`);
  lines.push("");

  let anyContent = false;
  for (const file of snapshot) {
    if (!file.exists) {
      continue;
    }
    anyContent = true;
    lines.push(`#### ${file.filename}${file.truncated ? " (truncated)" : ""}`);
    lines.push("");
    lines.push(file.content);
    lines.push("");
  }

  if (!anyContent) {
    lines.push("_(no .swarm/ files present at this path)_");
    lines.push("");
  }

  return lines;
}
