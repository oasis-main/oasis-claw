# Third-party notices

The MIT license in `LICENSE` covers the code that oasis-claw itself authors.

Some directories in this repository hold code from other projects. Those
directories keep their own license. This file records which directories those
are, and what license each one carries.

## Vendored third-party code

| Path | Source | License | Notes |
|---|---|---|---|
| `vendor/openclaw/` | openclaw/openclaw | MIT — Copyright (c) 2026 OpenClaw Foundation | Git submodule. Pinned by `.gitmodules`. Carries its own `LICENSE`. |
| `vendor/openclaw-source/` | openclaw/openclaw | MIT — Copyright (c) 2026 OpenClaw Foundation | Reference source tree. Carries its own `LICENSE`. |
| `extensions/browser/` | openclaw/openclaw | MIT — Copyright (c) 2026 OpenClaw Foundation | Vendored, not a submodule. 304 tracked files. The exact upstream revision is recorded in `extensions/browser/UPSTREAM`, and `scripts/refresh-browser-plugin.sh` (CLAW-016) keeps it byte-identical to upstream. |

MIT requires that the copyright notice travels with the code. Each path above
either carries its own `LICENSE` file or is covered by this notice. Do not
remove those files.

## First-party code with no license file of its own

These directories hold oasis-main's own code. They currently carry no `LICENSE`
file. Give each one the same MIT license as this repository, or record a
different decision here.

| Path | Status |
|---|---|
| `vendor/oasis-voice/` | Git submodule. Separate repository. No `LICENSE` file found 2026-08-12. |
| `vendor/oasis-semantics/` | No `LICENSE` file found 2026-08-12. |
| `vendor/sandbox-skill-audit/` | No `LICENSE` file found 2026-08-12. |

Tracked under CLAW-088. See `.swarm/CLAW-088_PROTOCOL_DISTRIBUTION.md` §2.1.

## Runtime dependencies

Dependencies installed from npm are not vendored into this repository. Each one
keeps its own license, recorded in its own package metadata.
