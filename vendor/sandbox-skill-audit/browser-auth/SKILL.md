---
name: browser-auth-surface
description: Audit-narrowed view of the openclaw browser plugin focused on its local-bridge auth surface (control-auth tokens, bridge server, CSRF).
user-invocable: false
metadata:
  {
    "openclaw":
      {
        "emoji": "🔐",
        "skillKey": "browser-automation",
        "requires":
          {
            "config": ["plugins.entries.browser.enabled"]
          }
      }
  }
---

# Browser Plugin — Auth Surface (Audit Slice)

This snapshot is an AUDIT-NARROWED view of the same `plugins.entries.browser`
plugin that ships in oasis-claw. The skill body itself is unchanged from
`browser-automation`; the goal of this audit is to deep-walk the local-bridge
authentication surface specifically.

The browser plugin runs a local HTTP/WS bridge server (default `127.0.0.1`)
through which the openclaw gateway and the agent both reach Chromium via CDP.
Three properties are load-bearing for safety:

1. **Bridge bind addr is loopback by default.** Anything broader is a finding.
2. **Control-auth token is required and fail-closed.** A missing or invalid
   token must reject the request before any side effect — including any
   browser navigation, screenshot, or CDP attach.
3. **CSRF protection is in effect for state-changing routes** so a malicious
   web page that the browser plugin is navigating cannot pivot to issue
   commands back to the bridge.

## Auditor focus

Use `inspect_file` to deep-walk these paths under
`extensions/browser/`. Spend the inspect budget here — we want
opinions on this code, not a coverage waiver.

Required reads (auth surface — please open all of these):

- `src/browser/bridge-server.ts` — bind addr, route auth wiring, error paths.
  Verify the bind defaults to loopback and the auth check happens before
  the route handler does any work (fail-closed).
- `src/browser/control-auth.ts` — token mint, compare, rotation. Constant-time
  compare? Token in URL vs header? Logged anywhere?
- `src/browser/csrf.ts` — what's the protection model, is it origin-check,
  double-submit cookie, header-based? Are state-changing routes opt-in or
  opt-out?
- `src/browser/bridge-auth-registry.ts` — token lifetime, scope, revocation.
- `src/browser/server.auth-fail-closed.test.ts` and
  `src/browser/server.auth-token-gates-http.test.ts` — assert the actual
  invariants, useful for grounding what the code claims to do.

Findings to look for:

- **High** — any code path that reaches a CDP attach, a navigation, a
  screenshot, or a downloads side-effect WITHOUT first verifying the
  control-auth token. The whole plugin's safety story collapses if there's
  a token-bypass.
- **High** — bind addr that defaults to non-loopback, or a config knob that
  silently exposes the bridge on `0.0.0.0`.
- **Medium** — token compared with `==` / `===` instead of a constant-time
  primitive (timing leak).
- **Medium** — token logged at any level above `debug`, or token written to
  a world-readable file.
- **Medium** — CSRF disabled-by-default for any route that mutates state.
- **Low** — unsigned WS upgrade where the upgrade handshake bypasses auth
  even though the eventual frames are auth-checked.

If anything in these files looks like it was added recently (commit-history
hints in comments, "TODO" markers near auth) call it out as
`auditability:medium` so we re-review before merging the next upstream bump.

## Implementation backing

This skill drives `plugins.entries.browser`. See the openclaw browser plugin
at `extensions/browser/`. The auth surface is the `bridge-server.ts` +
`control-auth.ts` + `csrf.ts` + `bridge-auth-registry.ts` quartet, with
`server.auth-fail-closed.test.ts` and `server.auth-token-gates-http.test.ts`
as the assertion layer. Deep-walk these specifically and emit a verdict on
the AUTH SURFACE only — other concerns (SSRF, evaluate, profiles) are
audited separately.
