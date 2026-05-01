import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSleepSchedule, isSleepActive, clearSleepSchedule } from "../schedule.js";
import { createSleepTool } from "../tools/sleep.js";

let tmpDir: string;
let swarmDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-sleep-test-"));
  swarmDir = path.join(tmpDir, ".swarm");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createSleepTool", () => {
  it("returns yielded status with ISO resumeAt", async () => {
    const tool = createSleepTool({ swarmDir });
    const before = Date.now();
    const result = await tool.invoke({ reason: "waiting for Telegram approval", resumeAfterMs: 120_000 });
    const after = Date.now();

    expect(result.status).toBe("yielded");
    const resumeMs = new Date(result.resumeAt).getTime();
    expect(resumeMs).toBeGreaterThanOrEqual(before + 120_000);
    expect(resumeMs).toBeLessThanOrEqual(after + 120_000 + 100);
  });

  it("clamps minimum duration to 60 000 ms", async () => {
    const tool = createSleepTool({ swarmDir });
    const result = await tool.invoke({ reason: "test", resumeAfterMs: 1_000 });
    expect(result.clampedMs).toBe(60_000);
  });

  it("clamps maximum duration to 3 600 000 ms", async () => {
    const tool = createSleepTool({ swarmDir });
    const result = await tool.invoke({ reason: "test", resumeAfterMs: 99_999_999 });
    expect(result.clampedMs).toBe(3_600_000);
  });

  it("writes sleep-schedule.json to swarmDir", async () => {
    const tool = createSleepTool({ swarmDir });
    const result = await tool.invoke({ reason: "polling for webhook", resumeAfterMs: 300_000 });

    expect(result.scheduleWritten).toBe(true);
    const schedulePath = path.join(swarmDir, "sleep-schedule.json");
    expect(fs.existsSync(schedulePath)).toBe(true);

    const schedule = JSON.parse(fs.readFileSync(schedulePath, "utf8"));
    expect(schedule.kind).toBe("SLEEP");
    expect(schedule.reason).toBe("polling for webhook");
    expect(schedule.resumeAfterMs).toBe(300_000);
    expect(new Date(schedule.resumeAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("includes sessionId in schedule and suggestedResumeCommand", async () => {
    const tool = createSleepTool({ swarmDir });
    const result = await tool.invoke({
      reason: "rate limit backoff",
      resumeAfterMs: 60_000,
      sessionId: "abc123",
    });

    expect(result.scheduleWritten).toBe(true);
    const schedule = JSON.parse(
      fs.readFileSync(path.join(swarmDir, "sleep-schedule.json"), "utf8"),
    );
    expect(schedule.suggestedResumeCommand).toContain("abc123");
  });

  it("uses custom resumeCommandTemplate", async () => {
    const tool = createSleepTool({
      swarmDir,
      resumeCommandTemplate: "hyperclaw wake --id {sessionId}",
    });
    await tool.invoke({ reason: "test", resumeAfterMs: 60_000, sessionId: "sess-99" });

    const schedule = JSON.parse(
      fs.readFileSync(path.join(swarmDir, "sleep-schedule.json"), "utf8"),
    );
    expect(schedule.suggestedResumeCommand).toBe("hyperclaw wake --id sess-99");
  });

  it("writes SLEEP event to trail.log", async () => {
    const tool = createSleepTool({ swarmDir });
    await tool.invoke({ reason: "nightly quiet window", resumeAfterMs: 3_600_000 });

    const trailPath = path.join(swarmDir, "trail.log");
    expect(fs.existsSync(trailPath)).toBe(true);
    const events = fs
      .readFileSync(trailPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const sleepEvent = events.find((e) => e.kind === "SLEEP");
    expect(sleepEvent).toBeDefined();
    expect(sleepEvent.reason).toBe("nightly quiet window");
  });

  it("creates swarmDir if it does not exist", async () => {
    const tool = createSleepTool({ swarmDir: path.join(tmpDir, "nested", "dir", ".swarm") });
    const result = await tool.invoke({ reason: "test", resumeAfterMs: 60_000 });
    expect(result.scheduleWritten).toBe(true);
  });
});

describe("sleep schedule helpers", () => {
  it("readSleepSchedule returns null when no file exists", () => {
    expect(readSleepSchedule(swarmDir)).toBeNull();
  });

  it("isSleepActive returns false when no schedule exists", () => {
    expect(isSleepActive(swarmDir)).toBe(false);
  });

  it("isSleepActive returns true for a future resumeAt", async () => {
    const tool = createSleepTool({ swarmDir });
    await tool.invoke({ reason: "test", resumeAfterMs: 3_600_000 });
    expect(isSleepActive(swarmDir)).toBe(true);
  });

  it("clearSleepSchedule removes the file", async () => {
    const tool = createSleepTool({ swarmDir });
    await tool.invoke({ reason: "test", resumeAfterMs: 60_000 });
    expect(isSleepActive(swarmDir)).toBe(true);

    clearSleepSchedule(swarmDir);
    expect(isSleepActive(swarmDir)).toBe(false);
    expect(fs.existsSync(path.join(swarmDir, "sleep-schedule.json"))).toBe(false);
  });
});
