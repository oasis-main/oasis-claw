/**
 * Type-only stub for openclaw/plugin-sdk/skills-runtime.
 *
 * The real implementation lives in vendor/openclaw/src/plugin-sdk/skills-runtime.ts
 * and is loaded at runtime from the installed `openclaw` package inside the
 * Docker images. This stub exists so local pnpm-based development resolves
 * the subpath without pulling the full openclaw monorepo.
 */

export type SkillsChangeEvent = {
  workspaceDir?: string;
  reason: "watch" | "manual" | "remote-node" | "config-change";
  changedPath?: string;
};

export type SkillsChangeListener = (event: SkillsChangeEvent) => void;
