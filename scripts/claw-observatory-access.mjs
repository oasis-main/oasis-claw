// ── claw-observatory-access: the Access view (Mike, 2026-11-02) ──────────────
// Step 2 of the identity plan: per bot, which permission level it runs at,
// its exec, reviewer, decider and sandbox settings, its tool surface, every
// mount, and a drift list where role.yaml, the container and the live config
// do not agree. This module ONLY READS (phase 1 of the access design). The
// phase 2 edits (a tool in role.yaml, a reviewer write root; a restart
// applies them) are in claw-observatory-access-edit.mjs, where a widening is
// signed by Mike's root key first. Phase 3 (recreate) comes later.
//
// SOURCES (all reads):
//   - `docker inspect` from the observatory's cache: the mounts, and ONLY the
//     environment names in ACCESS_ENV. The rest of a bot's environment holds
//     tokens and never leaves this module.
//   - collectAccessConfig (node, inside the bot, like every collector): a few
//     keys of openclaw.json and exec-approvals.json, and the dates of the
//     persona lock (scripts/persona-check.mjs). No file content beyond those.
//   - ROLE_PY (python3 + PyYAML inside the bot: the entrypoint's own role
//     compiler needs them, so the parse matches what the boot compiles):
//     role.yaml phase, tools, exec counts and reach.
//   - the reviewer policy JSON on the Mac: the host source of the bot's
//     /app/extensions/oasis-reviewer/policy/reviewer-policy.json bind.
//
// Loaded only by `serve` (dynamic import), so the snapshot copy of
// claw-observatory.mjs stays free of static local imports.

import fs from "node:fs";
import path from "node:path";

export const POLICY_MOUNT = "/app/extensions/oasis-reviewer/policy/reviewer-policy.json";
export const ROLE_MOUNT = "/app/role.yaml";

// The environment names this view may read. Values of these are settings,
// not secrets. Never widen this to a pattern: OASIS_* also holds tokens.
export const ACCESS_ENV = [
  "OASIS_AGENT_NAME",
  "OASIS_EXEC_SECURITY",
  "OASIS_EXEC_MODE",
  "OASIS_EXEC_ASK",
  "OASIS_EXEC_ASK_FALLBACK",
  "OASIS_REVIEWER_MODE",
  "OASIS_REVIEWER_L2",
  "OASIS_REVIEWER_DECIDER",
  "OASIS_REVIEWER_MAIL_WAKE_REQUIRES_GRANT",
  "OASIS_SANDBOX_SSH_SOCKET",
  "OASIS_TOOLS_ALSO_ALLOW",
  "OASIS_PERSONA_CHECK",
  "OASIS_PERSONA_DRIFT",
];

export function accessEnv(inspect) {
  const allowed = new Set(ACCESS_ENV);
  const env = {};
  for (const entry of inspect?.Config?.Env ?? []) {
    const i = entry.indexOf("=");
    if (i > 0 && allowed.has(entry.slice(0, i))) env[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return env;
}

// ── collectors (run INSIDE a bot container; self-contained by design) ────────

export function collectAccessConfig(fs, path, home) {
  const readJson = (p, max) => {
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.size > max) return { error: "not a regular file, or too large" };
      return { value: JSON.parse(fs.readFileSync(p, "utf8")) };
    } catch (e) {
      return { error: e && e.code === "ENOENT" ? "missing" : "unreadable" };
    }
  };
  const str = (v) => (typeof v === "string" ? v : null);
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const cfg = readJson(path.join(home, "openclaw.json"), 4 * 1024 * 1024);
  const c = cfg.value || {};
  const d = (c.agents && c.agents.defaults) || {};
  const sb = d.sandbox || {};
  const ex = (c.tools && c.tools.exec) || {};
  const ea = readJson(path.join(home, "exec-approvals.json"), 4 * 1024 * 1024);
  const eaDef = (ea.value && ea.value.defaults) || {};
  const main = ea.value && ea.value.agents && ea.value.agents.main;
  const lock = readJson(path.join(home, "persona.lock.json"), 256 * 1024);
  const history = lock.value && Array.isArray(lock.value.history) ? lock.value.history : [];
  const last = history.length ? history[history.length - 1] : null;
  return {
    config: cfg.error
      ? { error: cfg.error }
      : {
          toolsProfile: str(c.tools && c.tools.profile),
          alsoAllow: list(c.tools && c.tools.alsoAllow),
          execMode: str(ex.mode),
          sandbox: { mode: str(sb.mode), backend: str(sb.backend), scope: str(sb.scope), workspaceAccess: str(sb.workspaceAccess) },
          skipBootstrap: d.skipBootstrap === true,
        },
    approvals: ea.error
      ? { error: ea.error }
      : {
          security: str(eaDef.security),
          ask: str(eaDef.ask),
          askFallback: str(eaDef.askFallback),
          allowlist: Array.isArray(main && main.allowlist) ? main.allowlist.length : 0,
        },
    persona: lock.error
      ? { error: lock.error }
      : {
          pinnedAt: str(lock.value.pinnedAt),
          files: lock.value.files && typeof lock.value.files === "object" ? Object.keys(lock.value.files).length : 0,
          changes: history.length,
          lastChange: last ? { at: str(last.at), file: str(last.file) } : null,
        },
  };
}

// role.yaml through the same PyYAML the entrypoint's compile-role.py uses.
// Run as `python3 -c ROLE_PY /app/role.yaml`; it prints one JSON object.
export const ROLE_PY = String.raw`
import json, sys
def done(obj):
    print(json.dumps(obj))
    sys.exit(0)
try:
    import yaml
except Exception:
    done({"error": "python3-yaml is not in this image"})
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        raw = fh.read(512 * 1024 + 1)
    if len(raw) > 512 * 1024:
        done({"error": "role.yaml is larger than 512 KB"})
    data = yaml.safe_load(raw)
except Exception as e:
    done({"error": "role.yaml does not parse (" + type(e).__name__ + ")"})
if not isinstance(data, dict):
    done({"error": "role.yaml is not a mapping"})
def s(v):
    return str(v).strip() if v is not None else ""
def sub(key):
    v = data.get(key)
    return v if isinstance(v, dict) else {}
tools, ex, reach = sub("tools"), sub("exec"), sub("reach")
reads = []
for r in reach.get("read") or []:
    if isinstance(r, dict) and s(r.get("host")) and s(r.get("at")):
        reads.append({"host": s(r["host"]), "at": s(r["at"]), "mode": "rw" if s(r.get("mode") or "ro").lower() == "rw" else "ro"})
vols = []
for w in reach.get("write_volumes") or []:
    if isinstance(w, dict) and s(w.get("name")) and s(w.get("at")):
        vols.append({"name": s(w["name"]), "at": s(w["at"])})
also = tools.get("alsoAllow")
allow = ex.get("allow")
dormant = ex.get("dormant")
done({
    "role": s(data.get("role")) or None,
    "phase": s(data.get("phase")) or None,
    "tools": {"profile": s(tools.get("profile")) or None, "alsoAllow": [str(x) for x in also] if isinstance(also, list) else []},
    "exec": {"allow": len(allow) if isinstance(allow, list) else 0, "dormantTiers": sorted(str(k) for k in dormant) if isinstance(dormant, dict) else []},
    "reach": {"read": reads, "writeVolumes": vols},
})
`;

// ── the reviewer policy (a host file) ────────────────────────────────────────

export function readPolicyFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The reviewer's own key rule (extensions/oasis-reviewer/src/policy.ts botKeyFor). */
export function policyKey(agentName, policy) {
  const name = String(agentName ?? "");
  return policy?.botAliases?.[name] ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ── levels ───────────────────────────────────────────────────────────────────
// The three levels that run today (design notes §1.1):
//   A  reviewer-gated full exec: security=full, mode=full, ask=off, reviewer
//      and Layer 2 enforce
//   B  A that fails closed (policy constitutionalReviewRequired)
//   C  allowlist exec through the SSH exec sandbox

export const LEVELS = {
  A: "Reviewer-gated full exec",
  B: "Reviewer-gated full exec that fails closed",
  C: "Allowlist exec in the SSH exec sandbox",
  custom: "Custom (not one of the named levels)",
};

export function accessLevel(env, failClosed) {
  const sec = env.OASIS_EXEC_SECURITY || null;
  if (sec === "allowlist" && env.OASIS_SANDBOX_SSH_SOCKET) return { id: "C", label: LEVELS.C, gaps: [] };
  const gaps = [];
  const want = (name, value, label) => {
    if ((env[name] || null) !== value) gaps.push(`${label} is ${env[name] || "not set"}, not ${value}`);
  };
  want("OASIS_EXEC_SECURITY", "full", "exec security");
  want("OASIS_EXEC_MODE", "full", "exec mode");
  want("OASIS_EXEC_ASK", "off", "exec ask");
  want("OASIS_REVIEWER_MODE", "enforce", "reviewer mode");
  want("OASIS_REVIEWER_L2", "enforce", "Layer 2");
  if (gaps.length) return { id: "custom", label: LEVELS.custom, gaps };
  return failClosed ? { id: "B", label: LEVELS.B, gaps: [] } : { id: "A", label: LEVELS.A, gaps: [] };
}

// ── mounts ───────────────────────────────────────────────────────────────────

const MOUNT_KINDS = [
  [/^\/home\/node\/\.openclaw$/, "bot home"],
  [/^\/reach\/mail(\/|$)/, "mail"],
  [/^\/app\/extensions\/oasis-reviewer\/policy\//, "reviewer policy"],
  [/^\/app\/role\.yaml$/, "role.yaml"],
  [/^\/run\/oasis-gh(\/|$)/, "GitHub token"],
  [/^\/reach\/approvals(\/|$)/, "approvals"],
  [/^\/reach\/fleet(\/|$)/, "fleet board"],
  [/^\/reach\/authority(\/|$)/, "authority view"],
];

const hostOf = (mount) => String(mount?.Source ?? "").replace(/^\/host_mnt(?=\/)/, "");
const trimSlash = (p) => String(p ?? "").replace(/\/+$/, "") || "/";
const under = (p, root) => !!root && (p === root || p.startsWith(`${root}/`));

/** What one mount is, and the flags of the phase 3 refusal list (§1.3). */
export function classifyMount(mount, { home, repoRoot } = {}) {
  const at = trimSlash(mount?.Destination);
  const type = mount?.Type === "volume" ? "volume" : mount?.Type === "bind" ? "bind" : String(mount?.Type ?? "other");
  const host = type === "volume" ? String(mount?.Name ?? "") : hostOf(mount);
  const mode = mount?.RW === false ? "ro" : "rw";
  const kind = MOUNT_KINDS.find(([re]) => re.test(at))?.[1] ?? (type === "volume" ? "volume" : "project");
  const flags = [];
  // The fleet's own plumbing (home, mail, policy, role.yaml, GitHub token,
  // approvals, fleet board, authority view) lives in these places by design:
  // no flag.
  if (type === "bind" && kind === "project") {
    // The repo's .swarm/ is a work board that bots share, not the control plane.
    if (repoRoot && under(host, repoRoot) && !under(host, path.join(repoRoot, ".swarm"))) flags.push("oasis-claw control plane");
    if (/(^|\/)\.claw-mail(\/|$)/.test(host) && kind !== "mail") flags.push(".claw-mail");
    if (home && under(host, path.join(home, ".ssh"))) flags.push("~/.ssh");
    if (home && host.startsWith(path.join(home, ".aws"))) flags.push("~/.aws");
    if (home && under(host, path.join(home, "Library"))) flags.push("~/Library");
  }
  return { at, host, type, mode, kind, flags };
}

// ── drift ────────────────────────────────────────────────────────────────────

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

export function accessDrift({ env, live, declared, mounts, level }) {
  const drift = [];
  const add = (severity, area, text) => drift.push({ severity, area, text });
  const cfg = live?.config && !live.config.error ? live.config : null;
  const security = env.OASIS_EXEC_SECURITY || null;

  if (level.id === "custom") add("warn", "level", `Not a named level: ${level.gaps.join("; ")}.`);
  if (security === "full" && env.OASIS_REVIEWER_MODE !== "enforce") {
    add("risk", "level", "Full exec without an enforcing reviewer: no gate stops a command.");
  }
  const decider = env.OASIS_REVIEWER_DECIDER || "off";
  if (!["off", "shadow"].includes(decider)) add("warn", "decider", `Unknown decider mode "${decider}": the reviewer accepts only off or shadow.`);

  if (declared && !declared.error && cfg) {
    const want = declared.tools.profile;
    if (want && cfg.toolsProfile !== want) {
      add("warn", "tools", `role.yaml sets tools.profile ${want}; the running config has ${cfg.toolsProfile ?? "none"}. A restart applies role.yaml.`);
    }
    const missing = declared.tools.alsoAllow.filter((t) => !cfg.alsoAllow.includes(t));
    if (missing.length) add("warn", "tools", `role.yaml allows ${missing.join(", ")}; the running config does not. A restart applies role.yaml.`);
  }
  if (!declared && env.OASIS_TOOLS_ALSO_ALLOW && cfg) {
    const want = env.OASIS_TOOLS_ALSO_ALLOW.split(",").map((t) => t.trim()).filter(Boolean);
    const missing = want.filter((t) => !cfg.alsoAllow.includes(t));
    if (missing.length) add("warn", "tools", `OASIS_TOOLS_ALSO_ALLOW allows ${missing.join(", ")}; the running config does not.`);
  }
  if (declared && !declared.error && declared.exec.allow > 0 && security === "full") {
    add("info", "exec", `role.yaml lists ${declared.exec.allow} exec.allow patterns, but the bot runs security=full, so the list has no effect.`);
  }
  const ap = live?.approvals && !live.approvals.error ? live.approvals : null;
  if (ap && security && ap.security && ap.security !== security) {
    add("warn", "exec", `exec-approvals.json has security=${ap.security}; the container sets ${security}. The next boot writes ${security}.`);
  }

  if (declared && !declared.error) {
    const byAt = new Map(mounts.map((m) => [m.at, m]));
    for (const r of declared.reach.read) {
      const m = byAt.get(trimSlash(r.at));
      if (!m) {
        add("warn", "mount", `role.yaml declares ${r.at} (${r.host}), but the container does not mount it.`);
        continue;
      }
      if (m.mode === "rw" && r.mode === "ro") add("risk", "mount", `${r.at} is read-write in the container; role.yaml declares read-only.`);
      else if (m.mode === "ro" && r.mode === "rw") add("info", "mount", `${r.at} is read-only in the container; role.yaml declares read-write.`);
      if (m.type === "bind" && trimSlash(m.host) !== trimSlash(r.host)) add("warn", "mount", `${r.at} comes from ${m.host}; role.yaml declares ${r.host}.`);
    }
    for (const w of declared.reach.writeVolumes) {
      const m = byAt.get(trimSlash(w.at));
      if (!m) add("warn", "mount", `role.yaml declares the volume ${w.name} at ${w.at}, but the container does not mount it.`);
      else if (m.type !== "volume") add("warn", "mount", `${w.at} is a ${m.type} mount; role.yaml declares a container-only volume.`);
    }
  }
  for (const m of mounts) {
    if (m.flags.length && m.mode === "rw") add("risk", "mount", `${m.at} is read-write and comes from a protected place (${m.flags.join(", ")}).`);
  }

  const persona = live?.persona;
  const active = cfg?.skipBootstrap === true || !!(persona && !persona.error);
  if (cfg && !active) {
    add("info", "persona", "The persona boot check is not in this image yet: openclaw can still write its stock templates into a workspace that lost its files.");
  } else if (active) {
    if (persona?.error) add("warn", "persona", `persona.lock.json is ${persona.error}: the boot check pins the persona on the next clean boot.`);
    if (cfg && !cfg.skipBootstrap) add("warn", "persona", "skipBootstrap is off: openclaw can write its stock templates into a workspace that lost its files.");
  }
  return drift;
}

// ── one bot ──────────────────────────────────────────────────────────────────

export function describeAccess({ bot, inspect, live = null, declared = null, policy = null, home, repoRoot }) {
  const env = accessEnv(inspect);
  const key = policyKey(env.OASIS_AGENT_NAME, policy);
  const perBot = policy?.hard?.per_bot?.[key] ?? null;
  const failClosed = perBot?.constitutionalReviewRequired === true;
  const level = accessLevel(env, failClosed);
  const hasRole = (inspect?.Mounts ?? []).some((m) => trimSlash(m.Destination) === ROLE_MOUNT);
  const declaredAt = new Set();
  if (declared && !declared.error) {
    for (const r of declared.reach.read) declaredAt.add(trimSlash(r.at));
    for (const w of declared.reach.writeVolumes) declaredAt.add(trimSlash(w.at));
  }
  const mounts = (inspect?.Mounts ?? [])
    .map((m) => classifyMount(m, { home, repoRoot }))
    .map((m) => ({ ...m, declared: m.kind === "project" || m.kind === "volume" ? (hasRole ? declaredAt.has(m.at) : null) : null }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const cfg = live?.config && !live.config.error ? live.config : null;
  const errors = [live?.config?.error && `openclaw.json: ${live.config.error}`, live?.error, declared?.error && `role.yaml: ${declared.error}`].filter(Boolean);
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return {
    key: bot.key,
    container: bot.container,
    agentName: env.OASIS_AGENT_NAME || null,
    running: !!bot.running,
    state: bot.state,
    level,
    exec: {
      security: env.OASIS_EXEC_SECURITY || null,
      mode: env.OASIS_EXEC_MODE || null,
      ask: env.OASIS_EXEC_ASK || null,
      askFallback: env.OASIS_EXEC_ASK_FALLBACK || null,
      configMode: cfg?.execMode ?? null,
      approvals: live?.approvals ?? null,
    },
    reviewer: {
      mode: env.OASIS_REVIEWER_MODE || null,
      l2: env.OASIS_REVIEWER_L2 || null,
      failClosed,
      mailWakeNeedsGrant: env.OASIS_REVIEWER_MAIL_WAKE_REQUIRES_GRANT === "1",
      policyKey: perBot ? key : null,
      writeRoots: list(perBot?.allowWriteRoots),
    },
    decider: { mode: env.OASIS_REVIEWER_DECIDER || "off", enforceAvailable: false },
    sandbox: { ssh: !!env.OASIS_SANDBOX_SSH_SOCKET, ...(cfg?.sandbox ?? {}) },
    tools: {
      declared: declared && !declared.error ? declared.tools : env.OASIS_TOOLS_ALSO_ALLOW ? { profile: null, alsoAllow: env.OASIS_TOOLS_ALSO_ALLOW.split(",").map((t) => t.trim()).filter(Boolean), source: "env" } : null,
      live: cfg ? { profile: cfg.toolsProfile, alsoAllow: cfg.alsoAllow } : null,
    },
    role: hasRole ? (declared?.error ? { present: true, error: declared.error } : { present: true, name: declared?.role ?? null, phase: declared?.phase ?? null, dormantTiers: declared?.exec?.dormantTiers ?? [] }) : { present: false },
    persona: {
      // The check exists from the image of PR #4 on. That boot sets
      // skipBootstrap and, on a clean persona, writes the lock.
      active: cfg?.skipBootstrap === true || !!(live?.persona && !live.persona.error),
      check: env.OASIS_PERSONA_CHECK || "enforce",
      drift: env.OASIS_PERSONA_DRIFT || "warn",
      skipBootstrap: cfg ? cfg.skipBootstrap : null,
      lock: live?.persona && !live.persona.error ? live.persona : null,
    },
    mounts,
    drift: bot.running ? accessDrift({ env, live, declared, mounts, level }) : [],
    errors,
  };
}
