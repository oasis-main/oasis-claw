// Grant notices by fleet mail (CLAW-123, Mike 2026-10-15: "make sure new
// permission grants get sent as mail to the relevant set of bots so I don't
// have to follow up asking them to check the grant ledger").
//
// The autoreviewer bot is a mail sender named "autoreviewer". It writes
// envelopes into its own outbox (the only part of the mail tree it mounts);
// the host relay stamps `from`, checks the route, and delivers. Each notice
// goes on a fresh thread `grant-<id>`, so it never uses a work thread's hop
// budget. A notice INFORMS; it is not authorization. A grantee still sees the
// grant as VERIFIED only when the ledger confirms it on the work message.

import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outcomeLine, utc } from "./cards.mjs";

const SUBJECT_MAX = 200;

export class Mailer {
  /**
   * @param {object} o
   * @param {string|null} o.outbox   the autoreviewer's outbox dir; null = mail off
   * @param {(row: object) => void} [o.log]
   * @param {() => number} [o.now]
   */
  constructor({ outbox, log = () => {}, now = Date.now }) {
    this.outbox = outbox;
    this.log = log;
    this.now = now;
  }

  /** Same envelope shape as scripts/claw-mail.mjs (protocol v1). Never throws. */
  send({ to, subject, body, thread, items = [] }) {
    if (!this.outbox || !to.length) return null;
    const env = {
      id: "m_" + randomBytes(12).toString("hex"),
      to: [...new Set(to)].slice(0, 8),
      kind: "dm",
      subject: String(subject).slice(0, SUBJECT_MAX),
      body: String(body),
      refs: [],
      work: { items, repos: [] },
      thread_id: thread,
      ts: new Date(this.now()).toISOString(),
    };
    try {
      mkdirSync(this.outbox, { recursive: true });
      const tmp = join(this.outbox, `.${env.id}.json.tmp`);
      writeFileSync(tmp, JSON.stringify(env, null, 2));
      renameSync(tmp, join(this.outbox, `${env.id}.json`));
      this.log({ event: "notice_queued", id: env.id, to: env.to, thread });
      return env.id;
    } catch (err) {
      this.log({ event: "notice_failed", to, thread, error: String(err.message ?? err) });
      return null;
    }
  }
}

function limits(g) {
  const parts = [];
  if (g.families) parts.push(`tool families: ${g.families.join(", ")}`);
  if (g.path_prefixes) parts.push(`paths under: ${g.path_prefixes.join(", ")}`);
  if (g.max_actions) parts.push(`at most ${g.max_actions} approval-needing actions each`);
  return parts.length ? parts.join("; ") : "none beyond the topic and intent";
}

/** Who gets told, and what, when a peer grant changes state. */
export function grantNotices(g) {
  const head = `${g.id} (thread "${g.thread_id}", topic: ${g.topic})`;
  const footer =
    "This notice is information from the autoreviewer bot, not an authorization by itself. " +
    "The grant counts only where reach_read shows VERIFIED GRANT on the work message. Playbook: /reach/fleet/PLAYBOOK.md section 2.";
  switch (g.status) {
    case "active":
      return [
        {
          to: [g.requester],
          subject: `Grant approved: ${g.id} until ${utc(g.expires)}`,
          body:
            `Mike approved your grant ${head} until ${utc(g.expires)}.\n` +
            `Grantees: ${g.grantees.join(", ")}. Limits: ${limits(g)}.\n\n` +
            `Next: send the work with reach_send, thread_id "${g.thread_id}" and grant_id "${g.id}".\n\n${footer}`,
        },
        {
          to: g.grantees,
          subject: `You are a grantee of ${g.id} (from ${g.requester}) until ${utc(g.expires)}`,
          body:
            `Mike approved ${g.requester}'s grant ${head} until ${utc(g.expires)}. You are a grantee.\n` +
            `Approved intent: ${g.intent}\nLimits: ${limits(g)}.\n\n` +
            `Expect work from ${g.requester} on thread "${g.thread_id}". Work inside that topic and intent needs no further approval from Mike. ` +
            `Reply on that thread WITHOUT grant_id.\n\n${footer}`,
        },
      ];
    case "denied":
    case "lapsed":
      return [{ to: [g.requester], subject: `Grant ${g.status}: ${g.id}`, body: `${outcomeLine(g)} ${head}. No grant applies; ask Mike directly if the work is still needed.` }];
    case "revoked":
      return [{ to: [g.requester, ...g.grantees], subject: `Grant revoked: ${g.id}`, body: `${outcomeLine(g)} ${head}. Stop work that relied on it; anything further needs Mike.` }];
    default:
      return [];
  }
}

/** Who gets told when a GitHub access request is decided or revoked. */
export function githubNotices(r) {
  const what = `${r.access} on ${r.account}: ${r.repos.join(", ")}`;
  switch (r.status) {
    case "approved":
      return [
        { to: [r.requester], subject: `GitHub access approved: ${r.id} for ${r.bot}`, body: `Mike approved ${r.id}: ${r.bot} gets ${what}. The Mac minter applies it within 30 minutes; GET /v1/github-grants/${r.id} shows the result.` },
        { to: [r.bot], subject: `GitHub access approved for you: ${what}`, body: `Mike approved ${r.id} (requested by ${r.requester}): you get ${what}. It is live within 30 minutes, when the minter next runs. git then uses it automatically; 'gh auth status' stays empty by design.` },
      ];
    case "denied":
      return [{ to: [r.requester], subject: `GitHub access denied: ${r.id}`, body: `Mike denied ${r.id} (${r.bot}, ${what}).` }];
    case "revoked":
      return [{ to: [r.requester, r.bot], subject: `GitHub access revoked: ${r.id}`, body: `${r.id} (${r.bot}, ${what}) was revoked. The minter drops it on its next run; a live token can last up to 1 hour more.` }];
    default:
      return [];
  }
}

/** CLAW-124: who hears about a directive. */
export function directiveNotices(d, coordinator) {
  const bot = d.grantees[0];
  const to = [bot, ...(coordinator && coordinator !== bot ? [coordinator] : [])];
  const head = `${d.id} for ${bot}${d.lane ? ` (${d.lane})` : ""}`;
  switch (d.status) {
    case "active":
      return [{
        to,
        subject: `Standing directive ${d.status}: ${head} until ${utc(d.expires)}`,
        body:
          `Mike approved a standing directive ${head} until ${utc(d.expires)}.\n` +
          `Goal: ${d.topic}\nMay: ${d.intent}\nMust not: ${d.must_not}\n\n` +
          `It covers ${bot}'s own work in any session (attended, morning cron, heartbeat, mail-woken) inside "may", ` +
          `and the reviewer checks every call against it. It never covers deletes, data out, infra, money or trades. ` +
          `Put anything outside it under NEEDS FROM MIKE in your STATUS.md.`,
      }];
    case "revoked":
    case "expired":
      return [{ to, subject: `Standing directive ${d.status}: ${head}`, body: `${head} is ${d.status}. Work it covered now needs Mike again (or a new directive).` }];
    default:
      return [];
  }
}
