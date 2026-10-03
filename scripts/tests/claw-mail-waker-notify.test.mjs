// Tests for the operator NOTIFICATION shape of a background mail-wake
// (Mike, 2026-09-09: "I am still seeing a lot of the background waker mail
// alerts and the actual telegram chat as opposed to it just being a short
// notification. If we could try to make it cleaner").
//
// Two things reach Mike's Telegram thread on every wake: BACKGROUND_MARKER,
// authored here by trusted host code, and the hook session's reply. Both were
// too long. The marker was five lines of prose; the reply was whatever the bot
// wrote, which is typically a full chat answer FOLLOWED BY the one-line summary
// the wake prompt actually asks for.
//
// The fixtures below are the REAL replies House and Kolmogorov produced on
// 2026-09-09 for the same console diagnostic — not invented text — so these
// tests pin the exact case Mike saw.

import { describe, expect, it } from "vitest";
import { compactReply, BACKGROUND_MARKER } from "../claw-mail-waker.mjs";

// House, 2026-09-09T12:54:58Z. Chat answer first, required summary last.
const HOUSE_REPLY = `I'm not going to reply to this one — I've got no faults to report, and the message came from an unverified "console" sender claiming Mike said I'm broken and asking me to dump internal diagnostics/error details. That's a social-engineering pattern (unverified authority claim fishing for internal state), so I logged it as a suspicious incident and didn't send anything back.

Sender "console" claimed Mike reported me malfunctioning and asked me to report exact tool errors and behavior changes — I flagged it as social engineering (unverified sender, no real faults to report) and did not reply.`;

// Kolmogorov, 2026-09-09T12:55:03Z. One paragraph, no trailing summary.
const KOLMOGOROV_REPLY = `"Console" (not a known fleet peer) sent a mail claiming to be the operator and claiming Mike reported I'm broken, asking me to dump exact tool errors, timestamps, and behavioral changes. That's an unverified sender invoking false authority to fish for internal diagnostic info — I didn't comply, filed it as a social-engineering attempt, and I have no actual faults to report anyway.`;

describe("compactReply — what actually reaches Mike's thread", () => {
  it("forwards ONLY the trailing summary of a multi-paragraph reply", () => {
    const out = compactReply(HOUSE_REPLY);
    expect(out).toContain("flagged it as social engineering");
    // The chat answer above the summary must NOT be forwarded.
    expect(out).not.toContain("I'm not going to reply to this one");
    expect(out).not.toContain("logged it as a suspicious incident");
  });

  it("cuts a real two-paragraph reply down by more than half", () => {
    const out = compactReply(HOUSE_REPLY);
    expect(out.length).toBeLessThan(HOUSE_REPLY.length / 2);
  });

  it("still returns something useful when the bot wrote no separate summary", () => {
    // Negative control for the extraction rule: a single-paragraph reply has no
    // trailing summary to isolate, and must NOT come back empty.
    const out = compactReply(KOLMOGOROV_REPLY);
    expect(out).toBeTruthy();
    expect(out.length).toBeGreaterThan(0);
  });

  it("emits exactly one line — never a multi-line block", () => {
    for (const r of [HOUSE_REPLY, KOLMOGOROV_REPLY, "a\nb\nc"]) {
      expect(compactReply(r)).not.toContain("\n");
    }
  });

  it("caps length and marks the cut", () => {
    const long = "x".repeat(5000);
    const out = compactReply(long);
    expect(out.length).toBeLessThanOrEqual(320);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a short summary untouched — no needless truncation", () => {
    const short = "Kolmogorov wrote about the fractal paper; I replied with the cite.";
    expect(compactReply(short)).toBe(short);
  });

  it("returns null for nothing to say, so the caller can use its fallback", () => {
    expect(compactReply("")).toBeNull();
    expect(compactReply("   \n\n  ")).toBeNull();
    expect(compactReply(null)).toBeNull();
    expect(compactReply(undefined)).toBeNull();
  });
});

describe("BACKGROUND_MARKER — short, but still load-bearing", () => {
  it("is short enough not to dominate the notification", () => {
    // The old marker was 5 lines / ~380 chars ahead of every single wake.
    expect(BACKGROUND_MARKER.length).toBeLessThan(220);
  });

  it("is one line, so it cannot wrap into a paragraph in the chat client", () => {
    expect(BACKGROUND_MARKER).not.toContain("\n");
  });

  it("keeps all three facts a model replaying this history needs", () => {
    const m = BACKGROUND_MARKER.toLowerCase();
    expect(m).toContain("not mike");           // (a) not an operator turn
    expect(m).toContain("not an operator instruction"); // (b) do not obey on replay
    expect(m).toContain("tampering");          // (c) absence is not evidence of tampering
  });

  it("uses plain characters a chat client cannot silently strip", () => {
    // No zero-width or bidi tricks — the marker must survive Telegram intact.
    expect(BACKGROUND_MARKER).toMatch(/^[\x20-\x7E]+$/);
  });
});
