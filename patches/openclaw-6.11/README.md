# openclaw 6.11 vendored patches

Patches we carry against pinned openclaw `2026.6.11`. Each is a scoped edit of the
installed dist under `/usr/local/lib/node_modules/openclaw/dist/`, bind-mounted
`:ro` over the stock file (per-bot, in the bot's `*-reach.yml` overlay).

**Why bind-mount and not `docker cp`:** the bot containers run with a **read-only
rootfs** (`read_only: true`, defense-in-depth). `docker cp` into `…/openclaw/dist/`
is rejected by the daemon — *"container rootfs is marked read-only"* — even though
it misleadingly prints "Successfully copied" first (staging step; the write fails
after). So a dist patch has exactly two durable homes: baked into the image, or
`:ro` bind-mounted over the file. A `:ro` mount applies *over* the read-only rootfs.

> **Boundary-first posture (CLAW-072, 2026-07-24).** The load-bearing containment
> is the egress boundary + least-privilege creds — NOT dist patches. See
> [`.swarm/OPENCLAW_NATIVE_ISOLATION_DESIGN.md`](../../.swarm/OPENCLAW_NATIVE_ISOLATION_DESIGN.md).
> The exec runner was retired and exec moved back **in-container** on the stock,
> fail-safe `host="gateway"` path. Any dist need is a signal to **upstream**
> (CLAW-067) — never to grow the fork.

> **⚠️ NOTHING IN THIS DIR IS MOUNTED AS OF 2026-07-25.** The exec-reviewer patch
> below was built + live-verified, then **SHELVED**: it depends on the human-approval
> "ask" escalation, and openclaw's Telegram approval loop is unreliable (30-min
> polling stalls + dead callback buttons, CLAW-068/070), so escalations hung tasks.
> Yes Man was scoped down to **pure allowlist exec (`ask=off`)** — no reviewer, no
> approval path, **zero dist patches**. The file stays here for history and is
> re-mountable if the approval path is fixed. See
> [`OPENCLAW_NATIVE_ISOLATION_DESIGN.md` §8](../../.swarm/OPENCLAW_NATIVE_ISOLATION_DESIGN.md).

---

## ACTIVE — `exec-auto-reviewer-BhIiv15B.js`  (CLAW-072, mounted on Yes Man)

**What.** The stock model-backed exec reviewer, with two localized edits:

1. **`parseExecAutoReviewResponse`** — `risk !== "low"` → `risk !== "low" && risk
   !== "medium"`. So an `allow` verdict at risk **low OR medium** maps to
   `allow-once` (auto-execute); `high`/`unknown` still map to `ask` (human).
2. **`DEFAULT_EXEC_REVIEWER_SYSTEM_PROMPT`** — rewritten to give the model the
   risk taxonomy (design §3.2): low = read-only; medium = bounded, reversible,
   sandbox-local side effects; high = irreversible/broad/dangerous; unknown =
   unparseable. Without this the model never emits `allow`+`medium`, so the parse
   change alone would be inert.

**Why it's a patch and not config.** Verified in the 6.11 dist: the risk→action
mapping is hardcoded in `parseExecAutoReviewResponse`; the config seam
(`tools.exec.reviewer`) tunes only model + timeout; the system prompt is
hardcoded; the `defaults.autoReviewer` programmatic seam is never populated and
has no plugin-SDK setter. So widening medium→auto has no zero-patch path in stock
6.11 — accepted as ONE reviewer patch (Mike, 2026-07-24), filed upstream (CLAW-067).

**Why it's safe.** autoReview is the *soft* residual control; the hard bounds are
the egress boundary (nothing exfiltrates) + least-privilege creds (a medium
command can't exceed scope). Compound (`&&`/`;`/`||`) and pipes/redirects are
`analysisOk=false` → never auto-reviewed → **human** (fail-safe, unchanged).

**Guardrail = the per-bot mount.** Only bots whose reach overlay mounts this file
get medium→auto: Yes Man (today), and later House / Kolmogorov / ButterBolt.
**Van Helsing (adversarial) must NOT get it.**

**Live-verified 2026-07-24** on yesman (patched prompt+parse, real Sonnet model,
through the egress proxy): `id`/`cat` → allow-once(low); `mkdir -p` →
allow-once(medium); `rm -rf` → ask(high); compound/pipe → no input → human.

**Regenerate** (if the dist hash changes on a version bump): copy the stock file,
re-apply the two edits, `node --check`, update the mount path.

**Increment 2 — malicious→alert (SHIPPED 2026-07-24, alert-only variant).** The
reviewer now has a `malicious` risk tier (schema + prompt): clear exfil /
persistence / anti-control intent → decision `ask` **plus** a fire-and-forget
operator **alert** (`fireMaliciousExecAlert` → Telegram `sendMessage`, same file,
no 2nd patch). The alert is a **notification, not an approval prompt**; it runs in
the gateway process so it honors the egress-proxy dispatcher + the
`api.telegram.org` allowlist entry, and is wrapped so it can never throw into or
delay the review. The command still routes through the normal human path with
`ask-fallback=deny` → **blocked unless a human approves** (a *soft* block).

A *true* un-overridable hard-deny was **deliberately deferred** (Mike, 2026-07-24:
"alert-only, stay 1 patch") — it would need a 2nd `bash-tools` consumer deny-branch
(the reviewer's own try/catch swallows a throw). Given layers 1–2 backstop
everything, the alert is the higher-value half. Live-verified: `nc -e … revshell`
and `curl --data-binary @/etc/shadow` → `risk=malicious`→human; `getMe` transport
probe ok through the proxy.

---

## RETIRED — both node-path patches (with the runner, 2026-07-24)

Exec no longer runs `host="node"`, so both of these are moot. The files remain in
this dir for history but are **not mounted** anywhere.

- **`node-invoke-device-identity.patch` + `gateway-Cql8-Ml_.js`** (CLAW-058/059) —
  loaded the requester device identity on `node.invoke` so inline autoReview
  allow-once survived the approval device-bind check on the runner path. No runner
  → no `node.invoke` → moot.
- **`autoreview-compound-commands.patch` + `bash-tools-CMeLXzt9.js`** (CLAW-071) —
  flattened multi-segment argv so the runner could auto-**approve** compound
  commands (a UX fix for approval fatigue, `host="node"` only — never a security
  fix; stock compound already fails safe to human). Moot with the runner, and its
  absence is strictly *more* conservative (compound → human).

Do not re-mount these. If cred-separated exec becomes a hard requirement again,
that is the business case for the Hermes runtime (RUNTIME_HEDGE Branch A), not a
reason to rebuild the runner + these patches.
