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
 * Split `maxBytes` across the existing files so no file can starve another.
 *
 * Water-filling: each unsatisfied file is offered an equal share of what is
 * left; files smaller than their share take only what they need and return the
 * surplus to the pool; the loop repeats until only over-share files remain,
 * which then split the remainder evenly.
 *
 * WHY this replaced sequential consumption (CLAW-082, 2026-08-10): the old
 * reader walked `includeFiles` in order and gave each file whatever was left.
 * On every real board that starved the LAST file to zero — measured on
 * oasis-x/.swarm (state.md 57,111 B, queue.md 195,069 B against the 32,768 B
 * default), where queue.md rendered as an empty section under a heading. An
 * agent reads that as "the queue is empty", which is the opposite of true.
 */
function allocateBudgets(sizes: number[], maxBytes: number): number[] {
  const alloc = new Array<number>(sizes.length).fill(0);
  let pool = Math.max(0, maxBytes);
  let pending = sizes.map((_, index) => index);

  while (pending.length > 0 && pool > 0) {
    const share = Math.floor(pool / pending.length);
    if (share <= 0) {
      break;
    }
    const satisfied = pending.filter((index) => sizes[index] <= share);
    if (satisfied.length === 0) {
      // Every remaining file wants more than its share — split evenly and stop.
      for (const index of pending) {
        alloc[index] = share;
      }
      break;
    }
    for (const index of satisfied) {
      alloc[index] = sizes[index];
      pool -= sizes[index];
    }
    pending = pending.filter((index) => !satisfied.includes(index));
  }

  return alloc;
}

/**
 * Read the configured .swarm/ files into a deterministic snapshot.
 *
 * - Missing files are reported with `exists: false` rather than throwing.
 * - The total byte budget is honored across all files, split fairly rather
 *   than consumed in order (see `allocateBudgets`).
 * - A file that does not fit its allotment reports `truncated: true` and the
 *   TRUE on-disk size in `bytes`, so the renderer can point the agent at
 *   `swarm_read` for the rest.
 */
export function readSwarmSnapshot(config: SwarmReaderConfig): SwarmFileSnapshot[] {
  const entries = config.includeFiles.map((filename) => {
    const fullPath = path.join(config.swarmDir, filename);
    if (!fs.existsSync(fullPath)) {
      return { filename, exists: false, buf: "" };
    }
    try {
      return { filename, exists: true, buf: fs.readFileSync(fullPath, "utf8") };
    } catch {
      // Unreadable (permissions, races) is reported as absent, never thrown —
      // the memory supplement must not be able to fail a session start.
      return { filename, exists: false, buf: "" };
    }
  });

  // Missing files consume no budget, so they are excluded from the split.
  const presentIndexes = entries.flatMap((entry, index) => (entry.exists ? [index] : []));
  const budgets = allocateBudgets(
    presentIndexes.map((index) => entries[index].buf.length),
    config.maxBytes,
  );

  return entries.map((entry, index) => {
    if (!entry.exists) {
      return { filename: entry.filename, exists: false, bytes: 0, truncated: false, content: "" };
    }
    const budget = budgets[presentIndexes.indexOf(index)] ?? 0;
    const size = entry.buf.length;
    if (size <= budget) {
      return {
        filename: entry.filename,
        exists: true,
        bytes: size,
        truncated: false,
        content: entry.buf,
      };
    }
    const head = budget > 0 ? `${entry.buf.slice(0, budget)}\n\n... [truncated by dot-swarm maxBytes cap] ...\n` : "";
    return { filename: entry.filename, exists: true, bytes: size, truncated: true, content: head };
  });
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
    if (file.content) {
      lines.push(file.content);
    }
    // A truncated file MUST name its true size and the way to get the rest.
    // Without this an over-budget file renders as a bare heading with nothing
    // under it, which reads as "this file is empty" (CLAW-082).
    if (file.truncated) {
      lines.push(
        `_[${file.filename} is ${file.bytes} bytes on disk; ${file.content ? "only the head is shown" : "it did not fit the prompt budget"}. Call swarm_read with filename="${file.filename}" for the full file.]_`,
      );
    }
    lines.push("");
  }

  if (!anyContent) {
    lines.push("_(no .swarm/ files present at this path)_");
    lines.push("");
  }

  return lines;
}
