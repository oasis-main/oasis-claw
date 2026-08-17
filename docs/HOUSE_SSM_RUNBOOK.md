# House → SSM troubleshooting grant (runbook)

**Goal:** let House drive AWS Session Manager against the PMT runner EC2 to
diagnose the 1s-tick → 3s latency, **read-only**, without handing a
broad-file-reach analyst bot standing keys to the live capital box.

Account `469618777502`, region `us-east-1`. The PMT runner is the EC2 instance
that deploys `main` of `exp` (see `exp/DEPLOY.md`, `exp/README.md`).

---

## Status: precondition VOID — superseded, then largely overtaken (2026-08-08)

**The "#8" this document waits on will never land.** CLAW-054 (the uid-split /
token-free exec runner) was **SUPERSEDED 2026-07-24** by the boundary-first
scope-down — "DO NOT BUILD THE RUNNER". The replacement control model is the
**egress boundary + credential scoping**, with exec running in-container at
container granularity. Anything below that still says "apply at #8" should be read
against that newer model, not the old one.

Separately, Mike granted House full systems-administration scope on his personal
AWS on **2026-08-08** (trading infrastructure + deploys + financial/business
OSINT), which moots most of the "should House touch AWS at all" framing here.

| Artifact | State |
|---|---|
| `bots/house/role.yaml` — `aws` in `exec.allow` | **DONE 2026-08-08** |
| `bots/house/role.yaml` — `git` in `exec.allow` (deploys) | **DONE 2026-08-08** |
| `bots/house/role.yaml` — SSM endpoints in `origins.trusted` | **not needed** — `.amazonaws.com` was already trusted 2026-07-30 and covers `ssm`/`ssmmessages`/`ec2messages`/`sts` |
| `sandbox/egress-proxy/seeds/house/allowlist.txt` | **re-emitted 2026-08-08** (also added `.kalshi.com`) |
| Credential scoping (§ below) | **DONE 2026-08-09, CLAW-079** — `~/.aws-house` holds only `[pmt-prod]`; superseded 2026-08-17, see below |
| `pmt-prod`'s SSM rights | **too narrow for House** (found 2026-08-17) — only `SendCommand`+`GetCommandInvocation` (the deploy pipeline's shape); widened with 3 read-only discovery actions same day |
| `bots/house/iam/house-ssm-readonly.policy.json` — least-priv IAM policy | **APPLIED 2026-08-17**, as `iam_bootstrap/main.tf` → `aws_iam_user_policy.house_ssm_readonly` (one change from the parked file: `ssm:StartSession`'s Resource uses `instance/*` + the `Role=pmt-runner` tag condition, not a hardcoded instance ARN — the runner box already carries that tag unconditionally, and a hardcoded ARN breaks on the next box rotation, same reasoning `pmt_prod`'s own policy already used) |
| `bots/house/iam/SSM-House-ReadOnly-Shell.doc.json` — read-only SM document | **APPLIED 2026-08-17**, as `aws_ssm_document.house_readonly_shell` |
| `session-manager-plugin` in the runtime image | **ADDED 2026-08-17** (`Dockerfile.runtime`) — needs an image rebuild + fleet restart to take effect |
| `house-ro` OS user on the runner box | **NOT YET CREATED** — one-time `ssm:SendCommand` needed (see § below); cloud-init has no room (350-line `user_data.sh.tpl` is 16248/16384 bytes, the EC2 hard limit) so this does not survive a box rotation automatically — re-run the one-liner after any future rotation |

### Resolved 2026-08-17: which credential, and what it can actually do

CLAW-079 (2026-08-09) scoped House down to the **existing** `pmt-prod` IAM user
(minted 2026-07-22 for the code-deploy pipeline) rather than minting the
dedicated `house-ssm` principal this runbook always planned — a reasonable
shortcut for the credential-*separation* half of the problem, but it left House
holding a principal shaped for `deploy_inplace.py`'s fire-and-forget
`SendCommand` pattern, not for the read-only *interactive-session* need this
runbook exists for. `pmt-prod`'s policy had zero `ssm:DescribeInstanceInformation`
/ `ssm:StartSession` / discovery rights, so House could not do anything SSM
beyond exactly the deploy shape. This is why "House still can't do any AWS work"
was reported even though the credential-scoping item above says DONE.

Fixed by doing **both** halves properly: `pmt-prod` gets three narrow read-only
SSM discovery actions (still no `StartSession` — that stays off a principal that
also carries `ec2:*`/`iam:*`/`secretsmanager:*`), and the originally-planned
`house-ssm` principal from §3 below is now actually minted, holding `StartSession`
scoped to the read-only document + the `Role=pmt-runner` tag, nothing else. House's
container needs a second AWS profile added to `~/.aws-house` for this — see the
key-delivery step below (unchanged from the original §4 plan, still Mike-only).

Also found and worth knowing about, unrelated to House: `pmt-prod`'s ORIGINAL
Terraform-managed access key (`AKIAW2V3V3WPGT6EHRT2`, minted 2026-06-01) is
`Inactive` in AWS today and was never the one actually deployed — a SECOND key
(`AKIAW2V3V3WPNLLOQENM`, created ~44 min later, `Active`) is the one actually in
`~/.aws-house` and in use, but it was never brought under Terraform management
(not an `aws_iam_access_key` resource in state). Applying the IAM changes above
will incidentally flip the tracked-but-unused key back to `Active` as pure drift
correction (Terraform has no other opinion about it) — harmless, confirmed no
file anywhere references that key ID. The live, in-use key stays untouched and
untracked; reconciling that (`terraform import`) is a separate, non-blocking
cleanup item, not done here.

---

## Steps you (Mike) must do — the credential parts Claude cannot

Claude cannot mint IAM users, enter access keys, run `terraform apply` on your
account, or `ssm send-command` against the live trading box. These are yours.

### 1. Apply the Terraform (steps 2 + 3 below, now declarative)
`prediction_market_trading/infrastructure/terraform/iam_bootstrap/main.tf` now
has both changes — `terraform plan` (with `AWS_PROFILE=personal-admin`) shows
4 to add, 2 to change, 0 to destroy: the `house-ssm` IAM user + its read-only
policy + the `SSM-House-ReadOnly-Shell` document + a new access key, plus
`pmt-prod`'s policy gaining 3 read-only SSM discovery actions and — pure drift
correction, unrelated to this change and confirmed unused elsewhere — its
original untracked access key flipping back to `Active`. The instance is
already tagged `Role = pmt-runner` (runner module, unconditional), so no
`REPLACE_WITH_PMT_INSTANCE_ID` placeholder and no `aws ec2 create-tags` step
remain: `cd prediction_market_trading/infrastructure/terraform/iam_bootstrap
&& AWS_PROFILE=personal-admin terraform apply`.

### 2. Mint the read-only OS user on the runner (one-time SSM command)
Cloud-init has no byte budget left (`user_data.sh.tpl` is 16248/16384 bytes,
the EC2 hard limit) to create `house-ro` automatically, so this is a one-time
command against the live box, using `pmt-prod`'s existing `SendCommand` right
— re-run it after any future box rotation, it's idempotent:
```bash
AWS_PROFILE=personal-admin aws ssm send-command \
  --document-name AWS-RunShellScript \
  --targets "Key=tag:Role,Values=pmt-runner" \
  --parameters commands='["id house-ro &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin --groups systemd-journal house-ro","setfacl -m u:house-ro:r-- /var/log/pmt-runner.log /var/log/pmt-bootstrap.log 2>/dev/null || true"]' \
  --region us-east-1
```

### 4. Deliver the new credential — add a profile, don't replace the file

`~/.aws-house` (mounted RO at `/home/node/.aws` — CLAW-079) already holds
`[pmt-prod]`; add a second `[house-ssm]` section using `terraform output -raw
house_ssm_access_key_id` / `house_ssm_secret_access_key` from the
`iam_bootstrap` stack, in both `~/.aws-house/credentials` and
`~/.aws-house/config` (`[profile house-ssm]`), same shape as the existing
`pmt-prod` entries. House then needs `--profile house-ssm` on any `aws ssm
start-session` call — nothing selects it by default, same as `pmt-prod` today.
Standing key, file-based, out of the process env — unchanged reasoning from
the original plan (the openclaw secrets-vault plugin only injects into
browser form fields, and env vars would print into an exec transcript).

### 5. Rebuild the runtime image and restart the fleet
`session-manager-plugin` is now in `Dockerfile.runtime` (2026-08-17). Claude
rebuilds `oasis-claw-runtime:local` and recreates the bot containers — this is
a local Docker operation, not an AWS one.

### 6. Reload the proxy — confirmed not needed
`.amazonaws.com` was already trusted 2026-07-30 and covers `ssm`/`ssmmessages`/
`ec2messages`/`sts`. No egress-allowlist change accompanies this grant.

---

## Residual risk to accept, explicitly

1. **Charter reversal.** House's role.yaml says *"no systems authority … you do
   not act on the systems you analyze."* An interactive shell on the PMT runner
   crosses that line, even read-only. If the intent is "House reads diagnostics,"
   the read-only user + SM document hold that line; if it ever needs write/restart
   authority, that belongs to a different posture, not House's.
2. **Live capital box.** Even read-only, this is the box managing real money.
   Read-only prevents mutation, not observation of positions/keys already on the
   box — House can already read most of that via `/reach/exp`, so this is not a
   *new* confidentiality exposure, but worth naming.
3. **Pre-#8 exec-can-read-creds gap.** Covered above; the reason A (STS) is the
   recommended interim.
