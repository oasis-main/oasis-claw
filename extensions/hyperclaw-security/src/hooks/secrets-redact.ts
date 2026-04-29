/**
 * Secrets redaction hook — tool_result_persist belt-and-suspenders.
 *
 * Fires on the tool_result_persist plugin hook, which runs before a tool result
 * is written into the conversation history. Scans the result for any known
 * plaintext secret values and replaces them with [REDACTED].
 *
 * This is the last line of defense: deposit_secret never returns secrets to the model,
 * but if any other code path accidentally leaks a value this hook catches it.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { SecretsStore } from "../secrets-store.js";

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

export function registerSecretsRedact(
  api: OpenClawPluginApi,
  opts: { secretsStore: SecretsStore },
): void {
  const { secretsStore } = opts;

  api.on("tool_result_persist", (ctx) => {
    // Only act if there are secrets to redact
    const knownSecrets = collectKnownSecrets(secretsStore);
    if (knownSecrets.length === 0) return;

    // Redact from string content blocks
    if (Array.isArray(ctx.content)) {
      for (const block of ctx.content as Array<{ type?: string; text?: string }>) {
        if (block.type === "text" && typeof block.text === "string") {
          const redacted = redactSecrets(block.text, knownSecrets);
          if (redacted !== block.text) {
            block.text = redacted;
            api.logger.warn("hyperclaw-security: redacted secret from tool result before persist", {
              toolName: ctx.toolName,
              toolCallId: ctx.toolCallId,
            });
          }
        }
      }
    }
  });
}
