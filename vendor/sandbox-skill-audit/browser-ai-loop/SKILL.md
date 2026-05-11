---
name: browser-ai-loop-surface
description: Audit-narrowed view of the openclaw browser plugin focused on indirect evaluate() reach via the AI-loop, act policy, and client-actions composition.
user-invocable: false
metadata:
  {
    "openclaw":
      {
        "emoji": "🔁",
        "skillKey": "browser-automation",
        "requires":
          {
            "config": ["plugins.entries.browser.enabled"]
          }
      }
  }
---

# Browser Plugin — AI-Loop / Indirect Evaluate (Audit Slice)

This is the FOLLOW-UP to the `browser-evaluate` audit slice. That audit
verified the direct evaluate() entry point and surfaced one finding
(`DEFAULT_BROWSER_EVALUATE_ENABLED = true` upstream — we patch this).
Its two `medium` unaudited paths — `pw-ai-module.ts` and `pw-ai.ts` — were
flagged as adjacent risk for "indirect evaluate calls" / "AI-loop bypassing
session opt-in" but not opened. This snapshot opens them, plus
`act-policy.ts` and `client-actions-core.ts`, plus the FULL
`pw-tools-core.interactions.ts` evaluate branch (the previous audit truncated
that file at 32KB; the inspector budget has been raised to 96KB per-file
specifically so it fits this round).

The threat we're hunting: even with our entrypoint flipping the runtime
default of evaluate to OFF and even with the session-toggle gate at the
direct entry point, an INDIRECT path that calls into `evaluate` without
consulting the session toggle would re-open the hole. Specifically:

1. The AI-loop (`pw-ai.ts` / `pw-ai-module.ts`) is autonomous code that
   plans + executes browser actions on the agent's behalf. If it composes
   into `page.evaluate()` directly — bypassing the public `evaluate`
   action's gate — then disabling `evaluate` at the action layer doesn't
   actually disable arbitrary-JS execution.
2. `client-actions-core.ts` is the action dispatch surface. If an action
   labeled (say) `act:type` falls back to `evaluate` for unhandled cases,
   the gate has a hole through that action.
3. `act-policy.ts` is the policy layer for the `act` family of actions.
   Its alignment with the session evaluate toggle is the property we want
   to verify — if the policy layer doesn't ask "is evaluate enabled for
   this session" before allowing an act-step that ends up running JS,
   that's a finding.

## Auditor focus

Required reads (use the bumped 96KB per-file budget — read fully, not
truncated):

- `src/browser/pw-tools-core.interactions.ts` (~100KB) — the FULL file.
  Find every callsite of `page.evaluate(`, `frame.evaluate(`,
  `evaluateHandle(`, or any internal helper that invokes them. For each
  callsite, verify the session-level evaluate toggle is checked OR
  document why the call is safe (e.g. it runs a hardcoded read-only
  expression, no agent-controlled string). Anything that runs an
  agent-controlled string outside the public `evaluate` action's gate
  is `high`.
- `src/browser/pw-ai.ts` and `src/browser/pw-ai-module.ts` — the AI-loop.
  Does it call `page.evaluate` directly? Does it run agent-supplied JS as
  part of a planning/observation step? If it does, is that gated?
- `src/browser/act-policy.ts` — the act-family policy. Does it know about
  the evaluate toggle? Does it gate `act:type` / `act:fill` from falling
  back to evaluate?
- `src/browser/client-actions-core.ts` and `src/browser/client-actions.ts`
  — the client-action dispatch. Are there fall-throughs that compose into
  evaluate? Look for any `case "evaluate":` or `actionType === "evaluate"`
  branches reachable from a non-`evaluate` action label.
- `src/browser/pw-ai-state.ts` — state across the AI-loop. Does any state
  carry agent-supplied JS forward into a later evaluate-shaped call?

Findings to look for:

- **High** — any direct `page.evaluate(<agent-supplied-string>)` call
  reachable from an action OTHER than the public `evaluate` action,
  without the session toggle being checked first.
- **High** — the AI-loop (`pw-ai.ts`) running JS via `evaluate` to
  observe / plan, where the JS body is built from agent-controlled
  text (DOM queries built from agent output, rather than hardcoded
  selectors).
- **Medium** — `client-actions-core.ts` having a fallback path from
  one action to another that crosses the evaluate boundary.
- **Medium** — `act-policy.ts` not consulting the session evaluate
  toggle when the action under policy is `act:type` (which historically
  uses page-level scripting to set values).
- **Medium** — any `evaluateHandle` callsite that returns a handle the
  agent loop can then invoke (turning a one-shot evaluate into a
  persistent JS context).
- **Low** — internal evaluate-shaped calls that ARE safe (hardcoded
  expression, no agent input) but lack a comment explaining why.

If `pw-tools-core.interactions.ts` is now visible in full at 96KB,
flag any difference between what was visible at 32KB (first ~700 lines)
and what's now visible — particularly the gating wrapper around the
`evaluate` action.

## Implementation backing

`plugins.entries.browser`. AI-loop and client-action composition layers
of the browser plugin. Files: `extensions/browser/src/browser/pw-ai.ts`,
`pw-ai-module.ts`, `pw-ai-state.ts`, `pw-tools-core.interactions.ts`,
`act-policy.ts`, `client-actions-core.ts`, `client-actions.ts`. Tests
that may anchor expected behavior: `pw-tools-core.interactions.evaluate.abort.test.ts`,
`pw-tools-core.interactions.batch.test.ts`,
`pw-tools-core.interactions.navigation-guard.test.ts`. Emit a verdict
on the AI-LOOP / INDIRECT-EVALUATE surface only.
