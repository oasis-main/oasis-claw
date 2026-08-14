/**
 * Secrets redaction hook — tool_result_persist belt-and-suspenders.
 *
 * Fires on the tool_result_persist plugin hook, which runs before a tool result
 * is written into the conversation history. installSessionToolResultGuard (see
 * vendor/openclaw/src/agents/session-tool-result-guard-wrapper.ts) uses this
 * SAME transformed message as the session transcript, and the session
 * transcript is what gets sent back to the model on its next inference call —
 * there is no separate channel where the model sees raw tool output. So a
 * redaction here doesn't just protect future turns' history; it prevents the
 * model from ever seeing the raw value at all, for THIS turn too, regardless
 * of which tool or command produced it.
 *
 * Two independent checks run here:
 *   1. redactSecrets() — exact-match against secrets explicitly registered via
 *      deposit_secret. Requires the value to already be known to the vault.
 *   2. redactSecretPatterns() — CLAW-097: shape-based detection (AWS key IDs,
 *      PEM private key headers, GitHub/Slack tokens, and a broad *_key/*_token/
 *      *_secret literal-assignment rule) that needs no prior registration.
 *      This is what actually closes the gap a pre-execution, command-string
 *      path parser cannot: `python3 -c "print(open(p).read())"` returns the
 *      same secret text as `cat p` — the reviewer's exec-time checks cannot
 *      reliably tell those apart, but this hook sees identical output either
 *      way, since it runs on the tool's RESULT, not on the command that
 *      produced it. Mirrors scripts/build-semantic-index.py's SECRET_PATTERNS
 *      (CLAW-096) — kept as a separate literal list rather than a shared data
 *      file, because Python's `re` and JS's RegExp diverge on inline-flag
 *      syntax ((?i) vs trailing /i) and forcing one format across both
 *      languages costs more than it saves for five patterns. Keep the two
 *      lists in sync by hand.
 *
 * This is defense in depth, not a complete guarantee — see the module
 * comment's own bypass discussion in CLAW-097's design notes for what this
 * does not close (e.g. a secret split across multiple tool results, or
 * encoded/obfuscated before being printed).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { SecretsStore } from "../secrets-store.js";
import { sendTelegramMessage } from "../telegram.js";

const REDACTION_PLACEHOLDER = "[REDACTED BY HYPERCLAW-SECURITY]";

function redactSecrets(text: string, knownSecrets: string[]): string {
  let result = text;
  for (const secret of knownSecrets) {
    if (!secret || secret.length < 4) continue; // Don't redact trivially short values
    // Escape for use in regex
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), REDACTION_PLACEHOLDER);
  }
  return result;
}

function collectKnownSecrets(secretsStore: SecretsStore): string[] {
  const names = secretsStore.list();
  const secrets: string[] = [];
  for (const name of names) {
    const value = secretsStore.get(name);
    if (value) secrets.push(value);
  }
  return secrets;
}

type SecretPatternRule = { name: string; pattern: RegExp };

const SECRET_PATTERN_RULES: SecretPatternRule[] = [
  { name: "aws_access_key_id", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: "private_key_block",
    pattern: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Broad, deliberately over-inclusive: an identifier ENDING in one of these
  // suffixes, assigned a quoted literal of 12+ chars. Catches tradier_token,
  // gemini_api_key, kalshi_key_id, bedrock_aws_secret_access_key, etc. A
  // false positive (a non-secret value that happens to end in _key) fails
  // safe here — over-redaction costs the model some context, not exposure.
  {
    name: "generic_secret_assignment",
    pattern:
      /\b[A-Za-z_][A-Za-z0-9_]*(_key|_token|_secret|key_id|_password|_passwd|_credential)\s*[:=]\s*["'][^"'\s]{12,}["']/gi,
  },
];

/** Returns the redacted text plus which rule names fired — never the matched
 * values themselves, so a caller can log/alert on *why* without the log line
 * itself becoming a second place the secret is now sitting in plaintext. */
function redactSecretPatterns(text: string): { text: string; matchedRules: string[] } {
  let result = text;
  const matchedRules: string[] = [];
  for (const rule of SECRET_PATTERN_RULES) {
    const before = result;
    result = result.replace(rule.pattern, REDACTION_PLACEHOLDER);
    if (result !== before) matchedRules.push(rule.name);
  }
  return { text: result, matchedRules };
}

export function registerSecretsRedact(
  api: OpenClawPluginApi,
  opts: { secretsStore: SecretsStore; telegram?: { botToken?: string; chatId?: string } },
): void {
  const { secretsStore } = opts;

  // NOTE (CLAW-097): api.on's real, type-checked handler shape is
  // `(event, ctx) => ...` — TWO separate parameters (event carries
  // `.message`; content lives at `event.message.content`, never at a
  // top-level `.content`). The version of this function that shipped before
  // this fix declared a single parameter named `ctx` and read `.content`
  // directly off it. JS binds that single parameter to the FIRST positional
  // argument (`event`), which has no `.content` field at all — only
  // `event.message.content` does. `Array.isArray(undefined)` is always
  // `false`, so this hook's entire redaction body has never once executed on
  // any bot since it was written; it looked like protection and did nothing.
  // Confirmed against the real hook-runner call site
  // (vendor/openclaw/src/plugins/hooks.ts:604, `handler(event, ctx)`, no
  // flattening) and the real message shape
  // (vendor/openclaw/packages/llm-core/src/types.ts:321, ToolResultMessage
  // has `content` directly on it, not on some further-nested field).
  api.on("tool_result_persist", (event) => {
    const message = event.message;
    if (message.role !== "toolResult" || !Array.isArray(message.content)) return;

    // Registered secrets are looked up once per call, not gated behind a
    // "skip everything if none registered" early-return — that early-return
    // used to also skip the pattern check below, which needs no registration
    // at all to fire.
    const knownSecrets = collectKnownSecrets(secretsStore);
    let anyChanged = false;

    for (const block of message.content) {
      if (block.type !== "text" || typeof block.text !== "string") continue;

      let text = block.text;
      let changed = false;
      const firedRules: string[] = [];

      if (knownSecrets.length > 0) {
        const redacted = redactSecrets(text, knownSecrets);
        if (redacted !== text) {
          text = redacted;
          changed = true;
          firedRules.push("registered-secret");
        }
      }

      const { text: patternRedacted, matchedRules } = redactSecretPatterns(text);
      if (matchedRules.length > 0) {
        text = patternRedacted;
        changed = true;
        firedRules.push(...matchedRules);
      }

      if (!changed) continue;

      block.text = text;
      anyChanged = true;
      api.logger.warn("hyperclaw-security: redacted secret from tool result before persist", {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        rules: firedRules,
      });

      // Fire-and-forget: tool_result_persist is synchronous-only (the plugin
      // runtime discards and warns on a handler that returns a Promise), so
      // the alert cannot be awaited here. The redaction above has already
      // happened synchronously by this point either way.
      if (opts.telegram?.botToken && opts.telegram?.chatId) {
        sendTelegramMessage({
          botToken: opts.telegram.botToken,
          chatId: opts.telegram.chatId,
          text:
            `Secret-shaped content redacted before it reached the model.\n` +
            `Tool: ${event.toolName ?? "unknown"}\n` +
            `Rule(s): ${firedRules.join(", ")}`,
        }).catch((err) => {
          api.logger.warn("hyperclaw-security: telegram alert failed", { error: String(err) });
        });
      }
    }

    // Explicit {message} return per this hook's documented contract: "each
    // handler may return {message} to replace the message passed to the next
    // handler." Returned unconditionally (not only when anyChanged) so this
    // handler's behavior does not depend on whether block.text mutation
    // happens to already be visible in place to the caller.
    return anyChanged ? { message } : undefined;
  });
}
