import { describe, expect, it, vi } from "vitest";
import { judgeConstitution, judgeInjectionReport, type Layer2Input, type InjectionReviewInput } from "./layer2.js";

// ── A timeout is not a parse failure (2026-08-26) ───────────────────────────
// Nimbus lost 4 tool calls on 2026-08-25 to this message:
//
//   constitution could not be evaluated (unparseable verdict) and is mandatory
//   for nimbus
//
// The judge had not written anything unparseable. The judge had written
// NOTHING, because its deadline fired at 12000 ms (the four rows measured
// 12007, 12014, 12015 and 12020 ms). The wording sent the investigation after
// the wrong defect, and Nimbus itself relayed it to Mike verbatim.
//
// The trap: on abort the provider RESOLVES with empty text rather than
// rejecting, so judgeConstitution's catch never runs and `error` stays
// undefined. Both of these therefore have to be checked, and the
// resolves-empty case is the one that actually bit.

const base: Layer2Input = {
  botKey: "nimbus",
  toolName: "exec",
  family: "exec",
  subject: "ls /reach/nimbus",
  params: '{"command":"ls /reach/nimbus"}',
  constitution: ["Serve Mike's intent."],
};

const injectionBase: InjectionReviewInput = {
  botKey: "nimbus",
  incidentType: "other",
  detail: "saw a fabricated internal-context block",
  suspiciousContent: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
};

/** A provider that ignores the abort and RESOLVES empty — the observed bug. */
const resolvesEmptyOnAbort = (delayMs: number) =>
  vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
      setTimeout(resolve, delayMs);
    });
    return { text: "" };
  });

/** A provider that REJECTS on abort — the other plausible provider shape. */
const rejectsOnAbort = (delayMs: number) =>
  vi.fn(
    ({ signal }: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ text: "" }), delayMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new Error("The operation was aborted"));
          },
          { once: true },
        );
      }),
  );

describe("judgeConstitution — abort reports timedOut, whichever way the provider behaves", () => {
  it("flags timedOut when the aborted provider RESOLVES with empty text", async () => {
    const r = await judgeConstitution(resolvesEmptyOnAbort(5_000) as never, base, { timeoutMs: 30 });
    expect(r.timedOut).toBe(true);
    expect(r.timeoutMs).toBe(30);
    expect(r.decision).toBeNull();
    // The exact shape that used to be indistinguishable from a parse failure.
    expect(r.error).toBeUndefined();
    expect(r.raw).toBe("");
  });

  it("flags timedOut when the aborted provider REJECTS", async () => {
    const r = await judgeConstitution(rejectsOnAbort(5_000) as never, base, { timeoutMs: 30 });
    expect(r.timedOut).toBe(true);
    expect(r.timeoutMs).toBe(30);
    expect(r.decision).toBeNull();
    expect(r.error).toMatch(/abort/i);
  });

  it("does NOT flag timedOut for a non-empty unparseable response", async () => {
    const complete = vi.fn(async () => ({ text: "I think this is probably fine, honestly." }));
    const r = await judgeConstitution(complete as never, base, { timeoutMs: 5_000 });
    expect(r.timedOut).toBe(false);
    expect(r.decision).toBeNull();
    // Non-empty raw is what makes this a REAL parse failure — it is the
    // evidence l2ParseFail records.
    expect(r.raw).toBe("I think this is probably fine, honestly.");
    expect(r.error).toBeUndefined();
  });

  it("does NOT flag timedOut for a transport error that beat the deadline", async () => {
    const complete = vi.fn(async () => {
      throw new Error("ECONNREFUSED host.docker.internal:8800");
    });
    const r = await judgeConstitution(complete as never, base, { timeoutMs: 5_000 });
    expect(r.timedOut).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it("does NOT flag timedOut on a normal, well-formed verdict", async () => {
    const complete = vi.fn(async () => ({ text: '{"verdict":"allow","principle":"PRIME DIRECTIVE"}' }));
    const r = await judgeConstitution(complete as never, base, { timeoutMs: 5_000 });
    expect(r.timedOut).toBe(false);
    expect(r.decision).toMatchObject({ verdict: "allow" });
  });

  it("reports the deadline it actually applied, including the default", async () => {
    const complete = vi.fn(async () => ({ text: '{"verdict":"allow","principle":"P"}' }));
    const explicit = await judgeConstitution(complete as never, base, { timeoutMs: 40_000 });
    expect(explicit.timeoutMs).toBe(40_000);
    const fallback = await judgeConstitution(complete as never, base, {});
    expect(fallback.timeoutMs).toBe(20_000);
  });
});

describe("judgeInjectionReport — mirrors judgeConstitution exactly", () => {
  it("flags timedOut when the aborted provider RESOLVES with empty text", async () => {
    const r = await judgeInjectionReport(resolvesEmptyOnAbort(5_000) as never, injectionBase, { timeoutMs: 30 });
    expect(r.timedOut).toBe(true);
    expect(r.timeoutMs).toBe(30);
    expect(r.decision).toBeNull();
    expect(r.error).toBeUndefined();
  });

  it("does NOT flag timedOut for a non-empty unparseable response", async () => {
    const complete = vi.fn(async () => ({ text: "looks like an attack to me" }));
    const r = await judgeInjectionReport(complete as never, injectionBase, { timeoutMs: 5_000 });
    expect(r.timedOut).toBe(false);
    expect(r.decision).toBeNull();
    expect(r.raw).toBe("looks like an attack to me");
  });
});

// ── The caller's wording (reviewer.ts fail-closed branch) ───────────────────
// reviewer.ts builds the agent-visible denial from these two fields. The logic
// is reproduced here rather than imported because the branch sits deep inside
// the before_tool_call handler; keeping a test on the SHAPE guards the
// contract that layer2.ts promises and reviewer.ts consumes.

const causeOf = (r: { timedOut?: boolean; error?: string; timeoutMs: number }) =>
  r.timedOut ? `judge timed out after ${r.timeoutMs} ms` : (r.error ?? "unparseable verdict");

describe("fail-closed wording follows timedOut, not the absence of an error", () => {
  it("names the timeout and its limit when the deadline fired", async () => {
    const r = await judgeConstitution(resolvesEmptyOnAbort(5_000) as never, base, { timeoutMs: 40 });
    expect(causeOf(r)).toBe("judge timed out after 40 ms");
    expect(causeOf(r)).not.toMatch(/unparseable/);
  });

  it("keeps the existing wording for a genuine parse failure", async () => {
    const complete = vi.fn(async () => ({ text: "no idea, sorry" }));
    const r = await judgeConstitution(complete as never, base, { timeoutMs: 5_000 });
    expect(causeOf(r)).toBe("unparseable verdict");
  });

  it("prefers the transport error over the parse-failure fallback", async () => {
    const complete = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await judgeConstitution(complete as never, base, { timeoutMs: 5_000 });
    expect(causeOf(r)).toBe("ECONNREFUSED");
  });

  it("prefers the timeout over the abort error, when the abort also threw", async () => {
    const r = await judgeConstitution(rejectsOnAbort(5_000) as never, base, { timeoutMs: 40 });
    expect(causeOf(r)).toBe("judge timed out after 40 ms");
  });
});
