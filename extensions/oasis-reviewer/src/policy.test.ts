import { describe, expect, it } from "vitest";
import { evaluateHard, DEFAULT_HARD_POLICY as P, type EvalInput } from "./policy.js";

// Layer 1 hard-constraint verdicts (§6a). These cover the deterministic rules;
// the gitignore-membership path (isGitignored → `git check-ignore`) is exercised
// separately as an integration check because it depends on a real work tree.

const exec = (command: string): EvalInput => ({
  family: "exec",
  toolName: "exec",
  params: { command },
  derivedPaths: undefined,
});
const file = (toolName: string, path: string, extra: Record<string, unknown> = {}): EvalInput => ({
  family: "file",
  toolName,
  params: { path, ...extra },
  derivedPaths: undefined,
});

describe("evaluateHard — exec", () => {
  it("allows a normal command", () => {
    expect(evaluateHard(exec("ls /reach"), P).verdict).toBe("allow");
  });
  it("denies destructive commands", () => {
    for (const c of ["rm -rf /", "rm -rf --no-preserve-root /", "mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/sda"]) {
      expect(evaluateHard(exec(c), P), c).toMatchObject({ verdict: "deny", principle: "hard:destructive-exec" });
    }
  });
  it("escalates compound / piped / redirected argv", () => {
    for (const c of ["cat a | grep b", "a && b", "a; b", "echo x > file", "echo `id`"]) {
      expect(evaluateHard(exec(c), P), c).toMatchObject({ verdict: "escalate", principle: "hard:compound-exec" });
    }
  });
});

describe("evaluateHard — file", () => {
  it("denies writes under the control-plane root", () => {
    expect(evaluateHard(file("write", "/reach/runes/oasis-x/oasis-claw/x.ts", { content: "z" }), P))
      .toMatchObject({ verdict: "deny", principle: "hard:deny-write-control-plane" });
  });
  it("denies reads of secret globs", () => {
    for (const p of ["/home/node/.ssh/id_rsa", "/x/server.pem", "/x/tls.key"]) {
      expect(evaluateHard(file("read", p), P), p).toMatchObject({ verdict: "deny", principle: "hard:deny-read-secret" });
    }
  });
  it("allows reads of ordinary source", () => {
    expect(evaluateHard(file("read", "/reach/runes/foo/main.py"), P).verdict).toBe("allow");
  });
});

describe("evaluateHard — web/other", () => {
  it("allows web (egress proxy owns host policy)", () => {
    expect(evaluateHard({ family: "web", toolName: "web_fetch", params: { url: "https://example.com" }, derivedPaths: undefined }, P).verdict).toBe("allow");
  });
});
