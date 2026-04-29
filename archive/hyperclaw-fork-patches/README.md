# Hyperclaw fork patches

These 7 patches are the entirety of the substantive divergence between the deprecated `MikeHLee/hyperclaw` fork (`hyperclaw-security` branch) and its base in upstream `openclaw/openclaw`.

They are preserved here as historical reference. The plugin code itself lives at [`extensions/hyperclaw-security/`](../../extensions/hyperclaw-security/) — these patches are not the source of truth and should not be applied.

| # | Commit | Subject |
|---|---|---|
| 1 | a07ba95 | chore: add CLAUDE.md with hyperclaw architecture |
| 2 | eadea71 | feat: add hyperclaw-security plugin and browser URL approval gate |
| 3 | 3990929 | feat: add security-hardened Docker config and handoff documentation |
| 4 | b9d330c | test: add unit tests for hyperclaw-security plugin and adversarial prompt injection suite |
| 5 | 714ea47 | fix: correct test expectations for secrets-store and sandbox-isolation |
| 6 | 32e87ea | feat: add hyperclaw security configuration and CAPTCHA forwarding |
| 7 | 65a324b | feat: add API approval gate and service integrations config |

Exported 2026-04-29 with `git format-patch -7 hyperclaw-security`.
