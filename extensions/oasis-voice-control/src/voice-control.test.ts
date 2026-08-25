/**
 * oasis-voice-control tests (CLAW-107 Phase 1).
 *
 * Covers the two things that matter: voice_set must never write a voice that
 * does not resolve, and the chosen voice must live in a side file rather than
 * in openclaw.json.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectableIds } from "./sidecar.js";
import { createVoiceListTool } from "./tools/voice-list.js";
import { createVoiceSetTool } from "./tools/voice-set.js";
import { clearVoiceChoice, overridePath, readVoiceChoice, writeVoiceChoice } from "./voice-state.js";

let home: string;
const sidecar = { endpoint: "http://oasis-voice:8731" };

const VOICES = {
  presets: [
    { voice_id: "piper:en_GB-alan-medium", speakers: [] },
    { voice_id: "piper:en_GB-vctk-medium", speakers: ["p236", "p239"] },
  ],
  cloned: [],
  backend: "piper",
  supports_cloning: false,
};

function mockVoices(body: unknown = VOICES, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })),
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ctl-"));
  process.env.OPENCLAW_HOME = home;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCLAW_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("voice state", () => {
  it("round-trips a choice through the side file", () => {
    expect(readVoiceChoice()).toBeUndefined();
    writeVoiceChoice("piper:en_GB-alan-medium", "2026-08-25T00:00:00Z");
    expect(readVoiceChoice()).toEqual({
      voice_id: "piper:en_GB-alan-medium",
      chosen_at: "2026-08-25T00:00:00Z",
    });
    clearVoiceChoice();
    expect(readVoiceChoice()).toBeUndefined();
  });

  it("writes to a side file and NEVER to openclaw.json", () => {
    // The whole reason this is a file: rewriting openclaw.json under a live
    // gateway kills the next turn with "config changed since last load".
    writeVoiceChoice("piper:en_GB-alan-medium", "2026-08-25T00:00:00Z");
    expect(overridePath()).toBe(path.join(home, "voice-choice.json"));
    expect(fs.existsSync(path.join(home, "openclaw.json"))).toBe(false);
  });

  it("degrades to undefined on a malformed file instead of throwing", () => {
    fs.writeFileSync(path.join(home, "voice-choice.json"), "{not json");
    expect(readVoiceChoice()).toBeUndefined();
  });

  it("leaves no temp file behind", () => {
    writeVoiceChoice("piper:en_GB-alan-medium", "2026-08-25T00:00:00Z");
    expect(fs.readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("selectableIds", () => {
  it("expands a multi-speaker voice and omits its bare form", () => {
    // A multi-speaker model has no meaningful bare identity — offering one
    // would let a caller pick a voice that cannot actually be synthesised.
    expect(selectableIds(VOICES as never)).toEqual([
      "piper:en_GB-alan-medium",
      "piper:en_GB-vctk-medium#p236",
      "piper:en_GB-vctk-medium#p239",
    ]);
  });
});

describe("voice_set", () => {
  it("writes a valid voice", async () => {
    mockVoices();
    const tool = createVoiceSetTool({ sidecar });
    const r = await tool.execute("t", { voice_id: "piper:en_GB-alan-medium" });
    expect(r.content[0].text).toContain("Your voice is now piper:en_GB-alan-medium");
    expect(readVoiceChoice()?.voice_id).toBe("piper:en_GB-alan-medium");
  });

  it("refuses a voice that is not installed and changes nothing", async () => {
    mockVoices();
    const tool = createVoiceSetTool({ sidecar });
    const r = await tool.execute("t", { voice_id: "piper:does-not-exist" });
    expect(r.content[0].text).toContain("is not installed");
    expect(readVoiceChoice()).toBeUndefined();
  });

  it("tells a caller which speakers a multi-speaker voice needs", async () => {
    mockVoices();
    const tool = createVoiceSetTool({ sidecar });
    const r = await tool.execute("t", { voice_id: "piper:en_GB-vctk-medium" });
    expect(r.content[0].text).toContain("needs a speaker");
    expect(r.content[0].text).toContain("piper:en_GB-vctk-medium#p236");
    expect(readVoiceChoice()).toBeUndefined();
  });

  it("accepts a qualified speaker form", async () => {
    mockVoices();
    const tool = createVoiceSetTool({ sidecar });
    await tool.execute("t", { voice_id: "piper:en_GB-vctk-medium#p239" });
    expect(readVoiceChoice()?.voice_id).toBe("piper:en_GB-vctk-medium#p239");
  });

  it("does NOT write when the sidecar is unreachable", async () => {
    // Writing blind would move the failure to synthesis time, far from the typo.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const tool = createVoiceSetTool({ sidecar });
    const r = await tool.execute("t", { voice_id: "piper:en_GB-alan-medium" });
    expect(r.content[0].text).toContain("nothing was changed");
    expect(readVoiceChoice()).toBeUndefined();
  });

  it("preserves an existing choice when a later set is rejected", async () => {
    mockVoices();
    const tool = createVoiceSetTool({ sidecar });
    await tool.execute("t", { voice_id: "piper:en_GB-alan-medium" });
    await tool.execute("t", { voice_id: "piper:nope" });
    expect(readVoiceChoice()?.voice_id).toBe("piper:en_GB-alan-medium");
  });

  it("reset clears the choice", async () => {
    mockVoices();
    const tool = createVoiceSetTool({ sidecar, configuredVoice: "piper:en_GB-aru-medium" });
    await tool.execute("t", { voice_id: "piper:en_GB-alan-medium" });
    const r = await tool.execute("t", { reset: true });
    expect(r.content[0].text).toContain("piper:en_GB-aru-medium");
    expect(readVoiceChoice()).toBeUndefined();
  });

  it("asks for an argument when given neither", async () => {
    mockVoices();
    const tool = createVoiceSetTool({ sidecar });
    const r = await tool.execute("t", {});
    expect(r.content[0].text).toContain("Give a voice_id");
  });

  it("exposes no way to address another bot", () => {
    // Scope guard: one bot setting another's voice would be an impersonation
    // primitive in Mike's own Telegram.
    const props = createVoiceSetTool({ sidecar }).parameters.properties;
    expect(Object.keys(props).sort()).toEqual(["reset", "voice_id"]);
  });
});

describe("voice_list", () => {
  it("reports the operator default when the bot has not chosen", async () => {
    mockVoices();
    const tool = createVoiceListTool({ sidecar, configuredVoice: "piper:en_GB-aru-medium" });
    const text = (await tool.execute()).content[0].text;
    expect(text).toContain("Current voice: piper:en_GB-aru-medium");
    expect(text).toContain("operator default");
  });

  it("reports the bot's own choice once it has one", async () => {
    mockVoices();
    writeVoiceChoice("piper:en_GB-alan-medium", "2026-08-25T00:00:00Z");
    const tool = createVoiceListTool({ sidecar, configuredVoice: "piper:en_GB-aru-medium" });
    const text = (await tool.execute()).content[0].text;
    expect(text).toContain("Current voice: piper:en_GB-alan-medium");
    expect(text).toContain("your own choice");
  });

  it("survives an unreachable sidecar without changing the voice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const tool = createVoiceListTool({ sidecar });
    const text = (await tool.execute()).content[0].text;
    expect(text).toContain("Could not reach the voice service");
    expect(text).toContain("current voice is unaffected");
  });
});
