import fs from "node:fs";
import path from "node:path";

/**
 * Append a single JSONL event to <swarmDir>/trail.log.
 * Creates the directory if needed. Never throws on FS errors —
 * lifecycle primitives should not fail because the trail is unwritable.
 */
export function appendTrailEvent(
  swarmDir: string,
  event: { kind: string; ts?: string; [key: string]: unknown },
): { written: boolean; path: string; error?: string } {
  const trailPath = path.join(swarmDir, "trail.log");
  const enriched = { ts: new Date().toISOString(), ...event };
  try {
    fs.mkdirSync(swarmDir, { recursive: true });
    fs.appendFileSync(trailPath, JSON.stringify(enriched) + "\n", "utf8");
    return { written: true, path: trailPath };
  } catch (err) {
    return {
      written: false,
      path: trailPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
