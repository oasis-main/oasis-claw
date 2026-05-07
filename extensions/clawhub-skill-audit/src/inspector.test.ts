/**
 * Inspector unit tests — defensively pessimistic, because this is the one
 * piece that sees model-supplied paths. Anything we miss here lets a
 * compromised auditor model read host files.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AUDITABLE_EXT, Inspector } from "./inspector.js";

let tmpRoot: string;
let allowedRoot: string;
let outsideRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inspector-test-"));
  allowedRoot = path.join(tmpRoot, "allowed");
  outsideRoot = path.join(tmpRoot, "outside");
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeInspector(opts?: Partial<{ maxFiles: number; maxTotalBytes: number; maxBytesPerFile: number }>) {
  return new Inspector({
    inspectRoots: [allowedRoot],
    maxFiles: opts?.maxFiles ?? 5,
    maxTotalBytes: opts?.maxTotalBytes ?? 10_000,
    maxBytesPerFile: opts?.maxBytesPerFile ?? 1_000,
    auditableExt: DEFAULT_AUDITABLE_EXT,
  });
}

describe("Inspector — happy path", () => {
  it("reads a file under an allowed root", () => {
    fs.writeFileSync(path.join(allowedRoot, "hello.ts"), "export const x = 1;");
    const i = makeInspector();
    const r = i.read("hello.ts", "checking entry point");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contents).toContain("x = 1");
      expect(r.size).toBe(19);
    }
    expect(i.inspected[0].ok).toBe(true);
    expect(i.inspected[0].reason).toBe("checking entry point");
  });

  it("reads a nested path", () => {
    const dir = path.join(allowedRoot, "src", "providers");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "twilio.ts"), "// twilio provider\n");
    const i = makeInspector();
    const r = i.read("src/providers/twilio.ts", "want to see provider");
    expect(r.ok).toBe(true);
  });
});

describe("Inspector — path safety", () => {
  it("rejects absolute paths", () => {
    const i = makeInspector();
    const r = i.read("/etc/passwd", "exfil attempt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/absolute paths/);
  });

  it("rejects '..' segments", () => {
    fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "secret");
    const i = makeInspector();
    const r = i.read("../outside/secret.txt", "escape attempt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/'\.\.' segments/);
  });

  it("rejects extensions outside the auditable allowlist", () => {
    fs.writeFileSync(path.join(allowedRoot, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const i = makeInspector();
    const r = i.read("blob.bin", "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/extension '.bin'/);
  });

  it("refuses symlinks that escape the allowed root", () => {
    fs.writeFileSync(path.join(outsideRoot, "secret.ts"), "const SECRET = 'pwn';");
    fs.symlinkSync(path.join(outsideRoot, "secret.ts"), path.join(allowedRoot, "innocuous.ts"));
    const i = makeInspector();
    const r = i.read("innocuous.ts", "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/);
    // Audit trail records the failed attempt
    expect(i.inspected[0].ok).toBe(false);
  });

  it("returns 'not found' for files that don't exist", () => {
    const i = makeInspector();
    const r = i.read("does-not-exist.ts", "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/);
  });
});

describe("Inspector — budget enforcement", () => {
  it("caps total file count", () => {
    for (let n = 0; n < 5; n++) {
      fs.writeFileSync(path.join(allowedRoot, `f${n}.ts`), `// ${n}\n`);
    }
    const i = makeInspector({ maxFiles: 3 });
    expect(i.read("f0.ts", "").ok).toBe(true);
    expect(i.read("f1.ts", "").ok).toBe(true);
    expect(i.read("f2.ts", "").ok).toBe(true);
    const fourth = i.read("f3.ts", "");
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.error).toMatch(/max files/);
    expect(i.budgetExhausted()).toBe(true);
  });

  it("truncates files larger than per-file cap", () => {
    fs.writeFileSync(path.join(allowedRoot, "big.ts"), "x".repeat(5_000));
    const i = makeInspector({ maxBytesPerFile: 1_000 });
    const r = i.read("big.ts", "");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contents.length).toBe(1_000);
      expect(r.size).toBe(5_000);
      expect(r.truncated).toBe(true);
    }
  });

  it("caps total bytes returned across multiple reads", () => {
    fs.writeFileSync(path.join(allowedRoot, "a.ts"), "y".repeat(800));
    fs.writeFileSync(path.join(allowedRoot, "b.ts"), "y".repeat(800));
    fs.writeFileSync(path.join(allowedRoot, "c.ts"), "y".repeat(800));
    const i = makeInspector({ maxTotalBytes: 1_500, maxBytesPerFile: 1_000 });
    expect(i.read("a.ts", "").ok).toBe(true);   // 800 bytes used
    const second = i.read("b.ts", "");
    expect(second.ok).toBe(true);
    if (second.ok) {
      // 700 bytes remaining of the 1500 cap; second read truncated to 700
      expect(second.contents.length).toBe(700);
    }
    const third = i.read("c.ts", "");
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error).toMatch(/max bytes/);
  });
});

describe("Inspector — audit trail", () => {
  it("records every attempt including failures, with reason and timestamp", () => {
    fs.writeFileSync(path.join(allowedRoot, "ok.ts"), "ok");
    const i = makeInspector();
    i.read("ok.ts", "first");
    i.read("../escape.ts", "second");
    i.read("missing.ts", "third");
    expect(i.inspected.length).toBe(3);
    expect(i.inspected.map((r) => r.ok)).toEqual([true, false, false]);
    expect(i.inspected.map((r) => r.reason)).toEqual(["first", "second", "third"]);
    for (const r of i.inspected) {
      expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("clamps the reason field at 500 chars", () => {
    fs.writeFileSync(path.join(allowedRoot, "ok.ts"), "ok");
    const i = makeInspector();
    i.read("ok.ts", "x".repeat(2_000));
    expect(i.inspected[0].reason.length).toBe(500);
  });
});

describe("Inspector — public surface", () => {
  it("rootLabels returns basenames, not full paths", () => {
    const i = makeInspector();
    const labels = i.rootLabels();
    expect(labels.length).toBe(1);
    expect(labels[0]).not.toContain(tmpRoot);
    expect(labels[0]).toContain("allowed");
  });

  it("perFileBudget reflects the configured cap", () => {
    const i = makeInspector({ maxBytesPerFile: 1234 });
    expect(i.perFileBudget()).toBe(1234);
  });
});
