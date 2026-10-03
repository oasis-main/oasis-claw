import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { effectiveCommand, matchLedger, type LedgerEntry } from "./infra-ledger.js";
import { evaluateHard, NEVER_DOWNGRADE, resolveHardPolicy, type EvalInput } from "./policy.js";

type PolicyFile = NonNullable<Parameters<typeof resolveHardPolicy>[0]>;

// CLAW-116: Yes Man applies infrastructure changes only when a host-written
// approval-ledger entry covers them.

const DEV = "/reach/runes/oasis-x/oasis-cloud-admin/terraform/oasis-public/aws/environments/dev";

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: "INFRA-0001",
  status: "active",
  dir_prefixes: [DEV],
  command_patterns: ["^terraform (-chdir=\\S+ )?apply( -input=false)? \\S+\\.tfplan$"],
  ...over,
});

describe("effectiveCommand", () => {
  it("uses workdir for a simple command", () => {
    expect(effectiveCommand("terraform apply x.tfplan", DEV)).toEqual({ dir: DEV, simple: "terraform apply x.tfplan" });
  });
  it("takes one leading cd", () => {
    expect(effectiveCommand(`cd ${DEV} && terraform apply x.tfplan`)?.dir).toBe(DEV);
  });
  it("resolves terraform -chdir against the base dir", () => {
    expect(effectiveCommand("terraform -chdir=dev apply x.tfplan", `${DEV}/..`)?.dir).toBe(DEV);
  });
  it("refuses compound, substituted, redirected, or second-cd commands", () => {
    for (const c of [
      `cd ${DEV} && terraform apply x.tfplan && rm -rf /work`,
      `cd ${DEV} && cd /tmp && terraform apply x.tfplan`,
      `cd ${DEV}; terraform apply x.tfplan`,
      "terraform apply $(cat plan)",
      "terraform apply x.tfplan > out.log",
      "terraform apply x.tfplan | tee out.log",
      "terraform apply `x`",
    ]) {
      expect(effectiveCommand(c, DEV), c).toBeNull();
    }
  });
  it("has no directory for a relative command with no workdir", () => {
    expect(effectiveCommand("terraform apply x.tfplan")?.dir).toBeNull();
  });
});

describe("matchLedger", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  it("matches an active entry in the approved directory", () => {
    expect(matchLedger("terraform apply knowledge.tfplan", DEV, [entry()], now)?.id).toBe("INFRA-0001");
  });
  it("ignores proposed and revoked entries", () => {
    expect(matchLedger("terraform apply k.tfplan", DEV, [entry({ status: "proposed" })], now)).toBeNull();
    expect(matchLedger("terraform apply k.tfplan", DEV, [entry({ status: "revoked" })], now)).toBeNull();
  });
  it("ignores expired and unparseable expiry", () => {
    expect(matchLedger("terraform apply k.tfplan", DEV, [entry({ expires: "2026-09-01T00:00:00Z" })], now)).toBeNull();
    expect(matchLedger("terraform apply k.tfplan", DEV, [entry({ expires: "soon" })], now)).toBeNull();
    expect(matchLedger("terraform apply k.tfplan", DEV, [entry({ expires: "2026-10-01T00:00:00Z" })], now)?.id).toBe("INFRA-0001");
  });
  it("refuses another directory, including a prefix look-alike and a dot-dot escape", () => {
    expect(matchLedger("terraform apply k.tfplan", DEV.replace("/dev", "/prod"), [entry()], now)).toBeNull();
    expect(matchLedger("terraform apply k.tfplan", `${DEV}-evil`, [entry()], now)).toBeNull();
    expect(matchLedger("terraform -chdir=../prod apply k.tfplan", DEV, [entry()], now)).toBeNull();
  });
  it("refuses a command shape the entry does not name", () => {
    expect(matchLedger("terraform destroy -auto-approve", DEV, [entry()], now)).toBeNull();
    expect(matchLedger("terraform apply -auto-approve", DEV, [entry()], now)).toBeNull();
  });
  it("lets `*` stand for one path component (the pinned-commit checkout)", () => {
    const pinned = entry({ dir_prefixes: ["/work/apply/oasis-cloud-admin@*/terraform/oasis-public/aws/environments/dev"] });
    const ok = "/work/apply/oasis-cloud-admin@1a2b3c4d5e6f/terraform/oasis-public/aws/environments/dev";
    expect(matchLedger("terraform apply k.tfplan", ok, [pinned], now)?.id).toBe("INFRA-0001");
    expect(matchLedger("terraform apply k.tfplan", `${ok}/sub`, [pinned], now)?.id).toBe("INFRA-0001");
    expect(matchLedger("terraform apply k.tfplan", "/work/apply/oasis-cloud-admin@x/y/terraform/oasis-public/aws/environments/dev", [pinned], now)).toBeNull();
    expect(matchLedger("terraform apply k.tfplan", "/work/apply/other@1a2b/terraform/oasis-public/aws/environments/dev", [pinned], now)).toBeNull();
    expect(matchLedger("terraform apply k.tfplan", ok.replace("/dev", "/prod"), [pinned], now)).toBeNull();
  });
  it("skips a malformed pattern instead of throwing", () => {
    expect(matchLedger("terraform apply k.tfplan", DEV, [entry({ command_patterns: ["(("] })], now)).toBeNull();
  });
});

describe("evaluateHard — infrastructure gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "infra-ledger-"));
  const ledgerPath = join(dir, "infra-ledger.json");
  writeFileSync(ledgerPath, JSON.stringify({ version: 1, entries: [entry()] }));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const file = (ledger: string | undefined): PolicyFile => ({
    hard: {
      fleet: { compoundExec: "allow" },
      per_bot: {
        yesman: {
          ...(ledger ? { infraLedger: ledger } : {}),
          infraGateExtra: {
            _note: "ignored",
            "terraform-mutate": "\\bterraform\\b.*\\b(apply|destroy|import)\\b",
          },
        },
      },
    },
  } as PolicyFile);
  const exec = (command: string, workdir?: string): EvalInput => ({
    family: "exec",
    toolName: "exec",
    params: workdir ? { command, workdir } : { command },
    derivedPaths: undefined,
  });

  it("allows a covered change and names the entry", () => {
    const d = evaluateHard(exec("terraform apply k.tfplan", DEV), resolveHardPolicy(file(ledgerPath), "yesman"));
    expect(d).toMatchObject({ verdict: "allow", principle: "hard:infra-ledger-match" });
    expect(d.reason).toContain("INFRA-0001");
  });
  it("allows the cd-prefixed shape even though it contains &&", () => {
    const d = evaluateHard(exec(`cd ${DEV} && terraform apply k.tfplan`), resolveHardPolicy(file(ledgerPath), "yesman"));
    expect(d.principle).toBe("hard:infra-ledger-match");
  });
  it("escalates an uncovered change under a never-downgraded principle", () => {
    const d = evaluateHard(exec("terraform destroy -auto-approve", DEV), resolveHardPolicy(file(ledgerPath), "yesman"));
    expect(d).toMatchObject({ verdict: "escalate", principle: "hard:infra-ledger-miss" });
    expect(NEVER_DOWNGRADE.has(d.principle)).toBe(true);
    expect(d.retryHint).toBeTruthy();
  });
  it("escalates a covered command hidden in a compound", () => {
    const d = evaluateHard(exec("terraform apply k.tfplan && terraform destroy -auto-approve", DEV), resolveHardPolicy(file(ledgerPath), "yesman"));
    expect(d.principle).toBe("hard:infra-ledger-miss");
  });
  it("fails closed when the ledger is missing or not configured", () => {
    const missing = evaluateHard(exec("terraform apply k.tfplan", DEV), resolveHardPolicy(file(join(dir, "nope.json")), "yesman"));
    expect(missing).toMatchObject({ verdict: "escalate", principle: "hard:infra-ledger-miss" });
    expect(missing.reason).toContain("not found");
    const unset = evaluateHard(exec("terraform apply k.tfplan", DEV), resolveHardPolicy(file(undefined), "yesman"));
    expect(unset.reason).toContain("no approval ledger configured");
  });
  it("picks up a new approval without a restart", () => {
    const p = join(dir, "live.json");
    writeFileSync(p, JSON.stringify({ version: 1, entries: [] }));
    const policy = resolveHardPolicy(file(p), "yesman");
    expect(evaluateHard(exec("terraform apply k.tfplan", DEV), policy).verdict).toBe("escalate");
    writeFileSync(p, JSON.stringify({ version: 1, entries: [entry({ id: "INFRA-0002" })] }) + "\n");
    expect(evaluateHard(exec("terraform apply k.tfplan", DEV), policy).reason).toContain("INFRA-0002");
  });
  it("leaves read-only commands and other bots alone", () => {
    expect(evaluateHard(exec("terraform plan -out=k.tfplan", DEV), resolveHardPolicy(file(ledgerPath), "yesman")).verdict).toBe("allow");
    expect(evaluateHard(exec("terraform apply k.tfplan", DEV), resolveHardPolicy(file(ledgerPath), "house")).principle).toBe("hard:default-allow");
  });
});

describe("evaluateHard — exec workdir resolves relative write paths", () => {
  it("reads the exec tool's `workdir` parameter", () => {
    const policy = resolveHardPolicy(
      { hard: { fleet: {}, per_bot: { bot: { allowWriteRoots: ["/reach/ok"], denyWriteOutsideAllow: true } } } } as PolicyFile,
      "bot",
    );
    const write = (workdir: string): EvalInput => ({
      family: "file",
      toolName: "write",
      params: { path: "notes.md", content: "x", workdir },
      derivedPaths: undefined,
    });
    expect(evaluateHard(write("/reach/ok"), policy).verdict).toBe("allow");
    expect(evaluateHard(write("/reach/other"), policy)).toMatchObject({ verdict: "deny", principle: "hard:write-out-of-scope" });
  });
});
