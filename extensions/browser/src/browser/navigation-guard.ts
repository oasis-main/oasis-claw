import { isIP } from "node:net";
import {
  isPrivateNetworkAllowedByPolicy,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
import { matchesHostnameAllowlist, normalizeHostname } from "../sdk-security-runtime.js";

const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);

function isAllowedNonNetworkNavigationUrl(parsed: URL): boolean {
  // Keep non-network navigation explicit; about:blank is the only allowed bootstrap URL.
  return SAFE_NON_NETWORK_URLS.has(parsed.href);
}

function normalizeNavigationUrl(url: string): string {
  return url.trim();
}

export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserNavigationUrlError";
  }
}

export type BrowserNavigationPolicyOptions = {
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationProxyMode;
};

export type BrowserNavigationProxyMode = "direct" | "explicit-browser-proxy";

export type BrowserNavigationRequestLike = {
  url(): string;
  redirectedFrom(): BrowserNavigationRequestLike | null;
};

export function withBrowserNavigationPolicy(
  ssrfPolicy?: SsrFPolicy,
  opts?: { browserProxyMode?: BrowserNavigationProxyMode },
): BrowserNavigationPolicyOptions {
  return {
    ...(ssrfPolicy ? { ssrfPolicy } : {}),
    ...(opts?.browserProxyMode && opts.browserProxyMode !== "direct"
      ? { browserProxyMode: opts.browserProxyMode }
      : {}),
  };
}

export function requiresInspectableBrowserNavigationRedirects(ssrfPolicy?: SsrFPolicy): boolean {
  return ssrfPolicy?.dangerouslyAllowPrivateNetwork === false;
}

export function requiresInspectableBrowserNavigationRedirectsForUrl(
  url: string,
  ssrfPolicy?: SsrFPolicy,
): boolean {
  if (!requiresInspectableBrowserNavigationRedirects(ssrfPolicy)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function isIpLiteralHostname(hostname: string): boolean {
  return isIP(normalizeHostname(hostname)) !== 0;
}

function isExplicitlyAllowedBrowserHostname(hostname: string, ssrfPolicy?: SsrFPolicy): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  const exactMatches = ssrfPolicy?.allowedHostnames ?? [];
  if (exactMatches.some((value) => normalizeHostname(value) === normalizedHostname)) {
    return true;
  }
  const hostnameAllowlist = (ssrfPolicy?.hostnameAllowlist ?? [])
    .map((pattern) => normalizeHostname(pattern))
    .filter(Boolean);
  return hostnameAllowlist.length > 0
    ? matchesHostnameAllowlist(normalizedHostname, hostnameAllowlist)
    : false;
}

export async function assertBrowserNavigationAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = normalizeNavigationUrl(opts.url);
  if (!rawUrl) {
    throw new InvalidBrowserNavigationUrlError("url is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${rawUrl}`);
  }

  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    if (isAllowedNonNetworkNavigationUrl(parsed)) {
      return;
    }
    throw new InvalidBrowserNavigationUrlError(
      `Navigation blocked: unsupported protocol "${parsed.protocol}"`,
    );
  }

  // Browser proxy routing hides the final connect target from this process.
  // Only block when the browser profile is known to be proxy-routed; Gateway
  // provider proxy env alone is not proof of browser page proxy behavior.
  if (
    opts.browserProxyMode === "explicit-browser-proxy" &&
    !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)
  ) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: strict browser SSRF policy cannot be enforced while this browser profile is proxy-routed",
    );
  }

  // Browser navigations happen in Chromium's network stack, not Node's. In
  // strict mode, a hostname-based URL would be resolved twice by different
  // resolvers, so Node-side pinning cannot guarantee the browser connects to
  // the same address that passed policy checks.
  if (
    opts.ssrfPolicy &&
    opts.ssrfPolicy.dangerouslyAllowPrivateNetwork === false &&
    !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy) &&
    !isIpLiteralHostname(parsed.hostname) &&
    !isExplicitlyAllowedBrowserHostname(parsed.hostname, opts.ssrfPolicy)
  ) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: strict browser SSRF policy requires an IP-literal URL because browser DNS rebinding protections are unavailable for hostname-based navigation",
    );
  }

  // A proxy-routed browser resolves the hostname in the PROXY, not here, so a
  // Node-side lookup cannot constrain what Chromium actually connects to — the
  // comment directly above already says exactly that about strict mode. On a
  // sandboxed bot the lookup is not merely uninformative, it is impossible:
  // the network is `internal: true`, the only route out is the egress proxy,
  // and Docker's embedded resolver answers for peer service names only. Every
  // navigation therefore died here with "getaddrinfo EAI_AGAIN", on every
  // host, including allowlisted ones. Measured 2026-09-04 on ButterBolt:
  //   node dns.lookup www.ebay.com -> EAI_AGAIN   (sandboxed)
  //   node dns.lookup www.ebay.com -> 23.48.203.137 (unsandboxed Nimbus)
  // while Chromium itself, given --proxy-server, fetched the real page fine.
  //
  // Skipping the lookup here does NOT remove enforcement, it defers it to the
  // component that can actually see the connection: the egress proxy, which
  // allowlists by hostname at CONNECT and refuses anything unlisted (verified
  // 2026-09-03 — an unlisted host gets HTTP 503, a listed one passes). This is
  // the same trade openclaw already makes for web_fetch via
  // tools.web.fetch.useTrustedEnvProxy: stop resolving locally, let the proxy
  // resolve and gate.
  //
  // Deliberately NOT unconditional. Reaching this line in proxy mode requires
  // the operator to have set browser.ssrfPolicy.dangerouslyAllowPrivateNetwork
  // explicitly, because the guard above still throws otherwise. So both must
  // hold: the profile is proxy-routed AND the operator opted in. A bot with no
  // proxy keeps the full Node-side pinned resolution unchanged.
  // The policy test is not redundant with the proxy test. browserProxyMode is
  // threaded from the caller, and NOT every call site threads it: e.g.
  // pw-tools-core.interactions.ts's assertSubframeNavigationAllowed calls
  // withBrowserNavigationPolicy(ssrfPolicy) with no second argument, so the
  // mode arrives undefined there. Measured on ButterBolt 2026-09-05 — with the
  // proxy test alone, `navigate` got through but `snapshot` still died on
  // "getaddrinfo EAI_AGAIN www.ebay.com" via that subframe path. Threading the
  // mode through would touch ssrfPolicy's ~17 exported entry points in that one
  // file; this condition covers every path at the single point that matters.
  //
  // It is also true on its own terms. Read resolvePinnedHostnameWithPolicy: it
  // resolves, then runs assertAllowedResolvedAddressesOrThrow only when
  // private addresses are NOT permitted, and the trusted-hostname assert only
  // when isPrivateNetworkAllowedByPolicy is false. So once the operator has
  // allowed private networks the address checks are already permissive, and
  // the resolution's ONLY remaining effect is to throw on a name this process
  // cannot resolve. The protocol check and the hostname allowlist checks above
  // still run and can still reject.
  //
  // A bot that has NOT set dangerouslyAllowPrivateNetwork keeps the full
  // Node-side pinned resolution, unchanged. That is every unsandboxed bot.
  if (
    opts.browserProxyMode === "explicit-browser-proxy" ||
    isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)
  ) {
    return;
  }

  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    lookupFn: opts.lookupFn,
    policy: opts.ssrfPolicy,
  });
}

/**
 * Best-effort post-navigation guard for final page URLs.
 * Only validates network URLs (http/https) and about:blank to avoid false
 * positives on browser-internal error pages (e.g. chrome-error://). In strict
 * mode this intentionally re-applies the hostname gate after redirects.
 */
export async function assertBrowserNavigationResultAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = normalizeNavigationUrl(opts.url);
  if (!rawUrl) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (
    NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) ||
    isAllowedNonNetworkNavigationUrl(parsed)
  ) {
    await assertBrowserNavigationAllowed(opts);
  }
}

export async function assertBrowserNavigationRedirectChainAllowed(
  opts: {
    request?: BrowserNavigationRequestLike | null;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const chain: string[] = [];
  let current = opts.request ?? null;
  while (current) {
    chain.push(current.url());
    current = current.redirectedFrom();
  }
  for (const url of chain.toReversed()) {
    await assertBrowserNavigationAllowed({
      url,
      lookupFn: opts.lookupFn,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
    });
  }
}
