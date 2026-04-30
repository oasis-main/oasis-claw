/**
 * deposit_secret agent tool — inject a named secret into a browser form field.
 *
 * Security properties:
 *   1. The model NEVER receives the plaintext secret value at any point.
 *   2. If the target host is not on the browser allowlist, a Telegram screenshot
 *      is sent to the human owner who must approve before injection proceeds.
 *   3. The tool result returned to the model is always redacted:
 *      "Secret deposited. Value not returned to agent."
 *   4. The tool_result_persist hook (secrets-redact.ts) provides belt-and-suspenders
 *      redaction before the result is written to conversation history.
 *
 * Usage:
 *   deposit_secret({
 *     secret_name: "github_token",
 *     selector: "input[name=password]",  // CSS selector for the form field
 *     host_hint: "github.com"            // for allowlist check and approval UI
 *   })
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SecretsStore } from "../secrets-store.js";

// ---------------------------------------------------------------------------
// Inlined browser-approvals helpers
// Previously imported from `openclaw/src/infra/browser-approvals.js`, which
// was removed in upstream v2026.4. We inline the ~30 LOC we actually use.
// ---------------------------------------------------------------------------

type BrowserApprovalEntry = { pattern: string; type?: "prefix" | "exact" | "glob" };
type BrowserApprovals = { entries?: BrowserApprovalEntry[] };

function loadBrowserApprovals(): BrowserApprovals {
  const configPath = path.join(os.homedir(), ".openclaw", "browser-approvals.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON.parse(raw) as BrowserApprovals;
  } catch {
    return { entries: [] };
  }
}

function checkUrlAllowlist(url: string, entries: BrowserApprovalEntry[]): boolean {
  if (!entries.length) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return entries.some(({ pattern, type }) => {
    if (type === "exact") return hostname === pattern;
    // default: prefix match on hostname segments
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}
import { sendTelegramMessage } from "../telegram.js";

export type DepositSecretTool = {
  label: string;
  name: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
};

const REDACTED_RESULT = "Secret deposited successfully. Value not returned to agent.";
const DENIED_RESULT = (reason: string) =>
  `Secret deposit denied: ${reason}. The field was not filled.`;

export function createDepositSecretTool(opts: {
  secretsStore: SecretsStore;
  telegram: { botToken?: string; chatId?: string };
}): DepositSecretTool {
  const { secretsStore, telegram } = opts;

  return {
    label: "Deposit Secret",
    name: "deposit_secret",
    description: [
      "Inject a stored secret (password, token, API key) into a browser form field.",
      "The secret value is NEVER returned to you — it is read from the encrypted vault",
      "and injected directly into the browser field specified by the CSS selector.",
      "If the target host is not pre-approved, a human must approve via Telegram before injection.",
      "Available secrets can be retrieved with list_secrets.",
    ].join(" "),
    parameters: {
      type: "object",
      required: ["secret_name", "selector"],
      properties: {
        secret_name: {
          type: "string",
          description: "Name of the secret in the vault (as stored by the user)",
        },
        selector: {
          type: "string",
          description: "CSS selector for the form field to fill (e.g. input[name=password])",
        },
        host_hint: {
          type: "string",
          description:
            "Hostname of the current page (e.g. github.com) — used for allowlist check and approval UI",
        },
        tab_id: {
          type: "string",
          description: "Optional browser tab ID to target (from browser snapshot)",
        },
      },
    },

    async execute(_toolCallId, args) {
      const a = args as {
        secret_name?: string;
        selector?: string;
        host_hint?: string;
        tab_id?: string;
      };

      const secretName = a.secret_name?.trim();
      const selector = a.selector?.trim();
      const hostHint = a.host_hint?.trim() ?? "";

      if (!secretName || !selector) {
        return {
          content: [
            { type: "text" as const, text: DENIED_RESULT("secret_name and selector are required") },
          ],
        };
      }

      // Check secret exists before doing anything else
      if (!secretsStore.has(secretName)) {
        return {
          content: [
            {
              type: "text" as const,
              text: DENIED_RESULT(`secret "${secretName}" not found in vault. Ask the user to add it first.`),
            },
          ],
        };
      }

      // Check host allowlist
      const browserApprovals = loadBrowserApprovals();
      const fakeUrl = hostHint.startsWith("http") ? hostHint : `https://${hostHint}`;
      const hostAllowed = hostHint ? checkUrlAllowlist(fakeUrl, browserApprovals.entries ?? []) : false;

      if (!hostAllowed) {
        // Require human approval via Telegram
        if (!telegram.botToken || !telegram.chatId) {
          return {
            content: [
              {
                type: "text" as const,
                text: DENIED_RESULT(
                  `host "${hostHint}" is not on the allowlist and no Telegram config is set for approval. ` +
                    "Add the host to ~/.openclaw/browser-approvals.json to pre-approve it.",
                ),
              },
            ],
          };
        }

        const approvalText = [
          `🔑 *Secret deposit request*`,
          ``,
          `The agent wants to fill a form field with a stored secret.`,
          ``,
          `*Secret:* \`${secretName}\``,
          `*Selector:* \`${selector}\``,
          `*Host:* \`${hostHint || "unknown"}\``,
          ``,
          `Reply \`/hc-approve-secret ${secretName} ${selector}\` to allow,`,
          `or \`/hc-deny-secret\` to deny.`,
          ``,
          `_Take a screenshot first if you want to verify the current page._`,
        ].join("\n");

        // Send notification (non-blocking) — human must reply via chat command
        sendTelegramMessage({
          botToken: telegram.botToken,
          chatId: telegram.chatId,
          text: approvalText,
          parseMode: "Markdown",
        }).catch(() => {});

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Secret deposit for "${secretName}" on host "${hostHint}" requires human approval.`,
                `A Telegram notification has been sent. Once the human approves, call deposit_secret again.`,
                `Do NOT retry automatically — wait for explicit user confirmation.`,
              ].join(" "),
            },
          ],
        };
      }

      // Host is approved — retrieve secret and inject via browser tool
      const plaintext = secretsStore.get(secretName);
      if (!plaintext) {
        return {
          content: [
            { type: "text" as const, text: DENIED_RESULT("failed to decrypt secret (vault key may have changed)") },
          ],
        };
      }

      // Inject via Playwright act — type into the selector
      // We call the browser tool's HTTP endpoint directly to avoid the secret
      // ever appearing in the agent's tool call history as a parameter.
      try {
        const browserBaseUrl = process.env.OPENCLAW_BROWSER_BASE_URL ?? "http://127.0.0.1:7667";
        const body = JSON.stringify({
          actions: [{ name: "fill", selector, value: plaintext }],
          targetId: a.tab_id,
        });
        const res = await fetch(`${browserBaseUrl}/act`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "(no body)");
          return {
            content: [{ type: "text" as const, text: DENIED_RESULT(`browser injection failed: ${errText.slice(0, 200)}`) }],
          };
        }
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: DENIED_RESULT(`browser injection error: ${String(err).slice(0, 200)}`) },
          ],
        };
      } finally {
        // Ensure plaintext is overwritten in memory (best-effort in JS)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (plaintext as any) = null;
      }

      return {
        content: [{ type: "text" as const, text: REDACTED_RESULT }],
      };
    },
  };
}
