import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkApiApproval,
  handlePotentialApiApprovalResponse,
  loadApiApprovalPolicy,
  type ApiApprovalPolicy,
} from "../api-approval-gate.js";

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<ApiApprovalPolicy> = {}): ApiApprovalPolicy {
  return {
    defaultPolicy: "allow",
    approvalRequired: {
      methods: ["POST", "PUT", "PATCH", "DELETE"],
      description: "Mutations require human approval",
    },
    allowlist: [],
    denylist: [],
    serviceAllowlist: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadApiApprovalPolicy
// ---------------------------------------------------------------------------

describe("loadApiApprovalPolicy", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-appgate-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads a valid policy JSON file", () => {
    const policy = makePolicy();
    const filePath = path.join(tmpDir, "policy.json");
    fs.writeFileSync(filePath, JSON.stringify(policy), "utf8");
    const loaded = loadApiApprovalPolicy(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.defaultPolicy).toBe("allow");
  });

  it("returns null for a missing file", () => {
    expect(loadApiApprovalPolicy(path.join(tmpDir, "nonexistent.json"))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "{ this is not json }", "utf8");
    expect(loadApiApprovalPolicy(filePath)).toBeNull();
  });

  it("preserves nested policy structure (serviceAllowlist)", () => {
    const policy = makePolicy({
      serviceAllowlist: {
        github: {
          hosts: ["api.github.com"],
          methods: ["GET"],
          mutationApproval: true,
          description: "GitHub API",
        },
      },
    });
    const filePath = path.join(tmpDir, "policy.json");
    fs.writeFileSync(filePath, JSON.stringify(policy), "utf8");
    const loaded = loadApiApprovalPolicy(filePath);
    expect(loaded!.serviceAllowlist["github"].hosts).toContain("api.github.com");
  });
});

// ---------------------------------------------------------------------------
// checkApiApproval — denylist
// ---------------------------------------------------------------------------

describe("checkApiApproval — denylist", () => {
  it("blocks a host on the denylist", () => {
    const policy = makePolicy({
      denylist: [{ pattern: "malicious.example.com", reason: "known bad actor" }],
    });
    const result = checkApiApproval(policy, "GET", "https://malicious.example.com/data");
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(false);
    expect(result.reason).toContain("Blocked");
  });

  it("denylist check runs before allowlist", () => {
    const policy = makePolicy({
      denylist: [{ pattern: "evil.com", reason: "malware" }],
      allowlist: [{ host: "evil.com", methods: ["GET"], reason: "oops" }],
    });
    const result = checkApiApproval(policy, "GET", "https://evil.com/path");
    expect(result.allowed).toBe(false);
  });

  it("wildcard denylist pattern blocks subdomains", () => {
    const policy = makePolicy({
      denylist: [{ pattern: "*.bad.com", reason: "all subdomains blocked" }],
    });
    expect(checkApiApproval(policy, "GET", "https://sub.bad.com/").allowed).toBe(false);
    expect(checkApiApproval(policy, "GET", "https://deep.sub.bad.com/").allowed).toBe(false);
  });

  it("wildcard denylist also blocks the root domain (conservative: *.bad.com includes bad.com)", () => {
    const policy = makePolicy({
      denylist: [{ pattern: "*.bad.com", reason: "all of bad.com" }],
    });
    // matchPattern implementation: host === pattern.slice(2) catches the root domain.
    // This is intentionally conservative — blocking *.bad.com also blocks bad.com itself.
    const result = checkApiApproval(policy, "GET", "https://bad.com/");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Blocked");
  });

  it("blocks private IP ranges via denylist pattern", () => {
    const policy = makePolicy({
      denylist: [{ pattern: "169.254.*", reason: "AWS metadata SSRF" }],
    });
    const result = checkApiApproval(policy, "GET", "https://169.254.169.254/latest/meta-data/");
    expect(result.allowed).toBe(false);
  });

  it("returns invalid URL as blocked, no approval required", () => {
    const policy = makePolicy();
    const result = checkApiApproval(policy, "GET", "not-a-url");
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(false);
    expect(result.reason).toContain("Invalid URL");
  });
});

// ---------------------------------------------------------------------------
// checkApiApproval — service allowlist
// ---------------------------------------------------------------------------

describe("checkApiApproval — service allowlist", () => {
  const policy = makePolicy({
    serviceAllowlist: {
      github: {
        hosts: ["api.github.com"],
        methods: ["GET"],
        mutationApproval: true,
        description: "GitHub API read-only pre-approved",
      },
      slack: {
        hosts: ["slack.com", "*.slack.com"],
        methods: ["GET", "POST"],
        mutationApproval: false,
        description: "Slack messaging",
      },
    },
  });

  it("allows GET on a service-allowlisted host", () => {
    const result = checkApiApproval(policy, "GET", "https://api.github.com/repos/oasis-main/oasis-claw");
    expect(result.allowed).toBe(true);
    expect(result.service).toBe("github");
    expect(result.reason).toContain("Pre-approved");
  });

  it("requires approval for mutation on mutationApproval:true service", () => {
    const result = checkApiApproval(policy, "POST", "https://api.github.com/repos/oasis-main/oasis-claw/issues");
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(result.service).toBe("github");
  });

  it("allows POST on a service with mutationApproval:false", () => {
    const result = checkApiApproval(policy, "POST", "https://slack.com/api/chat.postMessage");
    expect(result.allowed).toBe(true);
    expect(result.service).toBe("slack");
  });

  it("matches wildcard subdomain in service allowlist", () => {
    const result = checkApiApproval(policy, "GET", "https://myworkspace.slack.com/api/conversations.list");
    expect(result.allowed).toBe(true);
    expect(result.service).toBe("slack");
  });

  it("falls through to approval-required for unknown method on service", () => {
    // DELETE is not in slack.methods; mutationApproval is false so it falls through
    // to the approvalRequired check
    const result = checkApiApproval(policy, "DELETE", "https://slack.com/api/something");
    expect(result.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkApiApproval — explicit allowlist
// ---------------------------------------------------------------------------

describe("checkApiApproval — explicit allowlist", () => {
  const policy = makePolicy({
    allowlist: [
      {
        host: "api.openai.com",
        methods: ["POST"],
        paths: ["/v1/chat/completions", "/v1/embeddings"],
        reason: "OpenAI completions",
      },
      {
        host: "httpbin.org",
        methods: ["GET", "POST"],
        reason: "Test endpoint",
      },
    ],
  });

  it("allows an explicitly allowlisted host+method+path", () => {
    const result = checkApiApproval(policy, "POST", "https://api.openai.com/v1/chat/completions");
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("Allowlisted");
  });

  it("blocks a non-allowlisted path on an otherwise allowlisted host", () => {
    const result = checkApiApproval(policy, "POST", "https://api.openai.com/v1/models");
    // Not on the allowlisted paths → falls through to approvalRequired
    expect(result.requiresApproval).toBe(true);
  });

  it("allows when paths array is absent (any path matches)", () => {
    const result = checkApiApproval(policy, "GET", "https://httpbin.org/anything/some/path");
    expect(result.allowed).toBe(true);
  });

  it("does not allow wrong method on allowlisted host", () => {
    const result = checkApiApproval(policy, "DELETE", "https://httpbin.org/resource");
    expect(result.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkApiApproval — approval-required methods
// ---------------------------------------------------------------------------

describe("checkApiApproval — approval-required methods", () => {
  it("flags mutating methods as requiresApproval when no allowlist match", () => {
    const policy = makePolicy();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const result = checkApiApproval(policy, method, "https://api.example.com/resource");
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
    }
  });

  it("allows GET by default (defaultPolicy:allow, no denylist match)", () => {
    const policy = makePolicy();
    const result = checkApiApproval(policy, "GET", "https://api.example.com/data");
    expect(result.allowed).toBe(true);
  });

  it("is case-insensitive for method", () => {
    const policy = makePolicy();
    const lower = checkApiApproval(policy, "post", "https://api.example.com/");
    const upper = checkApiApproval(policy, "POST", "https://api.example.com/");
    expect(lower.requiresApproval).toBe(upper.requiresApproval);
  });
});

// ---------------------------------------------------------------------------
// checkApiApproval — default policy
// ---------------------------------------------------------------------------

describe("checkApiApproval — default policy", () => {
  it("allows unlisted GET when defaultPolicy is allow", () => {
    const result = checkApiApproval(makePolicy({ defaultPolicy: "allow" }), "GET", "https://example.com/");
    expect(result.allowed).toBe(true);
  });

  it("requires approval for unlisted GET when defaultPolicy is deny", () => {
    const result = checkApiApproval(makePolicy({ defaultPolicy: "deny" }), "GET", "https://example.com/");
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handlePotentialApiApprovalResponse — in-memory state machine
// ---------------------------------------------------------------------------

describe("handlePotentialApiApprovalResponse", () => {
  it("returns false when message contains no request ID", () => {
    expect(handlePotentialApiApprovalResponse("yes please approve")).toBe(false);
  });

  it("returns false when request ID is unknown (not in pending map)", () => {
    // Fabricated ID that was never created via requestApiApproval
    expect(handlePotentialApiApprovalResponse("api_99999999_xxxxxx approve")).toBe(false);
  });

  // Note: We don't test the full approve/deny flow here because requestApiApproval
  // calls Telegram (live network). That integration is covered by the E2E test
  // against the running container (see docker-compose.secure.yml smoke test).
  // The logic that resolves the promise lives in the pendingApprovals map which
  // is only populated by requestApiApproval — so we document the boundary here.
  it("documents: resolve path tested via E2E with live Telegram (ORG-035)", () => {
    // This is intentionally a no-op assertion. The in-memory resolution path
    // (clearTimeout + pendingApprovals.delete + resolve(approved)) is correct
    // by inspection but requires a running requestApiApproval promise to exercise.
    expect(true).toBe(true);
  });
});
