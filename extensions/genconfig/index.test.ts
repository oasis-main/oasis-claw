import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyModelParams,
  clearModelParams,
  currentModelParams,
  modelIdForProvider,
  readPrimary,
  renderModelStatus,
  validateEffort,
  validateProfile,
} from "./index.ts";

const CAPS_ADAPTIVE = {
  supports_thinking: true,
  thinking_forced: false,
  supports_effort: true,
  effort_levels: ["low", "high", "xhigh"],
  supports_temperature: false,
  supports_sampling: false,
  max_output_tokens_ceiling: 32000,
  profiles: ["fast", "balanced", "deep"],
  default_profile: "balanced",
};
const CAPS_NATIVE = {
  supports_thinking: false,
  thinking_forced: false,
  supports_effort: false,
  effort_levels: [],
  supports_temperature: true,
  supports_sampling: true,
  max_output_tokens_ceiling: 16000,
  profiles: ["fast", "balanced", "deep"],
  default_profile: "balanced",
};

test("readPrimary handles string, object, and unset", () => {
  assert.equal(readPrimary({ agents: { defaults: { model: "oasis-generation/claude-opus-4-8" } } }), "oasis-generation/claude-opus-4-8");
  assert.equal(readPrimary({ agents: { defaults: { model: { primary: "anthropic/claude-sonnet-5" } } } }), "anthropic/claude-sonnet-5");
  assert.equal(readPrimary({}), undefined);
});

test("modelIdForProvider strips the matching provider prefix only", () => {
  assert.equal(modelIdForProvider("oasis-generation/claude-opus-4-8", "oasis-generation"), "claude-opus-4-8");
  assert.equal(modelIdForProvider("anthropic/claude-sonnet-5", "oasis-generation"), null);
  assert.equal(modelIdForProvider(undefined, "oasis-generation"), null);
});

test("validateProfile respects per-model profiles and the default fallback", () => {
  assert.equal(validateProfile(CAPS_ADAPTIVE, "deep").ok, true);
  assert.equal(validateProfile(CAPS_ADAPTIVE, "turbo").ok, false);
  // No caps -> fall back to fast/balanced/deep.
  assert.equal(validateProfile(undefined, "balanced").ok, true);
  assert.equal(validateProfile(undefined, "nope").ok, false);
});

test("validateEffort rejects unsupported levels and effort-less models", () => {
  assert.equal(validateEffort(CAPS_ADAPTIVE, "xhigh").ok, true);
  assert.equal(validateEffort(CAPS_ADAPTIVE, "medium").ok, false); // not in [low,high,xhigh]
  const nativeCheck = validateEffort(CAPS_NATIVE, "high");
  assert.equal(nativeCheck.ok, false); // native model has no gateway effort control
});

test("applyModelParams writes extra_body under the model key (replace mode) and is immutable", () => {
  const cfg = { agents: { defaults: { model: { primary: "oasis-generation/claude-opus-4-8" } } } };
  const next = applyModelParams(cfg, "oasis-generation/claude-opus-4-8", { extra_body: { profile: "deep" } }, false);
  assert.deepEqual(
    next.agents.defaults.models["oasis-generation/claude-opus-4-8"].params.extra_body,
    { profile: "deep" },
  );
  // original untouched
  assert.equal(cfg.agents.defaults.models, undefined);
});

test("extra_body replace vs merge", () => {
  let cfg: any = {};
  cfg = applyModelParams(cfg, "oasis-generation/glm-5", { extra_body: { profile: "balanced" } }, false);
  // merge mode adds an effort override without dropping the profile
  cfg = applyModelParams(cfg, "oasis-generation/glm-5", { extra_body: { reasoning_effort: "low" } }, true);
  assert.deepEqual(currentModelParams(cfg, "oasis-generation/glm-5").extra_body, {
    profile: "balanced",
    reasoning_effort: "low",
  });
  // replace mode (profile selection) resets extra_body, dropping the effort override
  cfg = applyModelParams(cfg, "oasis-generation/glm-5", { extra_body: { profile: "fast" } }, false);
  assert.deepEqual(currentModelParams(cfg, "oasis-generation/glm-5").extra_body, { profile: "fast" });
});

test("temperature set and delete", () => {
  let cfg: any = {};
  cfg = applyModelParams(cfg, "oasis-generation/glm-5", { temperature: 0.7 }, true);
  assert.equal(currentModelParams(cfg, "oasis-generation/glm-5").temperature, 0.7);
  cfg = applyModelParams(cfg, "oasis-generation/glm-5", { temperature: null }, true);
  assert.equal(currentModelParams(cfg, "oasis-generation/glm-5").temperature, undefined);
});

test("clearModelParams removes the override", () => {
  let cfg: any = applyModelParams({}, "oasis-generation/claude-opus-4-8", { extra_body: { profile: "deep" } }, false);
  cfg = clearModelParams(cfg, "oasis-generation/claude-opus-4-8");
  assert.deepEqual(currentModelParams(cfg, "oasis-generation/claude-opus-4-8"), {});
});

test("renderModelStatus shows supported controls and hides temperature when unsupported", () => {
  const s = renderModelStatus("claude-opus-4-8", CAPS_ADAPTIVE, { extra_body: { profile: "deep" } });
  assert.match(s, /claude-opus-4-8/);
  assert.match(s, /adaptive/);
  assert.match(s, /not supported/); // temperature hidden
  assert.match(s, /profile=deep/);
  const n = renderModelStatus("glm-5", CAPS_NATIVE, {});
  assert.match(n, /temperature: supported/);
  assert.match(n, /none — gateway default/);
});
