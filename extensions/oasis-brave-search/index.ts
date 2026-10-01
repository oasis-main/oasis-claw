import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

/**
 * Register the Brave Search web_search provider.
 *
 * WHY THIS PLUGIN EXISTS. openclaw 2026.7.1-2 contains a COMPLETE Brave
 * provider — dist/brave-web-search-provider-<hash>.js, built from its own
 * extensions/brave/src/brave-web-search-provider.ts, with the full
 * WebSearchProviderPlugin surface (id "brave", envVars ["BRAVE_API_KEY"],
 * credential plumbing, ~25 fields). What it does NOT ship is a plugin that
 * calls registerWebSearchProvider on it: `openclaw plugins list` offers
 * `duckduckgo` and nothing else. So web_search could only ever run on
 * DuckDuckGo, and when DuckDuckGo began answering with a bot-detection
 * challenge (measured 2026-09-08: an anomaly page with ZERO results, on both
 * Nimbus and House, even with a browser User-Agent) the fleet lost web search
 * outright. This file is the missing registration and nothing else.
 *
 * WHY IT IMPORTS RATHER THAN REIMPLEMENTS. WebSearchProviderPlugin is a wide
 * interface. Hand-rolling it invites exactly the boot crash-loop the
 * oasis-find manifest comment warns about, and would duplicate a Brave API
 * client openclaw already maintains. Reusing the shipped factory keeps this
 * plugin to one line of real behaviour.
 *
 * THE FRAGILE PART, AND HOW IT IS CONTAINED. The factory lives behind a
 * CONTENT-HASHED filename that changes on every openclaw bump, and its export
 * is MINIFIED to a single letter (`export { createBraveWebSearchProvider as t }`),
 * so neither the path nor the export name can be hard-coded. This resolves the
 * file by glob and takes the module's sole function export. If a bump moves or
 * renames it, this plugin logs a warning and registers NOTHING — web_search
 * then falls back to whatever other provider is registered (duckduckgo stays
 * installed for exactly this reason). It must never throw: a plugin that
 * throws at import takes the whole fleet down at boot.
 *
 * register() is typed `(api: OpenClawPluginApi) => void` — synchronous — and
 * provider SELECTION happens at startup, so the factory has to be in hand
 * before register returns. See the note on nodeRequire below for the two
 * asynchronous shapes that were tried first and why both failed.
 */

const DIST = process.env.OASIS_OPENCLAW_DIST ?? "/usr/local/lib/node_modules/openclaw/dist";
const FACTORY_RE = /^brave-web-search-provider-[A-Za-z0-9_-]+\.js$/;

function findBraveFactoryModule(): string | null {
  try {
    const matches = fs.readdirSync(DIST).filter((f) => FACTORY_RE.test(f)).sort();
    // Sorted, last wins: deterministic if a bump ever leaves two hashes behind.
    return matches.length > 0 ? path.join(DIST, matches[matches.length - 1]!) : null;
  } catch {
    return null;
  }
}

type ProviderFactory = () => unknown;

/**
 * THE REGISTRATION MUST BE SYNCHRONOUS, AND `import()` CANNOT BE. Two earlier
 * shapes both failed on Kolmogorov, 2026-09-08, and the reasons are worth
 * keeping so nobody re-tries them:
 *
 *   1. Top-level `await import(...)`. Works under node's own TypeScript
 *      stripping — registered provider "brave" in a direct test — but inside
 *      the GATEWAY's plugin loader it produced no factory on every boot. That
 *      loader does not give a plugin module's top-level await node's
 *      semantics.
 *   2. Deferred: start the import in register(), register when it resolves.
 *      The plugin then logged "loaded" and the provider really did register —
 *      but too late. Provider SELECTION happens at startup, and the log shows
 *      `WEB_SEARCH_PROVIDER_INVALID_AUTODETECT ... No provider will be
 *      selected` firing microseconds BEFORE the registration. web_search still
 *      answered "disabled or no provider is available" at the point of use.
 *
 * So: `require()` of the ESM module. Node 22.12+ can require an ES module
 * synchronously as long as its graph contains no top-level await, and this one
 * qualifies — verified in-image: require returns `{ t }` and calling it yields
 * `{ id: "brave", label: "Brave Search" }`. Synchronous, so the provider exists
 * before selection runs.
 */
const nodeRequire = createRequire(import.meta.url);

const plugin = {
  id: "brave",
  name: "Brave Search",
  description: "Registers openclaw's own Brave Search web_search provider, which openclaw ships but never registers.",

  register(api: OpenClawPluginApi) {
    const modulePath = findBraveFactoryModule();
    if (!modulePath) {
      api.logger.warn(
        `oasis-brave-search: registering nothing — no file matching ${FACTORY_RE.source} under ${DIST}. ` +
          "web_search falls back to whatever other provider is registered (duckduckgo). " +
          "Most likely an openclaw bump moved or renamed the module — re-check the glob.",
      );
      return;
    }

    try {
      const mod = nodeRequire(modulePath) as Record<string, unknown>;
      // The export name is minified to a single letter, so select by shape.
      const fns = Object.values(mod).filter((v): v is ProviderFactory => typeof v === "function");
      if (fns.length !== 1) {
        api.logger.warn(
          `oasis-brave-search: registering nothing — expected exactly 1 function export in ` +
            `${modulePath}, found ${fns.length}. web_search falls back to duckduckgo.`,
        );
        return;
      }
      api.registerWebSearchProvider(fns[0]!() as never);
      api.logger.info("oasis-brave-search plugin loaded", {
        module: modulePath,
        providerId: "brave",
        credentialEnv: "BRAVE_API_KEY",
        keyPresent: Boolean(process.env.BRAVE_API_KEY),
      });
    } catch (err) {
      // Degrade, never take the boot down: a throwing plugin stops the fleet.
      api.logger.warn(
        `oasis-brave-search: registering nothing — ${err instanceof Error ? err.message : String(err)}. ` +
          "web_search falls back to duckduckgo.",
      );
    }
  },
};

export default plugin;
