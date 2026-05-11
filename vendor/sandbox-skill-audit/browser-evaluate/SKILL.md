---
name: browser-evaluate-surface
description: Audit-narrowed view of the openclaw browser plugin focused on the evaluate() arbitrary-JS path and its gating, audit-trail, and abort behavior.
user-invocable: false
metadata:
  {
    "openclaw":
      {
        "emoji": "⚠️",
        "skillKey": "browser-automation",
        "requires":
          {
            "config": ["plugins.entries.browser.enabled"]
          }
      }
  }
---

# Browser Plugin — `evaluate()` Path (Audit Slice)

This snapshot is an AUDIT-NARROWED view of `plugins.entries.browser`
focused on the SINGLE most dangerous code path: `browser.evaluate()`,
which lets an agent run arbitrary JS in a page context. The goal of
this audit is to deep-walk the gating logic, the abort/timeout
behavior, and any audit-trail emission so we know exactly what we're
about to default-disable and per-session opt-in for.

The threat model: even with `evaluate` opt-in, a prompt-injection in
a navigated page may persuade the agent to run attacker-supplied JS.
Three load-bearing invariants:

1. **Off-by-default.** A fresh session, with no operator opt-in, MUST
   refuse `evaluate`. The default-off check must be in code, not just
   docs.
2. **Per-session, not per-process.** Opting in for one session must
   not leak to siblings. A profile-level opt-in is acceptable; a
   global flag-on-once-stays-on-forever is a finding.
3. **Aborts are honest.** A long-running `evaluate` must actually
   stop when aborted, not detach silently and keep modifying page
   state.

CLAW-015 will add three patches on top of this code:
`0001-require-evaluate-audit-log.patch` (refuse `evaluate` if the
JSONL writer can't open), `0002-default-tracing-on.patch` (Playwright
tracing always-on for `evaluate`-enabled sessions),
`0003-evaluate-history-security-collector.patch` (surface the JSONL
slice via the standard `securityAuditCollectors` hook). This audit
should report which of those patches the upstream code already
satisfies and which require new code.

## Auditor focus

Required reads:

- `src/browser/pw-tools-core.interactions.ts` — find the `evaluate`
  case branch. How is the script string passed? Is there any input
  sanitization / source-map stripping? How is the return value
  serialized (any DOM-leaking risks)?
- `src/browser/pw-tools-core.interactions.evaluate.abort.test.ts` —
  the abort-honesty assertion.
- `src/browser/server.evaluate-disabled-does-not-block-storage.test.ts`
  — confirms default-off is the actual default and storage tools
  don't get blocked by it.
- `src/browser/pw-ai-module.ts` and `src/browser/pw-ai.ts` — anything
  AI-driven that could call `evaluate` indirectly. Look for paths
  that bypass the session-level opt-in.
- `src/browser/act-policy.ts` — does the act-policy layer have its
  own opinion on `evaluate`? Is it aligned with the session-level
  toggle?
- `browser-config.ts` (top-level) — where `DEFAULT_BROWSER_EVALUATE_ENABLED`
  is exported. Confirm it's `false`. Confirm no other config path
  silently flips it on.
- `src/browser/client-actions-core.ts` — client-action surface that
  may expose `evaluate` to non-evaluate-named actions (e.g. `act`
  could compose into `evaluate` via a fallback).

Findings to look for:

- **High** — any path where `evaluate` runs without the session-level
  toggle being checked (e.g. `pw-ai.ts` calls into `evaluate` directly
  bypassing the gate).
- **High** — `DEFAULT_BROWSER_EVALUATE_ENABLED` defaults to `true`
  upstream (we'd want to override at our entrypoint, but we should
  know).
- **High** — return-value serialization that includes function-
  callable objects (proxies, Promises that resolve to attacker-
  controlled JS) — could re-inject into the agent loop.
- **Medium** — `evaluate` doesn't emit a structured audit-log row
  today (CLAW-015 territory; we're recording the gap, not blocking).
- **Medium** — abort-test exists but the production `evaluate` path
  doesn't pass an `AbortSignal` through to Playwright's
  `page.evaluate({ ..., timeout })`.
- **Low** — long script bodies are truncated in error messages but
  not in the return path (so an exfil channel via thrown error is
  blocked but via return value is not).

The auditor should also check: does the `act` action ever compose
into `evaluate` semantics? `act` is meant for click/type/etc., not
arbitrary JS — but if its implementation falls back to `evaluate`
for unhandled cases, the gate has a hole.

## Implementation backing

`plugins.entries.browser`. The evaluate path centers on
`pw-tools-core.interactions.ts` (the `evaluate` case + abort
plumbing), gated by `browser-config.ts`'s
`DEFAULT_BROWSER_EVALUATE_ENABLED`. Tests:
`pw-tools-core.interactions.evaluate.abort.test.ts` and
`server.evaluate-disabled-does-not-block-storage.test.ts`. Adjacent
risk: `pw-ai-module.ts` / `pw-ai.ts` (AI-loop) and `act-policy.ts`
(action policy). Deep-walk these and emit a verdict on the
EVALUATE PATH only.
