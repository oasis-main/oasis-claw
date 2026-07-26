# House → SSM troubleshooting grant (runbook)

**Goal:** let House drive AWS Session Manager against the PMT runner EC2 to
diagnose the 1s-tick → 3s latency, **read-only**, without handing a
broad-file-reach analyst bot standing keys to the live capital box.

Account `469618777502`, region `us-east-1`. The PMT runner is the EC2 instance
that deploys `main` of `exp` (see `exp/DEPLOY.md`, `exp/README.md`).

---

## Status: DEFERRED behind the uid-exec sandbox (task #8)

Decision (Mike, 2026-07-19): do the **whole** SSM grant *after* #8 lands, with a
standing key. Rationale: until exec is uid-split, House's own `exec` can `cat` any
standing credential in its container, and House is a high-adversarial-exposure bot.

So the role/seed edits were **reverted** (House's active policy advertises no SSM
capability today); only the design artifacts below are kept, ready to apply.

| Artifact | State |
|---|---|
| `bots/house/role.yaml` — `aws` + `session-manager-plugin` in `exec.allow` | **to apply at #8** (placeholder comment left in file) |
| `bots/house/role.yaml` — 4 SSM endpoints in `origins.trusted` | **to apply at #8** (placeholder comment left in file) |
| `sandbox/egress-proxy/seeds/house/allowlist.txt` — re-emit after the role edit | **to apply at #8** |
| `bots/house/iam/house-ssm-readonly.policy.json` — least-priv IAM policy | written, parked |
| `bots/house/iam/SSM-House-ReadOnly-Shell.doc.json` — read-only SM document | written, parked |

**To apply at #8:** put the 4 endpoints back in `origins.trusted` and `aws` +
`session-manager-plugin` in `exec.allow` (comments in `role.yaml` mark both spots),
re-run `compile-role.py --emit-egress-allowlist`, then follow the steps below.

---

## Steps you (Mike) must do — the credential parts Claude cannot

Claude cannot mint IAM users, enter access keys, or run `aws` with your root
credentials. These are yours:

### 1. Mint the read-only OS user on the runner
On the PMT runner (one time): create `house-ro`, no sudo, member of the groups
needed to *read* logs (`adm`/`systemd-journal`), owning nothing. This is what
`runAsDefaultUser` in the SM document lands as.

### 2. Register the SM document + tag the instance
```
aws ssm create-document \
  --name SSM-House-ReadOnly-Shell \
  --document-type Session \
  --document-format JSON \
  --content file://bots/house/iam/SSM-House-ReadOnly-Shell.doc.json \
  --region us-east-1
aws ec2 create-tags --resources <PMT_INSTANCE_ID> \
  --tags Key=Role,Value=pmt-runner --region us-east-1
```

### 3. Create the scoped IAM principal
Replace `REPLACE_WITH_PMT_INSTANCE_ID` in
`bots/house/iam/house-ssm-readonly.policy.json`, then attach it to a **dedicated**
IAM user `house-ssm` (not a reused principal). This policy grants **only**:
`StartSession` on that one instance **through the read-only document**,
`DescribeInstanceInformation`/`DescribeInstances` for discovery, and
terminate/resume of House's **own** sessions. No `SendCommand`, no write, no
other instance.

### 4. Deliver the credential — standing key, file-based (chosen mechanism)

The openclaw **secrets-vault** plugin only injects into browser form fields; it
cannot feed the `aws` CLI. Decision: since this whole grant now lands **after #8**
(when exec is uid-split and can no longer read the credential file), deliver a
**standing IAM access key as a file**, not env:

- Write the key into a host-only file House alone mounts at `~/.aws/credentials`
  (RO). The `aws` CLI reads it natively. It stays **out of the process env**, so
  even the pre-#8 `env`-dump leak never applies. Rotate on a schedule.
- Do **not** use env vars (`AWS_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`): exec env is
  unsanitized while `agents.sandbox` is null, so `env` in a House exec would print
  the secret into the transcript. #8 fixes that too, but file delivery is cleaner
  regardless.

Post-#8, the uid-split means House's exec uid cannot read the credentials file at
all — that is the property that makes a *standing* key acceptable here.

### 5. Put `aws` + `session-manager-plugin` in the runtime image
Claude will add both to the shared runtime Dockerfile and rebuild once you pick
the mechanism (holding it so the image change lands with a working end-to-end
path, not ahead of it).

### 6. Reload the proxy so the seed takes effect
`make egress-sync` then recreate/reload the proxy (seeds load at proxy start).

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
