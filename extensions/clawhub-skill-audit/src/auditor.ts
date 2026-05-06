/**
 * Auditor — calls the Anthropic API with Opus 4.7 (default) using a forced
 * tool_use call so the verdict comes back as schema-validated JSON instead
 * of free-form text.
 *
 * No streaming, no retries-on-rate-limit (the skill-audit path is rare and
 * non-blocking); a failure surfaces as verdict='error' so the trail entry
 * still records the attempt.
 */

import {
  AUDITOR_SYSTEM_PROMPT,
  buildAuditUserPrompt,
  EMIT_AUDIT_TOOL,
} from "./audit-prompt.js";
import type { SkillSnapshot } from "./skill-scanner.js";

export type AuditFinding = {
  category: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  file: string;
  detail: string;
};

export type AuditVerdict = {
  verdict: "pass" | "warn" | "block" | "error";
  risk_score: number;
  summary: string;
  findings: AuditFinding[];
  auditModel: string;
  auditedAt: string;
  latencyMs: number;
  errorDetail?: string;
};

export type AuditorOpts = {
  apiKey: string;
  model: string;
};

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 2048;

export async function runAudit(snapshot: SkillSnapshot, opts: AuditorOpts): Promise<AuditVerdict> {
  const startedAt = Date.now();
  const userPrompt = buildAuditUserPrompt({ skillId: snapshot.skillId, files: snapshot.files });

  const body = {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: AUDITOR_SYSTEM_PROMPT,
    tools: [EMIT_AUDIT_TOOL],
    tool_choice: { type: "tool", name: EMIT_AUDIT_TOOL.name },
    messages: [{ role: "user", content: userPrompt }],
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
    return errorVerdict(opts.model, startedAt, `network: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    return errorVerdict(opts.model, startedAt, `http ${res.status}: ${text.slice(0, 500)}`);
  }

  let data: AnthropicResponse;
  try {
    data = (await res.json()) as AnthropicResponse;
  } catch (err) {
    return errorVerdict(opts.model, startedAt, `json parse: ${(err as Error).message}`);
  }

  const toolUse = (data.content ?? []).find((b) => b.type === "tool_use" && b.name === EMIT_AUDIT_TOOL.name);
  if (!toolUse || toolUse.type !== "tool_use") {
    return errorVerdict(opts.model, startedAt, "model did not call emit_audit");
  }

  const parsed = normalizeVerdict(toolUse.input);
  return {
    ...parsed,
    auditModel: opts.model,
    auditedAt: new Date(startedAt).toISOString(),
    latencyMs: Date.now() - startedAt,
  };
}

function normalizeVerdict(raw: unknown): Omit<AuditVerdict, "auditModel" | "auditedAt" | "latencyMs"> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const verdict = r.verdict === "pass" || r.verdict === "warn" || r.verdict === "block" ? r.verdict : "warn";
  const risk_score =
    typeof r.risk_score === "number" && Number.isFinite(r.risk_score)
      ? Math.max(0, Math.min(100, Math.round(r.risk_score)))
      : verdict === "block"
        ? 90
        : verdict === "warn"
          ? 50
          : 0;
  const summary = typeof r.summary === "string" ? r.summary : "(no summary)";
  const findingsRaw = Array.isArray(r.findings) ? r.findings : [];
  const findings: AuditFinding[] = findingsRaw
    .map((f) => normalizeFinding(f))
    .filter((f): f is AuditFinding => f !== undefined);
  return { verdict, risk_score, summary, findings };
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

function errorVerdict(model: string, startedAt: number, detail: string): AuditVerdict {
  return {
    verdict: "error",
    risk_score: -1 as unknown as number,
    summary: `Auditor call failed: ${detail}`,
    findings: [],
    auditModel: model,
    auditedAt: new Date(startedAt).toISOString(),
    latencyMs: Date.now() - startedAt,
    errorDetail: detail,
  };
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown };

type AnthropicResponse = {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
};
