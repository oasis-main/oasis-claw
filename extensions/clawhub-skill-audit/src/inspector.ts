/**
 * Inspector — bounded, read-only filesystem accessor used by the auditor model
 * during a deep-reference-walk audit.
 *
 * The model has an `inspect_file(path, reason)` tool. Each call lands here.
 * We resolve the path against a small allowlist of roots (typically the
 * openclaw repo's `extensions/` and `plugins/` directories), enforce per-file
 * and total byte budgets, and refuse anything that escapes via symlinks or
 * `..`. Every inspection — including failed ones — is recorded in
 * `inspected` for the audit trail.
 *
 * Threat model for the inspector itself:
 *   - The auditor model is acting on text we don't fully trust (the skill
 *     itself + any injected instructions inside the inspected files). It
 *     should not be possible to coax the inspector into reading arbitrary
 *     paths on the host. Hence: relative paths only, realpath-based
 *     containment, byte caps. The inspector NEVER executes anything.
 *   - File contents returned to the model are themselves untrusted. That's
 *     handled in the audit-prompt — we tell the model so. Opus 4.7 is the
 *     model of choice here precisely because it's the most prompt-injection-
 *     resistant; the inspector's job is to bound the blast radius even if
 *     the model does get tricked.
 */

import fs from "node:fs";
import path from "node:path";

export type InspectionContext = {
  /** Absolute paths the auditor is allowed to read from. Order matters —
   *  paths are resolved against the first root that matches. */
  inspectRoots: string[];
  /** Hard cap on number of files inspected per audit (success + failure). */
  maxFiles: number;
  /** Hard cap on total bytes returned to the model across all inspections. */
  maxTotalBytes: number;
  /** Per-file read cap; larger files are truncated. */
  maxBytesPerFile: number;
  /** Extension allowlist; reject reads of anything else as a binary-shipping
   *  red flag. Mirrors skill-scanner's AUDITABLE_EXT. */
  auditableExt: ReadonlySet<string>;
};

export const DEFAULT_AUDITABLE_EXT: ReadonlySet<string> = new Set([
  ".md", ".txt", ".sh", ".bash", ".zsh", ".fish",
  ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx",
  ".json", ".yaml", ".yml", ".toml",
  ".rb", ".pl", ".ps1",
]);

export type InspectionRecord = {
  requestedPath: string;
  resolvedRoot: string | null;
  ok: boolean;
  bytesReturned: number;
  totalSize: number;
  truncated: boolean;
  reason: string;                  // why the auditor said it wanted to read this
  errorDetail?: string;
  ts: string;                      // ISO timestamp
};

export type ReadResult =
  | { ok: true; relPath: string; size: number; truncated: boolean; contents: string }
  | { ok: false; error: string };

export class Inspector {
  private filesRead = 0;
  private bytesRead = 0;
  public readonly inspected: InspectionRecord[] = [];
  private readonly ctx: InspectionContext;

  constructor(ctx: InspectionContext) {
    this.ctx = ctx;
  }

  /** True if we've hit either the file-count cap or the byte cap. The model
   *  is told about its remaining budget on every tool_result. */
  budgetExhausted(): boolean {
    return this.filesRead >= this.ctx.maxFiles || this.bytesRead >= this.ctx.maxTotalBytes;
  }

  remainingBudget(): { files: number; bytes: number } {
    return {
      files: Math.max(0, this.ctx.maxFiles - this.filesRead),
      bytes: Math.max(0, this.ctx.maxTotalBytes - this.bytesRead),
    };
  }

  /** Short labels for the configured inspect roots — basenames only, never
   *  full paths. Surfaced to the auditor model as a hint about what scope
   *  the inspect_file tool can reach. Avoids leaking host filesystem layout. */
  rootLabels(): string[] {
    return this.ctx.inspectRoots.map((p) => {
      const segs = p.split(/[\\/]/).filter(Boolean);
      return segs.slice(-2).join("/") || p;
    });
  }

  perFileBudget(): number {
    return this.ctx.maxBytesPerFile;
  }

  /**
   * Resolve a model-supplied path to an absolute file path under one of the
   * allowed roots. Returns null if it escapes, doesn't exist, or has a
   * disallowed extension.
   *
   * Safety properties:
   *   - Rejects absolute paths and paths containing ".." literal.
   *   - Uses realpathSync to follow symlinks, then verifies the result is
   *     still under the chosen root. Defends against symlink-out attacks.
   *   - Extension allowlist is enforced BEFORE the realpath check so we don't
   *     accidentally fingerprint binaries.
   */
  private resolveSafe(requestedPath: string): { abs: string; root: string } | { error: string } {
    if (typeof requestedPath !== "string" || requestedPath.length === 0) {
      return { error: "path must be a non-empty string" };
    }
    if (requestedPath.startsWith("/") || requestedPath.startsWith("\\")) {
      return { error: "absolute paths are not allowed; use a path relative to an inspect root" };
    }
    if (requestedPath.split(/[/\\]/).some((seg) => seg === "..")) {
      return { error: "'..' segments are not allowed" };
    }
    const ext = path.extname(requestedPath).toLowerCase();
    if (ext && !this.ctx.auditableExt.has(ext)) {
      return { error: `extension '${ext}' is not in the auditable allowlist (binaries cannot be inspected)` };
    }

    for (const root of this.ctx.inspectRoots) {
      const rootReal = realPathOrSelf(path.resolve(root));
      const candidate = path.resolve(root, requestedPath);
      if (!fs.existsSync(candidate)) continue;
      let stat: fs.Stats;
      try { stat = fs.statSync(candidate); } catch { continue; }
      if (!stat.isFile()) continue;
      const candidateReal = realPathOrSelf(candidate);
      const containmentOk =
        candidateReal === rootReal ||
        candidateReal.startsWith(rootReal + path.sep);
      if (!containmentOk) continue;       // symlink out of root → silently skip
      return { abs: candidateReal, root: rootReal };
    }
    return { error: `not found in any inspect root: ${requestedPath}` };
  }

  read(requestedPath: string, reason: string): ReadResult {
    const ts = new Date().toISOString();
    const reasonClean = (typeof reason === "string" ? reason : "").slice(0, 500);

    if (this.filesRead >= this.ctx.maxFiles) {
      const rec: InspectionRecord = {
        requestedPath, resolvedRoot: null, ok: false,
        bytesReturned: 0, totalSize: 0, truncated: false, reason: reasonClean,
        errorDetail: `max files (${this.ctx.maxFiles}) reached`, ts,
      };
      this.inspected.push(rec);
      return { ok: false, error: rec.errorDetail! };
    }
    if (this.bytesRead >= this.ctx.maxTotalBytes) {
      const rec: InspectionRecord = {
        requestedPath, resolvedRoot: null, ok: false,
        bytesReturned: 0, totalSize: 0, truncated: false, reason: reasonClean,
        errorDetail: `max bytes (${this.ctx.maxTotalBytes}) reached`, ts,
      };
      this.inspected.push(rec);
      return { ok: false, error: rec.errorDetail! };
    }

    const resolved = this.resolveSafe(requestedPath);
    if ("error" in resolved) {
      this.inspected.push({
        requestedPath, resolvedRoot: null, ok: false,
        bytesReturned: 0, totalSize: 0, truncated: false, reason: reasonClean,
        errorDetail: resolved.error, ts,
      });
      return { ok: false, error: resolved.error };
    }

    const stat = fs.statSync(resolved.abs);
    const remaining = this.ctx.maxTotalBytes - this.bytesRead;
    const len = Math.min(stat.size, this.ctx.maxBytesPerFile, remaining);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(resolved.abs, "r");
    try {
      fs.readSync(fd, buf, 0, len, 0);
    } finally {
      fs.closeSync(fd);
    }

    this.filesRead += 1;
    this.bytesRead += len;
    const truncated = stat.size > len;

    this.inspected.push({
      requestedPath,
      resolvedRoot: resolved.root,
      ok: true,
      bytesReturned: len,
      totalSize: stat.size,
      truncated,
      reason: reasonClean,
      ts,
    });

    return { ok: true, relPath: requestedPath, size: stat.size, truncated, contents: buf.toString("utf8") };
  }
}

function realPathOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}
