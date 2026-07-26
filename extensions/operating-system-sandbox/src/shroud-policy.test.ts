/**
 * Unit tests for the read-shroud policy + transform (CLAW-043).
 * Fixtures only — no real secrets, no real filesystem.
 */

import { describe, expect, it } from "vitest";
import {
  ALWAYS_SHROUD_GLOBS,
  classifyPath,
  discoverIgnored,
  globToRegExp,
  type ExecFn,
} from "./shroud-policy.js";
import {
  applyPlaceholder,
  extractPathTokens,
  extractReadPath,
  shroudPlaceholder,
} from "./shroud-transform.js";

describe("globToRegExp", () => {
  it("anchors and treats dots as literal", () => {
    expect(globToRegExp("*.key").test("id.key")).toBe(true);
    expect(globToRegExp("*.key").test("keyboard.txt")).toBe(false);
    expect(globToRegExp(".env*").test(".env")).toBe(true);
    expect(globToRegExp(".env*").test(".env.local")).toBe(true);
    expect(globToRegExp(".env*").test("prod.env")).toBe(false); // basename anchored
    expect(globToRegExp("id_ed25519*").test("id_ed25519")).toBe(true);
    expect(globToRegExp("id_ed25519*").test("id_ed25519.pub")).toBe(true);
  });
});

describe("classifyPath", () => {
  const ignored = new Set<string>(["/reach/runes/oasis-x/notes.local.md"]);

  it("shrouds .env family by glob regardless of git", () => {
    const v = classifyPath("/reach/runes/oasis-x/.env", { ignored: new Set() });
    expect(v.shroud).toBe(true);
    expect(v.reason).toBe("always-glob:.env*");
  });

  it("shrouds key material by extension", () => {
    expect(classifyPath("/reach/runes/deploy.pem", { ignored: new Set() }).shroud).toBe(true);
    expect(classifyPath("/reach/x/id_rsa", { ignored: new Set() }).reason).toBe("always-glob:id_rsa*");
  });

  it("shrouds anything under a secret directory", () => {
    const v = classifyPath("/reach/home-ssh/.ssh/known_hosts", { ignored: new Set() });
    expect(v.shroud).toBe(true);
    expect(v.reason).toBe("secret-dir:.ssh");
  });

  it("does NOT shroud .aws/config (allowed reach)", () => {
    // config is not a secret glob and .aws is not a secret segment
    expect(classifyPath("/reach/aws-config/.aws/config", { ignored: new Set() }).shroud).toBe(false);
  });

  it("shrouds a gitignored non-secret file via the manifest", () => {
    const v = classifyPath("/reach/runes/oasis-x/notes.local.md", { ignored });
    expect(v.shroud).toBe(true);
    expect(v.reason).toBe("gitignored");
  });

  it("passes ordinary source files through", () => {
    const v = classifyPath("/reach/runes/oasis-x/src/index.ts", { ignored });
    expect(v.shroud).toBe(false);
    expect(v.reason).toBe("visible");
  });

  it("session unlock overrides every shroud rule", () => {
    const unlocked = new Set<string>(["/reach/runes/oasis-x/.env"]);
    const v = classifyPath("/reach/runes/oasis-x/.env", { ignored, unlocked });
    expect(v.shroud).toBe(false);
    expect(v.reason).toBe("unlocked");
  });

  // 2026-07-13 hardening: reach mounts rename ~/.ssh -> /reach/home-ssh, which
  // defeated the .ssh secret-dir rule and leaked bare-named private keys.
  it("shrouds bare-named private keys under the renamed /reach/home-ssh mount", () => {
    const v = classifyPath("/reach/home-ssh/oasis_deploy", { ignored: new Set() });
    expect(v.shroud).toBe(true);
    expect(v.reason).toBe("secret-dir:home-ssh");
  });

  it("shrouds ~/.gnupg content via the gnupg reach rename", () => {
    expect(classifyPath("/reach/gnupg/secring.gpg", { ignored: new Set() }).shroud).toBe(true);
  });

  it("matches sshd host keys with the ssh_host_* glob", () => {
    const v = classifyPath("/reach/etc/ssh/ssh_host_ed25519_key", { ignored: new Set() });
    expect(v.shroud).toBe(true);
    expect(v.reason).toBe("always-glob:ssh_host_*");
  });
});

describe("discoverIgnored", () => {
  it("collects absolute ignored paths from git, skips non-repos", () => {
    const fakeExec: ExecFn = (_cmd, args) => {
      const root = args[1]; // -C <root>
      if (root === "/reach/runes/repo") {
        return { code: 0, stdout: ".env\0sub/secret.txt\0", stderr: "" };
      }
      return { code: 128, stdout: "", stderr: "not a git repository" };
    };
    const set = discoverIgnored(["/reach/runes/repo", "/reach/runes/plain"], fakeExec);
    expect(set.has("/reach/runes/repo/.env")).toBe(true);
    expect(set.has("/reach/runes/repo/sub/secret.txt")).toBe(true);
    expect(set.size).toBe(2); // non-repo contributed nothing
  });
});

describe("transform", () => {
  it("extracts the path arg in openclaw key order", () => {
    expect(extractReadPath({ path: "/a" })).toBe("/a");
    expect(extractReadPath({ file_path: "/b" })).toBe("/b");
    expect(extractReadPath({ filePath: "/c" })).toBe("/c");
    expect(extractReadPath({})).toBeUndefined();
  });

  it("placeholder keeps metadata but never the contents", () => {
    const p = shroudPlaceholder("/reach/x/.env", "always-glob:.env*", {
      size: 812,
      mode: "0600",
      mtimeIso: "2026-07-12T00:00:00.000Z",
    });
    expect(p).toContain("/reach/x/.env");
    expect(p).toContain("812 bytes");
    expect(p).toContain("mode 0600");
    expect(p).not.toContain("SECRET"); // sanity: no value leakage by construction
  });

  it("replaces string and content-array results", () => {
    expect(applyPlaceholder("AKIA...secret", "X")).toBe("X");
    const arr = applyPlaceholder({ content: [{ type: "text", text: "secret" }], isError: false }, "X");
    expect(arr).toEqual({ content: [{ type: "text", text: "X" }], isError: false });
  });

  it("finds path-like tokens in a bash command", () => {
    const toks = extractPathTokens("cat /reach/runes/oasis-x/.env | grep KEY");
    expect(toks).toContain("/reach/runes/oasis-x/.env");
  });
});

describe("glob list sanity", () => {
  it("includes the core secret families", () => {
    for (const g of [".env*", "*.pem", "*.key", "credentials", ".netrc"]) {
      expect(ALWAYS_SHROUD_GLOBS).toContain(g);
    }
  });

  // CLAW-064: openclaw's own crown-jewel credential files must never be
  // returned in cleartext by the file tools running in the agent container.
  it("includes openclaw's own credential files (CLAW-064)", () => {
    for (const g of [
      ".gateway-token",
      "openclaw.json",
      "exec-approvals.json",
      "device.json",
      "device-auth.json",
    ]) {
      expect(ALWAYS_SHROUD_GLOBS).toContain(g);
    }
  });
});

describe("openclaw credential shrouding (CLAW-064)", () => {
  const ignored = new Set<string>();
  it("shrouds .gateway-token anywhere on the filesystem", () => {
    const v = classifyPath("/home/node/.openclaw/.gateway-token", { ignored });
    expect(v.shroud).toBe(true);
    expect(v.reason).toBe("always-glob:.gateway-token");
  });
  it("shrouds openclaw.json (holds gateway.auth.token inline)", () => {
    const v = classifyPath("/home/node/.openclaw/openclaw.json", { ignored });
    expect(v.shroud).toBe(true);
    expect(v.reason).toBe("always-glob:openclaw.json");
  });
  it("shrouds exec-approvals.json (holds the approval-runtime socket token)", () => {
    const v = classifyPath("/home/node/.openclaw/exec-approvals.json", { ignored });
    expect(v.shroud).toBe(true);
    expect(v.reason).toBe("always-glob:exec-approvals.json");
  });
  it("shrouds identity/device.json (operator device privateKeyPem)", () => {
    const v = classifyPath("/home/node/.openclaw/identity/device.json", { ignored });
    expect(v.shroud).toBe(true);
    expect(v.reason).toBe("always-glob:device.json");
  });
  it("shrouds identity/device-auth.json (issued deviceToken)", () => {
    const v = classifyPath("/home/node/.openclaw/identity/device-auth.json", { ignored });
    expect(v.shroud).toBe(true);
    expect(v.reason).toBe("always-glob:device-auth.json");
  });
  it("still lets the agent read its own workspace files under .openclaw", () => {
    // Regression guard: the CLAW-064 additions are BASENAMES, not the
    // ".openclaw" segment. Yes Man's own memory / session / workspace files
    // must remain visible.
    for (const p of [
      "/home/node/.openclaw/workspace/memory/2026-07-20.md",
      "/home/node/.openclaw/agents/main/sessions/abc.jsonl",
      "/home/node/.openclaw/logs/heartbeat.log",
    ]) {
      const v = classifyPath(p, { ignored });
      expect(v.shroud).toBe(false);
    }
  });
});
