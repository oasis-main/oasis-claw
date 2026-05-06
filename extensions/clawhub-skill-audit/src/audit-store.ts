/**
 * Append-only audit-trail writer + a persistent "already-audited" set keyed by
 * (skillId, contentHash). Mirrors the layout of prompt-injection-reporting's
 * attack-logger: one immutable file per record at
 *   <logDir>/YYYY/MM/DD/<auditId>.json
 *
 * The `seen.json` index is kept separately and is the only mutable file the
 * plugin owns. Losing it just causes redundant audits, not lost trail data.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuditVerdict } from "./auditor.js";
import type { SkillSnapshot } from "./skill-scanner.js";

export type TrailRecord = {
  auditId: string;
  ts: string;
  skillId: string;
  baseDir: string;
  contentHash: string;
  fileCount: number;
  verdict: AuditVerdict;
};

export type AuditStore = {
  hasAudited(snapshot: SkillSnapshot): boolean;
  record(snapshot: SkillSnapshot, verdict: AuditVerdict): TrailRecord;
};

export function createAuditStore(opts: { logDir: string }): AuditStore {
  fs.mkdirSync(opts.logDir, { recursive: true, mode: 0o700 });
  const seenPath = path.join(opts.logDir, "seen.json");
  const seen = loadSeen(seenPath);

  return {
    hasAudited(snapshot) {
      return seen.has(seenKey(snapshot));
    },
    record(snapshot, verdict) {
      const auditId = crypto.randomUUID();
      const ts = new Date().toISOString();
      const record: TrailRecord = {
        auditId,
        ts,
        skillId: snapshot.skillId,
        baseDir: snapshot.baseDir,
        contentHash: snapshot.contentHash,
        fileCount: snapshot.files.length,
        verdict,
      };

      const filePath = resolveTrailPath(opts.logDir, ts, auditId);
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });

      seen.add(seenKey(snapshot));
      persistSeen(seenPath, seen);
      return record;
    },
  };
}

function seenKey(s: SkillSnapshot): string {
  return `${s.skillId}@${s.contentHash}`;
}

function resolveTrailPath(logDir: string, ts: string, auditId: string): string {
  const d = new Date(ts);
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return path.join(logDir, year, month, day, `${auditId}.json`);
}

function loadSeen(p: string): Set<string> {
  try {
    const raw = fs.readFileSync(p, "utf8");
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) {
      return new Set(arr.filter((x): x is string => typeof x === "string"));
    }
  } catch {
    /* fresh start */
  }
  return new Set();
}

function persistSeen(p: string, seen: Set<string>): void {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...seen].sort()) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}
