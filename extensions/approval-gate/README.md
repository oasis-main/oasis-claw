# approval-gate

Human-in-the-loop approval surface for openclaw. Three concerns, two of which depend on hooks that are inherited from the openclaw submodule rather than reimplemented here.

## What this plugin actually wires

### `forward_captcha` agent tool

The model invokes this when it encounters a CAPTCHA in a browser session. The plugin sends the image to your operator Telegram chat as a photo and returns the operator's typed solution as the tool's output.

Configuration:

```json
{
  "plugins": {
    "entries": {
      "approval-gate": {
        "telegramBotToken": "...",
        "telegramChatId": "..."
      }
    }
  }
}
```

If `telegramBotToken` and `telegramChatId` are not both set, the tool is not registered (the plugin logs a warning at startup).

## What this plugin re-exports as library code

### `api-approval-gate.ts`

Utility functions for HTTP request approval policy:

- `loadApiApprovalPolicy(file)` — reads `~/.openclaw/api-approvals.json`
- `checkApiApproval(req, policy)` — returns `allow` / `deny` / `request_approval`
- `requestApiApproval(req, telegramCfg)` — sends an approval prompt to the operator
- `handlePotentialApiApprovalResponse(text)` — parses operator replies

These need to be invoked from openclaw's HTTP middleware layer to actually enforce policy on outbound agent requests. **That integration point does not exist in vanilla upstream openclaw.** Until it does, the functions are available for callers that wire them themselves.

Tracked under oasis-x ORG-049 follow-up work.

## Browser navigation approvals — handled upstream

This plugin used to ship a `browser-approvals.ts` documentation file. It has been removed because:

1. Upstream's `src/infra/approval-handler-*` provides the approval infrastructure that browser navigation uses. No plugin code is needed.
2. The previous test file imported `src/infra/browser-approvals.js` which upstream has refactored away.

To enable Telegram approval forwarding for browser navigation, configure upstream's existing `approvals.exec` infrastructure in `~/.openclaw/openclaw.json`:

```json
{
  "approvals": {
    "exec": {
      "enabled": true,
      "mode": "targets",
      "targets": [
        {
          "channel": "telegram",
          "to": "<your_telegram_chat_id>"
        }
      ]
    }
  }
}
```

And set the exec approval policy in `~/.openclaw/exec-approvals.json`:

```json
{
  "version": 1,
  "defaults": {
    "security": "allowlist",
    "ask": "always"
  }
}
```

The URL allowlist lives at `~/.openclaw/browser-approvals.json` (a runtime state file owned by upstream openclaw, not this plugin):

```json
{
  "version": 1,
  "entries": [
    { "pattern": "github.com" },
    { "pattern": "*.google.com" },
    { "pattern": "https://api.openai.com/v1" }
  ]
}
```

When the agent attempts a non-allowlisted browser navigation, the upstream exec-approval flow sends a Telegram message; your reply approves or denies the action.

## Adjacent upstream features

- **`src/security/external-content.ts`** carries `SUSPICIOUS_PATTERNS` regex detection that auto-flags potential prompt injection in inbound external content (emails, web pages). Complementary to `prompt-injection-reporting` (voluntary agent self-report); both can run simultaneously.
- **`src/infra/approval-handler-*`** is the generic exec-approval handler that browser navigation uses. Configure it via `approvals.exec` as shown above.
