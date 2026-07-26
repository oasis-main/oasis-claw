import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { z } from "zod";
import { registerReviewer } from "./src/reviewer.js";

const configSchema = z.object({
  mode: z.enum(["shadow", "enforce"]).optional(),
  auditDir: z.string().optional(),
});

export type OasisReviewerConfig = z.infer<typeof configSchema>;

const plugin = {
  id: "oasis-reviewer",
  name: "Oasis Reviewer",
  description:
    "Independent before_tool_call reviewer (two-layer policy: hard gitignore constraints + constitution). Shadow/audit skeleton.",

  configSchema: {
    parse(raw: unknown) {
      return configSchema.parse(raw ?? {});
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig ?? {});
    const stateDir = api.runtime?.stateDir ?? (process.env.HOME + "/.openclaw");
    const auditDir = cfg.auditDir ?? `${stateDir}/logs/reviewer`;
    // Skeleton ships SHADOW: observe + audit only, never block. The whole point
    // of this phase is to learn the real before_tool_call param shapes on live
    // traffic before Layer 1 (hard) / Layer 2 (constitution) gate anything.
    const mode = cfg.mode ?? "shadow";

    registerReviewer(api, { auditDir, mode });

    api.logger.info("oasis-reviewer plugin loaded", { auditDir, mode });
  },
};

export default plugin;
