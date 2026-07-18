# operating-system-sandbox

OS/compose-layer containment for the oasis-claw agent fleet. The security
guarantee lives in the **network + filesystem boundary**, not in the model's
willingness to resist prompt injection — so even a fully-compromised agent loop
is isolated. Full design + phasing: [`../.swarm/OPERATING_SYSTEM_SANDBOX_PLAN.md`](../.swarm/OPERATING_SYSTEM_SANDBOX_PLAN.md).
Tracked as **CLAW-023 … CLAW-041** (epic `EPIC-AGENTS`) in [`../.swarm/queue.md`](../.swarm/queue.md).

## What's here now — `egress-proxy/` (CLAW-033 prototype)

The **exfiltration-path closure**: a fail-closed forward proxy that is the sole
egress route out of an `internal: true` container network. The sandboxed runtime
has no direct route to the internet; it can only reach the outside through this
proxy, which relays TCP **only to allowlisted destination hostnames** and logs
every allow/deny as JSONL. This is the piece that makes prompt injection
survivable: `curl evil.com` from a compromised loop cannot leave the namespace.

This prototype is **version-independent** — it's pure network topology + a
stdlib Go binary, touching none of the openclaw SDK — so it can be built and
proven now, ahead of the Phase-0 pin bump (CLAW-023…030).

### Why an OS-layer proxy at all (vs. the app-layer `proxy.*`)

Upstream's in-process `proxy.*` (CLAW-031) covers Node HTTP made by the agent
itself (axios/got/fetch). It does **not** cover a `curl` spawned by the exec
tool, or a raw socket from any subprocess. The `internal: true` network + this
sidecar make the proxy the only *physical* path out of the namespace, so
shell-spawned egress is caught too. App-layer gates what the agent *tries*; the
network boundary catches what slips through. Injection has to beat both.

### Properties

- **Fail closed.** Empty allowlist ⇒ refuses to start. Unknown host ⇒ 403.
  Unparseable ClientHello (strict mode) ⇒ deny.
- **No TLS interception.** CONNECT tunnels stay opaque — the proxy never sees
  plaintext. Allowlisting is by CONNECT target host, plus an optional,
  **strictly-subtractive** TLS-SNI check (`SNI_ENFORCE=lenient|strict`) that can
  only *add* denials — it defeats domain fronting (CONNECT to an allowlisted CDN
  host, then front a different SNI inside) and can never widen access.
- **No third-party dependencies.** stdlib only; the audit surface of a
  security-boundary component is a single static binary on `scratch`.
- **Structured JSONL audit** to stdout for every decision, so denied-egress
  spikes become the injection tripwire surfaced in the portal (CLAW-041).

### Configuration (env)

| var | default | meaning |
|---|---|---|
| `LISTEN` | `:3128` | proxy listen address |
| `ALLOWLIST` | *(empty)* | comma/space/newline hosts; `.d.com` = suffix match |
| `ALLOWLIST_FILE` | `/etc/egress/allowlist.txt` | baked-in allowlist (merged with `ALLOWLIST`) |
| `SNI_ENFORCE` | `lenient` | `off` \| `lenient` \| `strict` |
| `LEARNED_ALLOWLIST_FILE` | *(empty)* | CLAW-034 global learned store (written only by `claw-vet`) |
| `LEARNED_RELOAD_SECONDS` | `5` | mtime-poll hot-reload cadence; `0` disables (static-only) |
| `CLIENT_MAP` / `CLIENT_MAP_FILE` | *(empty)* | CLAW-050 `ip=bot` pairs; empty ⇒ partitioning off (shared base for all) |
| `SEED_DIR` | *(empty)* | CLAW-050 per-bot static seeds at `SEED_DIR/<bot>/allowlist.txt` |
| `LEARNED_DIR` | *(empty)* | CLAW-050 per-bot learned at `LEARNED_DIR/<bot>/allowlist.txt` |
| `AUDIT_FILE` | *(empty)* | CLAW-034 second audit sink (JSONL) for the vetting service; stdout is unaffected |
| `AUDIT_MAX_BYTES` | `33554432` | rotate `AUDIT_FILE` → `.1` at this size (single generation) |

#### Per-bot egress partitioning (CLAW-050)

With `CLIENT_MAP` empty the proxy holds one global allowlist — every sandboxed
bot shares it. Set `CLIENT_MAP="10.x=vanhelsing,10.y=house"` (with each bot on a
**static** `ipv4_address`) and the proxy selects the effective allowlist by the
client **source IP** — an unprivileged container can't spoof it, whereas it
controls its own `HTTPS_PROXY` target, so IP is the only spoof-resistant identity.
Each bot then reaches `base ∪ its own seed ∪ its own learned namespace`, and
nothing a peer alone was granted. `claw-vet --bot <x>` and `sandbox-unsafe --bot
<x>` write only into `<x>`'s namespace. This makes each bot's Layer-4 blast
radius its own — the enforcement half of the fleet blast-radius realignment.

## The vetting service (`vetter/`, CLAW-034)

The proxy is fail-closed, so a bot that needs a new host is *stuck* until someone
allows it. `claw-vet watch` is what stops that from meaning "stuck until Mike
notices": it tails the proxy's deny stream and turns vettable denials into
decisions with nobody in the loop.

Every candidate passes three independent checks, and all three must clear:

1. **Role-policy gate** (deterministic, no model call) — is this host *in role*
   for *this bot*? Provider hosts are refused fleet-wide (model calls belong on
   the oasis-generation gateway), `posture: locked` bots never learn anything,
   per-bot `origins.exclude` is honored, and an unreadable `role.yaml` fails
   closed. This exists because "safe to reach" and "in role" are different
   questions: `generativelanguage.googleapis.com` is impeccably safe and
   completely out of role, and a classifier judging it on security signals alone
   will PASS it every time.
2. **Safety classifier** — is reaching this host safe (not C2, phishing, exfil
   sink, throwaway attack domain)? Judged on DNS/TLS/WHOIS/HTTP metadata that is
   treated as hostile input throughout.
3. **Honeypot meta-eval** — a fresh-context second pass asking whether that
   evidence was trying to manipulate the classifier. A PASS whose evidence tripped
   the honeypot is blocked; reaching such a host is precisely the risk.

### Why it runs as a container

It was going to be a launchd agent. macOS **TCC blocks launchd agents from
reading `~/Documents`**, so that route fails with `Operation not permitted` and —
worse — fails *silently*, which is exactly how `com.oasis-x.nimbus-watchdog` sat
dead at exit 126 without anyone noticing. Do not re-add a LaunchAgent for
anything living in this repo without checking that first.

Containerizing sidesteps TCC and lands a **better** trust posture than launchd
would have: on the host, `claw-vet` runs with Mike's full user rights; in the
container it holds the learned store (RW — it is the only writer), `bots/*/role.yaml`
(RO — it enforces the policy, it cannot edit it), the proxy's audit stream (RO),
and the gateway. Notably absent: the **docker socket**. Reading `docker logs`
would require mounting it, which is root-equivalent on the host — the proxy's
`AUDIT_FILE` sink exists so that mount is unnecessary. It is attached to
`oasis_egress` only, never `oasis_sandboxed`, so no bot can reach the service that
decides that bot's egress.

```sh
make -C ../bots vet-up      # build + start the vetter
make -C ../bots vet-logs    # watch decisions as they happen
make -C ../bots vet-queue   # what's pending, and what the role gate would refuse
```

`up-all` starts it with the fleet. It is kept out of `sidecars-up` on purpose:
that target must never fail, and the vetter requires `OASIS_GENERATION_TOKEN`, so
folding it in would let a missing token take the **egress proxy** down with it.
The container is `restart: unless-stopped`, so once started it survives reboots —
that is the persistence, not a launchd agent.

### Run the fail-closed proof

```sh
./test/fail-closed.sh
```

Stands up the proxy + an internal-only client and asserts:

1. allowlisted `api.anthropic.com` **reachable** through the proxy (full TLS
   tunnel, SNI-peek path exercised under `lenient`);
2. non-allowlisted `example.com` **blocked** by the proxy (HTTP 403);
3. direct egress bypassing the proxy from the internal net **has no route**
   (proves the proxy is the only exit).

Exit code = failed assertions (0 = all pass). Tears its own topology down.

### Tests

- **`test/fail-closed.sh`** — the happy-path boundary (allowlisted through,
  unknown blocked HTTP 403, no direct route). 3/3.
- **`test/adversarial.sh`** (CLAW-037) — attacks the boundary: domain fronting,
  DNS-rebinding→cloud-metadata, SSRF→RFC1918/loopback, raw-IP CONNECT, direct
  bypass, plus audit-reason assertions. Runs under `SNI_ENFORCE=strict`. 10/10.
- **`test/per-bot-egress.sh`** (CLAW-050) — per-bot partitioning against the real
  binary + `claw-vet`: base reachable, a bot reaches its own seed, unlisted denied,
  `claw-vet --bot` writes the bot's learned namespace and the proxy hot-reloads it.
  Two-bot isolation runs when a second loopback source IP is available, else skips
  to the unit test. 7/7 (macOS) — 11/11 on Linux.
- **`test/per-bot-isolation-docker.sh`** (CLAW-050) — the load-bearing property in
  the real prod topology: proxy + two source-IP clients in one Linux container
  prove bot A is denied bot B's seed *and* learned hosts (and vice-versa), with
  correct per-bot audit attribution. 9/9. Runs on macOS via the Docker Linux VM.
- **`test/learned-reload.sh`** (CLAW-034) — the global learned store hot-reloads a
  `claw-vet` write with no restart; empty-after-reload keeps last-known-good. 4/4.
- **`test/vet-role-gate.sh`** (CLAW-034 × CLAW-047) — the vetter's role-policy gate
  only ever SUBTRACTS: provider hosts refused fleet-wide (including ones no
  `role.yaml` thought to exclude), `posture: locked` keeps Yes Man's namespace
  permanently empty, per-bot `origins.exclude` honored, unattributed candidates
  cannot widen a partitioned fleet, unreadable policy fails closed — while in-role
  hosts still reach the classifier untouched. Pure policy eval; no docker, no
  gateway, no network. 14/14.
- **`test/fs-isolation.sh`** — the *filesystem* half of "reach": runs the real
  runtime image with the runtime hardening flags + a read-only fixture mount and
  proves a compromised loop reads only the granted dir (no host secrets, no host
  writes, no sibling/`..` escape, non-root, empty caps, NoNewPrivs, mknod
  blocked). 12/12. This is the gate before any local directory is bind-mounted
  into a bot.

### Hardening: DNS-rebinding / SSRF guard (closed)

The proxy resolves each CONNECT/HTTP target itself and **refuses to dial any
special-use address** — loopback, RFC1918, link-local (incl. the
`169.254.169.254` metadata endpoint), ULA, CGNAT, multicast, unspecified — then
dials the vetted **public IP by literal**, pinning it. An allowlisted *name*
re-pointed (DNS rebinding) at an internal IP is denied (`resolved-to-blocked-ip`).
`EGRESS_ALLOW_PRIVATE=1` disables the guard (off by default, fail-closed).

### Threat-model caveats (honest limits)

- **Host-header fronting inside TLS is invisible** (no interception): a request
  to an allowlisted CDN host that carries a different `:authority` in HTTP/2
  cannot be seen. SNI enforcement closes SNI-based fronting; Host-header fronting
  on a shared allowlisted CDN remains an accepted residual (keep the allowlist
  off shared CDNs where possible).
- **Wiring into the live runtime is staged, not live.** The target topology is
  `docker-compose.sandbox-runtime.yml` (proven at the model level by the tests
  above). Going live is gated on a functional check that a sandboxed bot completes
  a real model + Telegram round-trip through the sidecar (the app must honor
  `HTTPS_PROXY` or the app-layer `proxy.*` config, CLAW-031). Verify on one
  throwaway bot before applying to Nimbus. Then layer first-visit vetting
  (CLAW-034).

## Roadmap (this directory)

- **CLAW-033** — integrate the proxy into the live runtime compose (`internal:
  true` flip + gateway egress → sidecar).
- **CLAW-034/035** — first-visit domain-vetting service + Telegram escalation
  for unknown domains (so the human isn't the bottleneck).
- **CLAW-036** — `operating-system-sandbox` attestation extension: verify at
  `gateway_start` that the proxy is the sole egress, rootfs is read-only, and
  `exec.mode` is set — refuse to serve otherwise.
- **CLAW-037** — adversarial exfil test across both layers (incl. fronting).
