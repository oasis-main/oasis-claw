/**
 * Auditor — calls Opus 4.7 to grade an installed skill against the security
 * threat model in audit-prompt.ts.
 *
 * Two operating modes:
 *
 *   1. Snapshot-only (no Inspector passed): single turn. The model sees the
 *      skill's files plus a coverage hint and emits its verdict via the
 *      forced emit_audit tool. Same as the original.
 *
 *   2. Deep reference walk (Inspector passed): multi-turn loop. The model has
 *      a second tool, inspect_file, that it can call up to N times to read
 *      source files referenced by the skill (typically the host plugin's
 *      runtime code). Every tool call is bounded — see inspector.ts. The
 *      loop terminates when the model emits emit_audit, when the budget runs
 *      out, or when MAX_TURNS is reached. Inspected files are recorded on
 *      the verdict for the audit trail.
 *
 * Opus 4.7 was chosen specifically for the inspect path because it's the
 * most prompt-injection-resistant model available — necessary because the
 * inspected file contents are themselves attacker-controlled in the
 * adversarial case.
 */

import {
  AUDITOR_SYSTEM_PROMPT,
  buildAuditUserPrompt,
  EMIT_AUDIT_TOOL,
  INSPECT_FILE_TOOL,
} from "./audit-prompt.js";
import type { Inspector, InspectionRecord } from "./inspector.js";
import type { SkillSnapshot } from "./skill-scanner.js";

export type AuditFinding = {
  category: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  file: string;
  detail: string;
};

/**
 * Promoted from `string[]` — the model now emits a structured entry per
 * un-inspected reference so downstream tooling can sort by severity. The
 * normalizer accepts the legacy string form too, mapping it to severity=low
 * with reason="(unspecified)" — that's the back-compat path for old logs and
 * for cases where Opus drops back to the simpler shape.
 */
export type UnauditedPath = {
  path: string;
  reason: string;
  severity: "info" | "low" | "medium" | "high";
};

export type AuditCoverage = {
  audited_files: number;
  declared_external_refs: string[];
  unaudited_paths: UnauditedPath[];
  pct_visible: number;
};

export type AuditVerdict = {
  verdict: "pass" | "warn" | "block" | "error";
  risk_score: number;
  summary: string;
  findings: AuditFinding[];
  coverage: AuditCoverage;
  /** Files the model read via inspect_file. Empty when running snapshot-only. */
  inspections: InspectionRecord[];
  auditModel: string;
  auditedAt: string;
  latencyMs: number;
  errorDetail?: string;
};

export type AuditorOpts = {
  apiKey: string;
  model: string;
  /** When provided, enables the deep reference walk. Inspector enforces the
   *  bounds; auditor only enforces the turn cap. */
  inspector?: Inspector;
};

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
// Audit verdicts can run 1k+ output tokens for skills with multiple findings;
// 2048 truncated mid-JSON on sherpa-onnx-tts and silently broke the parser.
// 4096 leaves headroom for the most verbose realistic case.
const MAX_TOKENS = 4096;
// Multi-turn cap. With a 10-file inspection budget, 12 turns is enough headroom
// for the model to inspect, reflect, and emit. After this, we force emit_audit.
const MAX_TURNS = 12;

type Message = { role: "user" | "assistant"; content: unknown };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type TextBlock = { type: "text"; text: string };
type AnthropicContentBlock = TextBlock | ToolUseBlock;
type AnthropicResponse = { content?: AnthropicContentBlock[]; stop_reason?: string };

export async function runAudit(snapshot: SkillSnapshot, opts: AuditorOpts): Promise<AuditVerdict> {
  const startedAt = Date.now();
  const inspector = opts.inspector;

  const userPrompt = buildAuditUserPrompt({
    skillId: snapshot.skillId,
    files: snapshot.files,
    coverage: {
      audited_files: snapshot.files.length,
      declared_external_refs: snapshot.externalRefs,
    },
    inspection: inspector
      ? {
          rootLabels: inspector.rootLabels(),
          maxFiles: inspector.remainingBudget().files,
          maxTotalBytes: inspector.remainingBudget().bytes,
          maxBytesPerFile: inspector.perFileBudget(),
        }
      : null,
  });

  const messages: Message[] = [{ role: "user", content: userPrompt }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Decide tools/tool_choice for THIS turn.
    //   - With no inspector: forced emit_audit, single turn.
    //   - With inspector: provide both tools and let the model choose, EXCEPT
    //     on the final permitted turn (or when the inspector budget is gone),
    //     where we force emit_audit so the audit can't loop forever.
    const inspectorAvailable = inspector && !inspector.budgetExhausted() && turn < MAX_TURNS - 1;
    const tools = inspectorAvailable ? [INSPECT_FILE_TOOL, EMIT_AUDIT_TOOL] : [EMIT_AUDIT_TOOL];
    const tool_choice = inspectorAvailable
      ? { type: "any" } // model picks emit_audit OR inspect_file
      : { type: "tool", name: EMIT_AUDIT_TOOL.name };

    const body = {
      model: opts.model,
      max_tokens: MAX_TOKENS,
      system: AUDITOR_SYSTEM_PROMPT,
      tools,
      tool_choice,
      messages,
    };

    let res: Response;
    try {
      res = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return errorVerdict(opts, snapshot, startedAt, `network: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      return errorVerdict(opts, snapshot, startedAt, `http ${res.status}: ${text.slice(0, 500)}`);
    }
    let data: AnthropicResponse;
    try {
      data = (await res.json()) as AnthropicResponse;
    } catch (err) {
      return errorVerdict(opts, snapshot, startedAt, `json parse: ${(err as Error).message}`);
    }

    const blocks = data.content ?? [];
    const allToolUses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (allToolUses.length === 0) {
      return errorVerdict(opts, snapshot, startedAt, `turn ${turn}: model did not call any tool`);
    }

    // If ANY block is emit_audit, that's the terminal call. Anthropic only
    // strictly requires tool_results for tool_uses *if we're going to send
    // another message* — since emit_audit is terminal, we can return now.
    const emit = allToolUses.find((b) => b.name === EMIT_AUDIT_TOOL.name);
    if (emit) {
      const unwrapped = unwrapEmitAudit(emit.input);
      const parsed = normalizeVerdict(unwrapped, snapshot);
      return {
        ...parsed,
        inspections: inspector?.inspected ?? [],
        auditModel: opts.model,
        auditedAt: new Date(startedAt).toISOString(),
        latencyMs: Date.now() - startedAt,
      };
    }

    // Otherwise every tool_use must be inspect_file. Anthropic requires one
    // tool_result per tool_use, all in the immediately-following user message.
    // Process them all, batch into a single user-message content array.
    const tool_results: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }> = [];
    for (const toolUse of allToolUses) {
      if (toolUse.name !== INSPECT_FILE_TOOL.name || !inspector) {
        return errorVerdict(opts, snapshot, startedAt, `turn ${turn}: unexpected tool '${toolUse.name}'`);
      }
      const args = (toolUse.input ?? {}) as { path?: string; reason?: string };
      const result = inspector.read(args.path ?? "", args.reason ?? "");
      const remaining = inspector.remainingBudget();
      const tool_result_text = result.ok
        ? `File: ${result.relPath} (${result.size} bytes${result.truncated ? ", truncated to budget" : ""})\n` +
          `Remaining budget: ${remaining.files} files, ${remaining.bytes} bytes\n\n` +
          `--- BEGIN UNTRUSTED FILE CONTENT ---\n${result.contents}\n--- END UNTRUSTED FILE CONTENT ---`
        : `Error: ${result.error}\nRemaining budget: ${remaining.files} files, ${remaining.bytes} bytes`;
      tool_results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: tool_result_text,
        is_error: !result.ok,
      });
    }
    messages.push({ role: "assistant", content: blocks });
    messages.push({ role: "user", content: tool_results });
    continue;
  }

  return errorVerdict(opts, snapshot, startedAt, `MAX_TURNS (${MAX_TURNS}) reached without emit_audit`);
}

/** Opus 4.7 occasionally double-wraps emit_audit's input as `{input: {...}}`
 *  under forced tool_choice. Unwrap if so; otherwise pass through. */
function unwrapEmitAudit(rawInput: unknown): unknown {
  if (!rawInput || typeof rawInput !== "object") return rawInput;
  const r = rawInput as Record<string, unknown>;
  if (
    r.input &&
    typeof r.input === "object" &&
    !Array.isArray(r.input) &&
    "verdict" in (r.input as Record<string, unknown>)
  ) {
    return r.input;
  }
  return rawInput;
}

function normalizeVerdict(
  raw: unknown,
  snapshot: SkillSnapshot,
): Omit<AuditVerdict, "auditModel" | "auditedAt" | "latencyMs" | "inspections"> {
  const r = (raw ?? {}) as Record<string, unknown>;
  let verdict: "pass" | "warn" | "block" =
    r.verdict === "pass" || r.verdict === "warn" || r.verdict === "block" ? r.verdict : "warn";
  const summary = typeof r.summary === "string" ? r.summary : "(no summary)";
  const findingsRaw = Array.isArray(r.findings) ? r.findings : [];
  const findings: AuditFinding[] = findingsRaw
    .map((f) => normalizeFinding(f))
    .filter((f): f is AuditFinding => f !== undefined);

  const coverage = normalizeCoverage(r.coverage, snapshot);

  // Server-side enforcement of the auditability rule from the system prompt:
  // any auditability finding at medium+ caps the verdict at 'warn'. Same for
  // a coverage gap (external refs declared but pct_visible still low after
  // any inspections), and for any high-severity unaudited path.
  const hasMediumAuditability = findings.some(
    (f) => f.category === "auditability" && (f.severity === "medium" || f.severity === "high" || f.severity === "critical"),
  );
  const hasCoverageGap = snapshot.externalRefs.length > 0 && coverage.pct_visible < 50;
  const hasHighUnaudited = coverage.unaudited_paths.some((u) => u.severity === "high");
  if ((hasMediumAuditability || hasCoverageGap || hasHighUnaudited) && verdict === "pass") {
    verdict = "warn";
  }

  let risk_score =
    typeof r.risk_score === "number" && Number.isFinite(r.risk_score)
      ? Math.max(0, Math.min(100, Math.round(r.risk_score)))
      : verdict === "block"
        ? 90
        : verdict === "warn"
          ? 50
          : 0;
  // Coverage-gap risk surcharge — caps at +30 to leave headroom for honest 'warn'.
  if (snapshot.externalRefs.length > 0) {
    const surcharge = Math.max(0, Math.min(30, Math.round((100 - coverage.pct_visible) * 0.3)));
    risk_score = Math.min(100, risk_score + surcharge);
  }

  return { verdict, risk_score, summary, findings, coverage };
}

function normalizeCoverage(raw: unknown, snapshot: SkillSnapshot): AuditCoverage {
  const c = (raw ?? {}) as Record<string, unknown>;
  const audited_files =
    typeof c.audited_files === "number" && Number.isFinite(c.audited_files)
      ? Math.max(0, Math.round(c.audited_files))
      : snapshot.files.length;
  const declared_external_refs = Array.isArray(c.declared_external_refs)
    ? c.declared_external_refs.filter((x): x is string => typeof x === "string")
    : snapshot.externalRefs;
  const unaudited_paths = Array.isArray(c.unaudited_paths)
    ? c.unaudited_paths.map((x) => normalizeUnauditedPath(x)).filter((x): x is UnauditedPath => x !== undefined)
    : [];
  const pct_visible =
    typeof c.pct_visible === "number" && Number.isFinite(c.pct_visible)
      ? Math.max(0, Math.min(100, Math.round(c.pct_visible)))
      : declared_external_refs.length === 0
        ? 100
        : 50;
  return { audited_files, declared_external_refs, unaudited_paths, pct_visible };
}

/** Accept both the new structured shape and the legacy bare-string shape. */
function normalizeUnauditedPath(raw: unknown): UnauditedPath | undefined {
  if (typeof raw === "string") {
    return { path: raw, reason: "(unspecified)", severity: "low" };
  }
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const path = typeof r.path === "string" ? r.path : undefined;
  if (!path) return undefined;
  const sev = r.severity;
  const severity: UnauditedPath["severity"] =
    sev === "info" || sev === "low" || sev === "medium" || sev === "high" ? sev : "low";
  const reason = typeof r.reason === "string" ? r.reason.slice(0, 500) : "(unspecified)";
  return { path, reason, severity };
}

function normalizeFinding(raw: unknown): AuditFinding | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const f = raw as Record<string, unknown>;
  const sev = f.severity;
  const severity =
    sev === "info" || sev === "low" || sev === "medium" || sev === "high" || sev === "critical"
      ? sev
      : "medium";
  return {
    category: typeof f.category === "string" ? f.category : "other",
    severity,
    file: typeof f.file === "string" ? f.file : "(unknown)",
    detail: typeof f.detail === "string" ? f.detail.slice(0, 1000) : "(no detail)",
  };
}

function errorVerdict(
  opts: AuditorOpts,
  snapshot: SkillSnapshot,
  startedAt: number,
  detail: string,
): AuditVerdict {
  return {
    verdict: "error",
    risk_score: -1 as unknown as number,
    summary: `Auditor call failed: ${detail}`,
    findings: [],
    coverage: { audited_files: snapshot.files.length, declared_external_refs: snapshot.externalRefs, unaudited_paths: [], pct_visible: 0 },
    inspections: opts.inspector?.inspected ?? [],
    auditModel: opts.model,
    auditedAt: new Date(startedAt).toISOString(),
    latencyMs: Date.now() - startedAt,
    errorDetail: detail,
  };
}
