import assert from "node:assert/strict";
import { test } from "node:test";

import { changeArgs, findJob, parseCronArgs, renderList, runCron, type CronJob } from "./cron.ts";

const ALLOWED = ["oasis-generation/claude-haiku-4-5", "oasis-generation/claude-sonnet-5-5"];
const JOBS: CronJob[] = [
  { id: "aaaa1111-0000-0000-0000-000000000000", name: "Weather", enabled: true, sessionTarget: "isolated", schedule: { kind: "cron", expr: "0 8 * * *", tz: "America/New_York" }, payload: { kind: "agentTurn", message: "weather" } },
  { id: "bbbb2222-0000-0000-0000-000000000000", name: "Plants", enabled: true, sessionTarget: "main", schedule: { kind: "cron", expr: "0 14 * * 0" }, payload: { kind: "systemEvent", text: "water" } },
  { id: "cccc3333-0000-0000-0000-000000000000", name: "Alpha digest", enabled: false, sessionTarget: "isolated", schedule: { kind: "every", everyMs: 300_000 }, payload: { kind: "agentTurn", message: "digest", model: ALLOWED[0] } },
];

test("parseCronArgs reads the verbs and refuses extra or missing words", () => {
  assert.deepEqual(parseCronArgs(""), { verb: "list" });
  assert.deepEqual(parseCronArgs("model 2 chat"), { verb: "model", ref: "2", model: "chat" });
  assert.deepEqual(parseCronArgs("OFF 1"), { verb: "off", ref: "1" });
  assert.ok("error" in parseCronArgs("model 2"));
  assert.ok("error" in parseCronArgs("run 1 now"));
  assert.ok("error" in parseCronArgs("delete 1"));
});

test("numbers follow the list order (enabled first, then name); an id prefix works too", () => {
  assert.equal((findJob(JOBS, "1") as CronJob).name, "Plants");
  assert.equal((findJob(JOBS, "2") as CronJob).name, "Weather");
  assert.equal((findJob(JOBS, "3") as CronJob).name, "Alpha digest");
  assert.equal((findJob(JOBS, "cccc") as CronJob).name, "Alpha digest");
  assert.ok("error" in findJob(JOBS, "9"));
  assert.ok("error" in findJob(JOBS, "--help"));
  const list = renderList(JOBS, ALLOWED[1], Date.parse("2026-10-25T12:00:00Z"));
  assert.match(list, /1\. on  Plants[\s\S]*model chat model \(claude-sonnet-5-5, main session\)/);
  assert.match(list, /3\. off Alpha digest[\s\S]*every 5 min · model claude-haiku-4-5/);
});

test("changeArgs gives --flag=value argv and keeps main-session jobs on the chat model", () => {
  const weather = JOBS[0];
  assert.deepEqual(changeArgs({ verb: "model", ref: "2", model: "claude-haiku-4-5" }, weather, ALLOWED), ["edit", weather.id, "--model=oasis-generation/claude-haiku-4-5"]);
  assert.deepEqual(changeArgs({ verb: "model", ref: "2", model: "chat" }, weather, ALLOWED), ["edit", weather.id, "--clear-model"]);
  assert.ok("error" in (changeArgs({ verb: "model", ref: "2", model: "openai/gpt-9" }, weather, ALLOWED) as object));
  assert.ok("error" in (changeArgs({ verb: "model", ref: "1", model: "claude-haiku-4-5" }, JOBS[1], ALLOWED) as object));
  assert.deepEqual(changeArgs({ verb: "off", ref: "2" }, weather, ALLOWED), ["edit", weather.id, "--disable"]);
  assert.deepEqual(changeArgs({ verb: "run", ref: "2" }, weather, ALLOWED), ["run", weather.id]);
});

test("runCron lists, changes, and reports an openclaw.json drift", async () => {
  const calls: string[][] = [];
  let fp = "a";
  const deps = {
    cli: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "list") return `Config warnings:\n- x\n${JSON.stringify({ jobs: JOBS })}`;
      if (args.includes("--disable")) fp = "b";
      return "ok";
    },
    models: () => ({ chat: ALLOWED[1], allowed: ALLOWED }),
    configFingerprint: () => fp,
  };
  assert.match(await runCron("", deps), /Cron jobs \(chat model claude-sonnet-5-5\)/);
  assert.equal(await runCron("model 2 claude-haiku-4-5", deps), "✅ Weather: model → claude-haiku-4-5");
  assert.deepEqual(calls.at(-1), ["edit", JOBS[0].id, "--model=oasis-generation/claude-haiku-4-5"]);
  assert.match(await runCron("off 2", deps), /✅ Weather: off\.\n⚠️ openclaw\.json changed/);
  assert.match(await runCron("model 1 claude-haiku-4-5", deps), /main session/);
  assert.match(await runCron("models", deps), /claude-haiku-4-5/);
});
