# sandbox-skill-audit

Quarantined skills downloaded from the public clawhub-adjacent registry for
**static audit only**. Nothing in this directory is executed, installed, or
loaded by the gateway.

- Files are downloaded as raw text via `gh api`, never via `clawhub install`.
- Script files are stored as plain bytes; permissions are not honoured.
- Sources and provenance are recorded in `MANIFEST.json` per skill.
- Audit verdicts live in `~/.openclaw/logs/skill-audits/...` after `pnpm audit-sandbox` runs.

If you find yourself running anything in this directory, stop.
