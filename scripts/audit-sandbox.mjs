/**
 * Bootstrap entry for the sandbox auditor.
 *
 * Registers the .js→.ts resolver hook BEFORE importing audit-sandbox.ts so
 * the hook is in effect for the script's own dependency graph (which reaches
 * into extensions/clawhub-skill-audit/src/ and follows .js-suffixed imports).
 *
 * Run with:
 *   node --experimental-strip-types scripts/audit-sandbox.mjs [--live] [--inspect]
 */
import { register } from "node:module";

register("./ts-resolver-hook.mjs", import.meta.url);

await import("./audit-sandbox.ts");
