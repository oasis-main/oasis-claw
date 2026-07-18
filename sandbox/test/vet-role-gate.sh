#!/usr/bin/env bash
# claw-vet role-policy gate regression (CLAW-034 × CLAW-047).
#
# The classifier answers "is this host SAFE to reach?" — it does NOT answer "is
# this host IN ROLE for this bot?". Before the gate existed, claw-vet asked only
# the first question, so `drain` would have auto-learned openrouter.ai (safe,
# reputable, and explicitly in four role.yaml `origins.exclude` lists) and would
# have written hosts into Yes Man's namespace despite `posture: locked` — the
# exfil boundary that makes his broad file reach survivable.
#
# This proves the gate SUBTRACTS and never adds: every assertion below is either
# a refusal-to-widen, or a legitimate in-role host still passing through to the
# classifier untouched.
#
# Hermetic: pure policy evaluation against the repo's real role.yaml files plus a
# temp fixture. No docker, no gateway, no network.
#
# Exit code = number of failed assertions (0 = all pass).
set -u
cd "$(dirname "$0")/../.."   # repo root

exec python3 - "$PWD" <<'PY'
import importlib.machinery, importlib.util, sys, tempfile
from pathlib import Path

repo = Path(sys.argv[1])
loader = importlib.machinery.SourceFileLoader("claw_vet", str(repo / "scripts" / "claw-vet"))
spec = importlib.util.spec_from_loader("claw_vet", loader)
cv = importlib.util.module_from_spec(spec)
loader.exec_module(cv)

failed = 0


def check(desc, got, want):
    global failed
    if got == want:
        print(f"  ✅ PASS: {desc}")
    else:
        print(f"  ❌ FAIL: {desc}\n           got={got!r} want={want!r}")
        failed += 1


def reason(host, bot):
    g = cv.policy_gate(host, bot or None)
    return g["reason"] if g else None


print("== 1. provider egress is refused fleet-wide (GEN-003 interlock) ==")
# Declared in role.yaml excludes...
check("openrouter.ai / house", reason("openrouter.ai", "house"), "provider-host(gateway-interlock)")
check("api.openai.com / kolmogorov", reason("api.openai.com", "kolmogorov"), "provider-host(gateway-interlock)")
# ...and the one NO role.yaml thought to exclude. House hit this live on
# 2026-07-18; on security signals alone a classifier PASSes it instantly.
check("generativelanguage.googleapis.com / house",
      reason("generativelanguage.googleapis.com", "house"), "provider-host(gateway-interlock)")
# Provider refusal outranks bot identity — even an adversarial-research bot.
check("openrouter.ai / vanhelsing", reason("openrouter.ai", "vanhelsing"), "provider-host(gateway-interlock)")

print("== 2. posture: locked keeps Yes Man's namespace permanently empty ==")
check("raw.githubusercontent.com / yesman", reason("raw.githubusercontent.com", "yesman"), "posture-locked")
# Even a host that is unimpeachable for every other bot.
check("arxiv.org / yesman", reason("arxiv.org", "yesman"), "posture-locked")

print("== 3. in-role hosts still reach the classifier (gate only subtracts) ==")
check("raw.githubusercontent.com / kolmogorov", reason("raw.githubusercontent.com", "kolmogorov"), None)
check("kalshi.com / house", reason("kalshi.com", "house"), None)
check("crates.io / butterbolt", reason("crates.io", "butterbolt"), None)
# The gate is NOT a safety vetter: an undeclared host passes the gate and is then
# judged by the classifier + honeypot. Conflating the two would turn live vetting
# back into a static allowlist.
check("undeclared host / house", reason("evil.example.test", "house"), None)

print("== 4. unattributed candidates cannot widen a partitioned fleet ==")
# bot="" writes the GLOBAL store that every bot reads. Stale pre-partition log
# lines must not become fleet-wide grants.
real_partitioned = cv.proxy_partitioned
cv.proxy_partitioned = lambda: True
check("bot='' vs partitioned proxy", reason("raw.githubusercontent.com", ""), "unattributed-candidate")
cv.proxy_partitioned = lambda: False
check("bot='' vs unpartitioned proxy", reason("raw.githubusercontent.com", ""), None)
cv.proxy_partitioned = real_partitioned

print("== 5. an unreadable policy fails CLOSED ==")
# "I could not read the policy" must never be treated as "there is no policy".
with tempfile.TemporaryDirectory() as td:
    real_roles = cv.ROLES_DIR
    cv.ROLES_DIR = Path(td)
    (Path(td) / "brokenbot").mkdir()
    (Path(td) / "brokenbot" / "role.yaml").write_text("origins: [this is not a mapping\n")
    cv._ROLE_CACHE.clear()
    check("malformed role.yaml", reason("example.test", "brokenbot"), "role-policy-unreadable")
    # A bot with no role.yaml at all is unmanaged, not broken — it proceeds.
    cv._ROLE_CACHE.clear()
    check("absent role.yaml", reason("example.test", "nosuchbot"), None)
    cv.ROLES_DIR = real_roles
    cv._ROLE_CACHE.clear()

print(f"\n{'ALL PASS' if not failed else str(failed) + ' FAILED'}")
sys.exit(failed)
PY
