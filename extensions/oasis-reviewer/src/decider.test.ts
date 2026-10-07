import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  decide,
  deciderModeFrom,
  injectionState,
  INJECTION_QUESTIONS,
  summarize,
  toolCallState,
  TOOL_CALL_QUESTIONS,
} from "./decider.js";

// CLAW-118: the decider is SHADOW-only. These tests pin the two properties the
// shadow depends on: the client never throws (a dead sidecar costs a log row,
// never a tool call), and the questions stay inside Laya's limits.

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  return new Promise((r) => server!.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`)));
}

describe("deciderModeFrom", () => {
  it("is off unless explicitly shadow", () => {
    expect(deciderModeFrom(undefined)).toBe("off");
    expect(deciderModeFrom("enforce")).toBe("off"); // no enforce mode exists
    expect(deciderModeFrom("SHADOW")).toBe("shadow");
  });
});

describe("question schemas", () => {
  for (const [name, qs] of Object.entries({ TOOL_CALL_QUESTIONS, INJECTION_QUESTIONS })) {
    it(`${name} stays inside the sidecar's limits`, () => {
      const entries = Object.entries(qs);
      expect(entries.length).toBeLessThanOrEqual(8);
      expect(qs.verdict.type).toBe("choice");
      for (const [, q] of entries) {
        expect(q.instructions.length).toBeGreaterThan(0);
        if (q.type === "choice") expect(Object.keys(q.criteria as object).length).toBeLessThanOrEqual(20);
        if (q.type === "score") expect((q.criteria as string[]).length).toBeGreaterThanOrEqual(2);
      }
    });
  }

  it("tool-call verdict options mirror Layer 2", () => {
    expect(Object.keys(TOOL_CALL_QUESTIONS.verdict.criteria as object).sort()).toEqual(["allow", "deny", "escalate"]);
  });
});

describe("state builders", () => {
  it("clips long fields so the state fits the 1024-token context", () => {
    const s = toolCallState({
      botKey: "house",
      toolName: "exec",
      family: "exec",
      subject: "x".repeat(5000),
      params: "p".repeat(50_000),
      operatorRequest: "r".repeat(50_000),
    });
    expect(JSON.stringify(s).length).toBeLessThan(3000);
    expect(s.params.endsWith("…")).toBe(true);
  });

  it("marks missing operator context explicitly", () => {
    expect(toolCallState({ botKey: "b", toolName: "t", family: "f", subject: "", params: "" }).operator_request).toBe(
      "(none captured)",
    );
    expect(injectionState({ botKey: "b", incidentType: "i", detail: "", suspiciousContent: "" }).detail).toBe("(none)");
  });
});

describe("decide", () => {
  it("round-trips answers and never routes through a proxy env", async () => {
    process.env.HTTP_PROXY = "http://127.0.0.1:9"; // would fail if honoured
    try {
      let seen: unknown;
      const url = await serve((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          seen = JSON.parse(b);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ answers: { verdict: { type: "choice", choice: "allow", probabilities: { allow: 0.9 } } }, ms: 40, model: "m", revision: "r" }));
        });
      });
      const r = await decide(url, { bot: "b" }, TOOL_CALL_QUESTIONS, 2000);
      expect(r.error).toBeUndefined();
      expect(r.answers?.verdict.choice).toBe("allow");
      expect(r.modelMs).toBe(40);
      expect((seen as { questions: object }).questions).toEqual(TOOL_CALL_QUESTIONS);
    } finally {
      delete process.env.HTTP_PROXY;
    }
  });

  it("reports a non-200 as an error, not answers", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "questions must be a non-empty object" }));
    });
    const r = await decide(url, {}, {}, 2000);
    expect(r.answers).toBeNull();
    expect(r.error).toContain("HTTP 400");
  });

  it("times out without throwing and says so", async () => {
    const url = await serve(() => {
      /* never answers */
    });
    const r = await decide(url, { bot: "b" }, TOOL_CALL_QUESTIONS, 100);
    expect(r.answers).toBeNull();
    expect(r.timedOut).toBe(true);
  });

  it("survives an unreachable sidecar and a bad url", async () => {
    const dead = await decide("http://127.0.0.1:1", { bot: "b" }, TOOL_CALL_QUESTIONS, 1000);
    expect(dead.answers).toBeNull();
    expect(dead.error).toBeTruthy();
    const bad = await decide("not a url", { bot: "b" }, TOOL_CALL_QUESTIONS, 1000);
    expect(bad.error).toContain("bad decider url");
  });
});

describe("summarize", () => {
  it("flattens the verdict and one number per other question", () => {
    const s = summarize({
      verdict: { type: "choice", choice: "escalate", probabilities: { allow: 0.2, deny: 0.1, escalate: 0.7 }, answer_confidence: 0.66 },
      beyond_request: { type: "noul", noul: 0.81 },
      risk: { type: "score", score: 2.1 },
    });
    expect(s).toMatchObject({ decVerdict: "escalate", decVerdictP: 0.7, decVerdictConfidence: 0.66, dec_beyond_request: 0.81, dec_risk: 2.1 });
  });

  it("null answers give a null verdict", () => {
    expect(summarize(null)).toEqual({ decVerdict: null });
  });
});
