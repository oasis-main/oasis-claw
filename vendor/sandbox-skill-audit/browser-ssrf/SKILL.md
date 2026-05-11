---
name: browser-ssrf-surface
description: Audit-narrowed view of the openclaw browser plugin focused on outbound-request safety (SSRF guards, CDP reachability, navigation guard).
user-invocable: false
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "skillKey": "browser-automation",
        "requires":
          {
            "config": ["plugins.entries.browser.enabled"]
          }
      }
  }
---

# Browser Plugin — SSRF / Outbound Surface (Audit Slice)

This snapshot is an AUDIT-NARROWED view of the same `plugins.entries.browser`
plugin. The goal of this audit is to deep-walk the request-policy and
navigation-guard layers specifically — i.e. everything that decides
"is this URL safe for the agent's browser to reach".

A browser plugin running inside our container is a confused-deputy hazard:
the agent issues a navigation, but the plugin's network identity is the
container's, which has access to the docker bridge network, the host
loopback (via `host.docker.internal`), and (critically) cloud-metadata
endpoints like `169.254.169.254` if the container is ever lifted to a
cloud host. Three invariants must hold:

1. **Loopback / link-local / RFC1918 / metadata IPs are denied by default**
   for both navigations AND any subresource fetches that happen as a
   consequence of a navigation (because Chromium will fetch ads, fonts,
   tracking pixels — the policy must apply uniformly).
2. **`file://` is denied** unless explicitly enabled per-profile.
3. **Hostname resolution doesn't pivot** — the policy must re-check the
   resolved IP, not just the hostname, and reject if it lands in a denied
   range. DNS rebinding is the classic bypass class.

## Auditor focus

Required reads (SSRF surface):

- `src/browser/request-policy.ts` — the outbound-request policy. What does
  it allow / deny by default? Are loopback, link-local, RFC1918, and the
  AWS/GCP metadata IPs all in the deny list?
- `src/browser/cdp-reachability-policy.ts` — policy applied at the CDP
  layer. Should be defense-in-depth with request-policy, NOT the only
  guard.
- `src/browser/navigation-guard.ts` — pre-navigation URL filter. How does
  it interact with redirects? Does it re-check at each hop?
- `src/browser/cdp-proxy-bypass.ts` — anything here that lets traffic
  bypass the configured proxy is a finding.
- `src/browser/ssrf-policy-helpers.ts` — shared helpers for IP / hostname
  classification.
- `src/browser/url-pattern.ts` — pattern matching (allowlist / denylist
  patterns). Watch for regex injection or pattern-escape gaps.
- The integration test `src/browser/chrome.loopback-ssrf.integration.test.ts`
  — the assertion layer for the actual loopback property.
- The unit test `src/browser/pw-tools-core.browser-ssrf-guard.test.ts`.

Findings to look for:

- **High** — any code path that issues a navigation, a `Network.fetch`,
  a `Page.captureScreenshot` of a remote URL, or a CDP request to an
  attacker-controlled hostname that resolves to loopback / RFC1918 /
  link-local / `169.254.169.254` without a SSRF policy check first.
- **High** — DNS rebinding: a check that compares the hostname to a
  denylist BEFORE resolution, then resolves via Chromium's resolver and
  hits a private IP without re-checking.
- **High** — `file://` reachable from a normal navigation without an
  explicit per-profile enable.
- **Medium** — `cdp-proxy-bypass.ts` allowing bypass of the configured
  proxy for hostnames that resemble cloud-metadata endpoints.
- **Medium** — pattern-matching helpers in `url-pattern.ts` that decode
  URL-encoded chars inconsistently between the allowlist check and the
  actual fetch.
- **Low** — log lines that leak the resolved IP of denied targets at INFO
  (useful for an attacker doing reconnaissance).

If the SSRF policy is OPT-IN (off by default), call that out as a
`high`-severity finding — our threat model assumes it's on.

## Implementation backing

`plugins.entries.browser`. SSRF surface lives at
`extensions/browser/src/browser/request-policy.ts` +
`cdp-reachability-policy.ts` + `navigation-guard.ts` +
`cdp-proxy-bypass.ts` + `ssrf-policy-helpers.ts` + `url-pattern.ts`,
with `chrome.loopback-ssrf.integration.test.ts` +
`pw-tools-core.browser-ssrf-guard.test.ts` as assertions. Deep-walk
these specifically. Emit a verdict on the SSRF/outbound surface only.
