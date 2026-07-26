/**
 * gitignore read-shroud — result transform (CLAW-043, Layer 2, seam-agnostic).
 *
 * Turns a shroud verdict into the actual replacement the bot sees. Contents are
 * withheld; a short notice + metadata (size/mode/mtime) takes their place so the
 * bot still knows the file EXISTS and can reason about posture, then request a
 * per-session unlock (CLAW-044) if a specific value is genuinely needed.
 *
 * Pure. The caller does the fs.stat and path classification; this module only
 * shapes text and rewrites result payloads.
 */

export interface ShroudStat {
  size?: number;
  mode?: string; // e.g. "0600"
  mtimeIso?: string;
}

/** The notice that replaces a shrouded file's contents. */
export function shroudPlaceholder(absPath: string, reason: string, stat?: ShroudStat): string {
  const meta: string[] = [];
  if (stat?.size != null) meta.push(`${stat.size} bytes`);
  if (stat?.mode) meta.push(`mode ${stat.mode}`);
  if (stat?.mtimeIso) meta.push(`mtime ${stat.mtimeIso}`);
  const metaStr = meta.length ? ` Metadata: ${meta.join(", ")}.` : "";
  return (
    `«shrouded: ${absPath} — contents withheld (${reason}).${metaStr} ` +
    `This path is gitignored/secret; request a per-session unlock to read its contents.»`
  );
}

/** Read/Write tools carry the path under one of these keys (openclaw resolvePathArg order). */
export function extractReadPath(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const k of ["path", "file_path", "filePath"]) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * OpenClawAgentToolResult is either a string or `{ content: Array<{type,text}>, isError? }`.
 * Replace all text with the placeholder, preserving the container shape and any
 * error flag. Non-text blocks (rare for Read) are dropped from the shrouded view.
 */
export type ToolResultLike =
  | string
  | { content?: Array<{ type?: string; text?: string }>; isError?: boolean; [k: string]: unknown };

export function applyPlaceholder(result: ToolResultLike, placeholder: string): ToolResultLike {
  if (typeof result === "string") return placeholder;
  if (result && Array.isArray(result.content)) {
    return { ...result, content: [{ type: "text", text: placeholder }] };
  }
  // Unknown shape → wrap conservatively so nothing leaks.
  return { ...(result as object), content: [{ type: "text", text: placeholder }] } as ToolResultLike;
}

/**
 * Best-effort path tokens from a Bash command string. Bash results expose only
 * the command (no files-touched list), so the shroud is coarse: if the command
 * text references any shrouded path, the whole result is withheld. This extracts
 * candidate path-like tokens for the caller to classify.
 */
export function extractPathTokens(command: string): string[] {
  if (!command) return [];
  const out = new Set<string>();
  // Unquoted/quoted tokens that look like paths (contain a slash) or dotfiles.
  const re = /(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const tok = m[1] ?? m[2] ?? m[3] ?? "";
    const cleaned = tok.replace(/[;|&<>()]+$/g, "");
    if (cleaned.includes("/") || /^\.?[\w.-]*(env|secret|key|pem|credentials|netrc)/i.test(cleaned)) {
      out.add(cleaned);
    }
  }
  return [...out];
}
