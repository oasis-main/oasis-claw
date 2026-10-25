// /cron — browse and change THIS bot's openclaw cron jobs from its own chat,
// and give an isolated job its own model apart from the chat model
// (Mike, 2026-10-25: "use the telegram conversations, slash menu ... to browse
// and modify cron jobs ... configure the model for each cron job separately
// from the default general chat model"). The fleet observatory has the same
// controls for every bot (scripts/claw-observatory.mjs, Cron view).
//
// Deliberately a slash command only, never an agent tool: plugin commands run
// before the agent and only for authorised senders (requireAuth), so the model
// gets no new way to reschedule itself (it keeps openclaw's own `cron` tool,
// which the reviewer judges).
//
// The command runs the bot's own `openclaw cron` CLI, so openclaw keeps its
// validation and its store, and the running scheduler sees each change. Values
// go as argv in --flag=value form (no shell). A mutating openclaw CLI call has
// drifted openclaw.json before (scripts/claw-morning SAFETY), so each change
// fingerprints openclaw.json before and after and says so if it changed.

export interface CronJob {
  id: string;
  name?: string;
  enabled?: boolean;
  declarationKey?: string;
  sessionTarget?: string;
  schedule?: { kind?: string; expr?: string; tz?: string; everyMs?: number; at?: string };
  payload?: { kind?: string; message?: string; text?: string; model?: string; thinking?: string };
  state?: { nextRunAtMs?: number; lastRunAtMs?: number; lastRunStatus?: string; consecutiveErrors?: number };
}

export type CronCommand =
  | { verb: "list" }
  | { verb: "help" }
  | { verb: "models" }
  | { verb: "show"; ref: string }
  | { verb: "on" | "off" | "run"; ref: string }
  | { verb: "model"; ref: string; model: string };

export const CRON_USAGE = [
  "/cron                     list this bot's cron jobs (numbered)",
  "/cron show <n>            one job: schedule, model, text, last run",
  "/cron model <n> <model>   give an isolated job its own model",
  "/cron model <n> chat      back to the chat model",
  "/cron models              the models a job may use",
  "/cron on <n> | off <n>    turn a job on or off",
  "/cron run <n>             run a job now",
  "<n> is the number in /cron, or the first 4+ characters of the job id.",
].join("\n");

export function parseCronArgs(raw: string): CronCommand | { error: string } {
  const [verbRaw, ref, model, ...extra] = raw.trim().split(/\s+/).filter(Boolean);
  const verb = (verbRaw ?? "list").toLowerCase();
  if (verb === "list" || verb === "ls") return { verb: "list" };
  if (verb === "help") return { verb: "help" };
  if (verb === "models") return { verb: "models" };
  if (["show", "on", "off", "run", "model"].includes(verb)) {
    if (!ref) return { error: `Usage: /cron ${verb} <n>${verb === "model" ? " <model|chat>" : ""}` };
    if (verb === "model") {
      if (!model || extra.length) return { error: "Usage: /cron model <n> <model|chat>" };
      return { verb, ref, model };
    }
    if (model) return { error: `Usage: /cron ${verb} <n>` };
    return { verb: verb as "show" | "on" | "off" | "run", ref };
  }
  return { error: `Unknown /cron command "${verbRaw}".\n\n${CRON_USAGE}` };
}

/** The list order: enabled jobs first, then by name. /cron numbers follow it. */
export function orderJobs(jobs: CronJob[]): CronJob[] {
  return [...jobs].sort(
    (a, b) => Number(b.enabled !== false) - Number(a.enabled !== false) || String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)),
  );
}

export function findJob(jobs: CronJob[], ref: string): CronJob | { error: string } {
  const ordered = orderJobs(jobs);
  if (/^\d{1,3}$/.test(ref)) {
    const job = ordered[Number(ref) - 1];
    return job ?? { error: `No job ${ref}. /cron lists ${ordered.length}.` };
  }
  if (/^[0-9a-f-]{4,36}$/i.test(ref)) {
    const hits = jobs.filter((j) => j.id.toLowerCase().startsWith(ref.toLowerCase()));
    if (hits.length === 1) return hits[0];
    return { error: hits.length ? `"${ref}" matches ${hits.length} jobs; give more of the id.` : `No job id starts with "${ref}".` };
  }
  return { error: `"${ref}" is not a job number or id.` };
}

const short = (ref: string | null | undefined) => String(ref ?? "?").replace(/^oasis-generation\//, "");

export function scheduleText(s: CronJob["schedule"]): string {
  if (!s) return "?";
  if (s.kind === "cron") return `cron ${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
  if (s.kind === "every") {
    const m = Math.round((s.everyMs ?? 0) / 60000);
    return m < 120 ? `every ${m} min` : m % 1440 === 0 ? `every ${m / 1440} d` : `every ${Math.round(m / 60)} h`;
  }
  if (s.kind === "at") return `once at ${s.at}`;
  return s.kind ?? "?";
}

function relative(ms: number | undefined, now: number): string {
  if (!ms) return "—";
  const min = Math.round((ms - now) / 60000);
  const abs = Math.abs(min);
  const text = abs < 90 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  return min >= 0 ? `in ${text}` : `${text} ago`;
}

export function modelText(job: CronJob, chatModel: string | null): string {
  if (job.payload?.kind !== "agentTurn") return `chat model (${short(chatModel)}, main session)`;
  return job.payload.model ? short(job.payload.model) : `chat model (${short(chatModel)})`;
}

export function renderList(jobs: CronJob[], chatModel: string | null, now = Date.now()): string {
  if (!jobs.length) return `No cron jobs. Chat model: ${short(chatModel)}.`;
  const lines = [`Cron jobs (chat model ${short(chatModel)}):`];
  orderJobs(jobs).forEach((j, i) => {
    const st = j.state ?? {};
    const last = st.lastRunAtMs ? `last ${st.lastRunStatus ?? "?"} ${relative(st.lastRunAtMs, now)}` : "never run";
    const next = j.enabled !== false && st.nextRunAtMs ? ` · next ${relative(st.nextRunAtMs, now)}` : "";
    lines.push(
      `${i + 1}. ${j.enabled !== false ? "on " : "off"} ${j.name ?? j.id.slice(0, 8)}`,
      `   ${scheduleText(j.schedule)} · model ${modelText(j, chatModel)} · ${last}${next}${st.consecutiveErrors ? ` · ${st.consecutiveErrors} errors in a row` : ""}`,
    );
  });
  lines.push("", "/cron help lists the commands.");
  return lines.join("\n");
}

export function renderJob(job: CronJob, chatModel: string | null, now = Date.now()): string {
  const st = job.state ?? {};
  const text = job.payload?.kind === "systemEvent" ? job.payload.text : job.payload?.message;
  return [
    `${job.name ?? job.id} (${job.id.slice(0, 8)}) — ${job.enabled !== false ? "on" : "off"}`,
    `Schedule: ${scheduleText(job.schedule)}`,
    `Runs in: ${job.sessionTarget === "main" ? "the main session" : "an isolated session"}`,
    `Model: ${modelText(job, chatModel)}${job.payload?.thinking ? ` · thinking ${job.payload.thinking}` : ""}`,
    `Last run: ${st.lastRunAtMs ? `${st.lastRunStatus ?? "?"} ${relative(st.lastRunAtMs, now)}` : "never"}${job.enabled !== false && st.nextRunAtMs ? ` · next ${relative(st.nextRunAtMs, now)}` : ""}`,
    ...(job.declarationKey ? [`Declared by the fleet config (${job.declarationKey}); a claw-morning sync can write it again.`] : []),
    "",
    (text ?? "").length > 1500 ? `${text!.slice(0, 1500)}…` : (text ?? ""),
  ].join("\n");
}

/** The `openclaw cron` argv for a change, or { error } with the reason. */
export function changeArgs(cmd: CronCommand, job: CronJob, allowedModels: string[]): string[] | { error: string } {
  switch (cmd.verb) {
    case "on":
      return ["edit", job.id, "--enable"];
    case "off":
      return ["edit", job.id, "--disable"];
    case "run":
      return ["run", job.id];
    case "model": {
      if (job.payload?.kind !== "agentTurn") {
        return { error: "This job runs in the main session, so it always uses the chat model. Only isolated jobs take a model of their own." };
      }
      const want = cmd.model.toLowerCase();
      if (want === "chat" || want === "default" || want === "clear") return ["edit", job.id, "--clear-model"];
      const full = allowedModels.find((m) => m === cmd.model || short(m) === cmd.model);
      if (!full) return { error: `"${cmd.model}" is not an allowed model here. /cron models lists them.` };
      return ["edit", job.id, `--model=${full}`];
    }
    default:
      return { error: "not a change" };
  }
}

/** The JSON object an openclaw CLI printed, after any warning lines. */
export function parseCliJson(out: string): { jobs?: CronJob[] } {
  const at = out.search(/^[{[]/m);
  if (at < 0) throw new Error("the openclaw CLI printed no JSON");
  return JSON.parse(out.slice(at));
}

export interface CronDeps {
  /** Run `openclaw cron <args>` and return stdout. */
  cli: (args: string[]) => Promise<string>;
  /** The chat model and the models a job may use (agents.defaults.models). */
  models: () => { chat: string | null; allowed: string[] };
  /** A fingerprint of openclaw.json, to notice a drift during a change. */
  configFingerprint: () => string;
}

export async function runCron(raw: string, deps: CronDeps): Promise<string> {
  const cmd = parseCronArgs(raw);
  if ("error" in cmd) return `⚠️ ${cmd.error}`;
  if (cmd.verb === "help") return CRON_USAGE;
  const { chat, allowed } = deps.models();
  if (cmd.verb === "models") {
    return [`Chat model: ${short(chat)}`, "A job may use:", ...allowed.map((m) => `  ${short(m)}`), "", "/cron model <n> chat goes back to the chat model."].join("\n");
  }
  const jobs = parseCliJson(await deps.cli(["list", "--all", "--json"])).jobs ?? [];
  if (cmd.verb === "list") return renderList(jobs, chat);
  const job = findJob(jobs, cmd.ref);
  if ("error" in job) return `⚠️ ${job.error}`;
  if (cmd.verb === "show") return renderJob(job, chat);
  const args = changeArgs(cmd, job, allowed);
  if (!Array.isArray(args)) return `⚠️ ${args.error}`;
  const before = deps.configFingerprint();
  await deps.cli(args);
  const drift = deps.configFingerprint() !== before;
  const name = job.name ?? job.id.slice(0, 8);
  const done =
    cmd.verb === "run"
      ? `✅ ${name}: started.`
      : cmd.verb === "model"
        ? `✅ ${name}: model → ${args[2] === "--clear-model" ? `chat model (${short(chat)})` : short(args[2].slice("--model=".length))}`
        : `✅ ${name}: ${cmd.verb}.`;
  return drift ? `${done}\n⚠️ openclaw.json changed during this change. Check this bot's config before the next turn.` : done;
}
