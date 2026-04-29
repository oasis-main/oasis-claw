/**
 * Browser approval forwarding configuration guide.
 *
 * The browser-tool.ts core patch reuses openclaw's existing exec approval
 * infrastructure (exec.approval.request). Browser navigation requests appear
 * in your Telegram/Discord as:
 *
 *   🔒 Exec approval required
 *   Command: browser:navigate:https://example.com
 *   Host: browser
 *
 * To enable Telegram approval forwarding for browser navigation, add this to
 * ~/.openclaw/openclaw.json:
 *
 *   {
 *     "approvals": {
 *       "exec": {
 *         "enabled": true,
 *         "mode": "targets",
 *         "targets": [
 *           {
 *             "channel": "telegram",
 *             "to": "<your_telegram_chat_id>"
 *           }
 *         ]
 *       }
 *     }
 *   }
 *
 * And set exec approval policy to require approval for all commands:
 *   ~/.openclaw/exec-approvals.json:
 *   {
 *     "version": 1,
 *     "defaults": {
 *       "security": "allowlist",
 *       "ask": "always"
 *     }
 *   }
 *
 * The URL allowlist lives at ~/.openclaw/browser-approvals.json.
 * When you click "Always allow" in the Telegram approval, the URL's hostname is
 * automatically added to browser-approvals.json and future navigations to that
 * host won't require approval.
 *
 * CLI to view/manage the browser allowlist:
 *   cat ~/.openclaw/browser-approvals.json
 *
 * To pre-approve hosts:
 *   Edit ~/.openclaw/browser-approvals.json and add entries:
 *   {
 *     "version": 1,
 *     "entries": [
 *       { "pattern": "github.com" },
 *       { "pattern": "*.google.com" },
 *       { "pattern": "https://api.openai.com/v1" }
 *     ]
 *   }
 */

// This module is intentionally documentation-only.
// The approval gate logic lives in src/infra/browser-approvals.ts (core)
// and src/agents/tools/browser-tool.ts (core patch).
export {};
