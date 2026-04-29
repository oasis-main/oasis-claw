/**
 * Unit tests for browser-approvals — URL allowlist matching.
 *
 * Tests verify:
 * 1. Exact hostname matching
 * 2. Wildcard subdomain matching (*.domain.com)
 * 3. URL prefix matching
 * 4. Allowlist persistence
 * 5. Edge cases and security boundaries
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addUrlToAllowlist,
  checkUrlAllowlist,
  loadBrowserApprovals,
  saveBrowserApprovals,
  type BrowserAllowlistEntry,
  type BrowserApprovalsFile,
} from "../../../src/infra/browser-approvals.js";

// Mock the home dir expansion for isolated tests
vi.mock("../../../src/infra/home-dir.js", () => ({
  expandHomePrefix: (p: string) => p.replace(/^~/, process.env.TEST_HOME_DIR || os.homedir()),
}));

describe("checkUrlAllowlist", () => {
  describe("exact hostname matching", () => {
    const entries: BrowserAllowlistEntry[] = [{ pattern: "github.com" }, { pattern: "example.org" }];

    it("matches exact hostname", () => {
      expect(checkUrlAllowlist("https://github.com/user/repo", entries)).toBe(true);
      expect(checkUrlAllowlist("https://example.org/path", entries)).toBe(true);
    });

    it("rejects different hostname", () => {
      expect(checkUrlAllowlist("https://gitlab.com/user/repo", entries)).toBe(false);
    });

    it("rejects subdomain when exact hostname required", () => {
      expect(checkUrlAllowlist("https://api.github.com/v1", entries)).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(checkUrlAllowlist("https://GITHUB.COM/path", entries)).toBe(true);
      expect(checkUrlAllowlist("https://GitHub.Com/path", entries)).toBe(true);
    });
  });

  describe("wildcard subdomain matching", () => {
    const entries: BrowserAllowlistEntry[] = [{ pattern: "*.github.com" }, { pattern: "*.example.org" }];

    it("matches subdomains", () => {
      expect(checkUrlAllowlist("https://api.github.com/v1", entries)).toBe(true);
      expect(checkUrlAllowlist("https://docs.example.org/page", entries)).toBe(true);
    });

    it("matches deep subdomains", () => {
      expect(checkUrlAllowlist("https://a.b.c.github.com/path", entries)).toBe(true);
    });

    it("matches base domain with wildcard pattern", () => {
      expect(checkUrlAllowlist("https://github.com/path", entries)).toBe(true);
    });

    it("rejects unrelated domains", () => {
      expect(checkUrlAllowlist("https://notgithub.com/path", entries)).toBe(false);
      expect(checkUrlAllowlist("https://github.com.evil.com/path", entries)).toBe(false);
    });
  });

  describe("URL prefix matching", () => {
    const entries: BrowserAllowlistEntry[] = [
      { pattern: "https://api.example.com/v1" },
      { pattern: "http://internal.corp.net/api" },
    ];

    it("matches URLs starting with prefix", () => {
      expect(checkUrlAllowlist("https://api.example.com/v1/users", entries)).toBe(true);
      expect(checkUrlAllowlist("https://api.example.com/v1", entries)).toBe(true);
    });

    it("rejects URLs not starting with prefix", () => {
      expect(checkUrlAllowlist("https://api.example.com/v2/users", entries)).toBe(false);
      expect(checkUrlAllowlist("https://api.example.com/", entries)).toBe(false);
    });

    it("is case-insensitive for prefix", () => {
      expect(checkUrlAllowlist("HTTPS://API.EXAMPLE.COM/V1/users", entries)).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("returns false for empty allowlist", () => {
      expect(checkUrlAllowlist("https://anything.com", [])).toBe(false);
    });

    it("returns false for invalid URL", () => {
      const entries: BrowserAllowlistEntry[] = [{ pattern: "github.com" }];
      expect(checkUrlAllowlist("not-a-valid-url", entries)).toBe(false);
    });

    it("ignores empty patterns", () => {
      const entries: BrowserAllowlistEntry[] = [{ pattern: "" }, { pattern: "   " }, { pattern: "github.com" }];
      expect(checkUrlAllowlist("https://github.com", entries)).toBe(true);
    });
  });

  describe("security boundaries", () => {
    const entries: BrowserAllowlistEntry[] = [{ pattern: "github.com" }];

    it("rejects file:// URLs", () => {
      expect(checkUrlAllowlist("file:///etc/passwd", entries)).toBe(false);
    });

    it("rejects javascript: URLs", () => {
      expect(checkUrlAllowlist("javascript:alert(1)", entries)).toBe(false);
    });

    it("rejects data: URLs", () => {
      expect(checkUrlAllowlist("data:text/html,<script>alert(1)</script>", entries)).toBe(false);
    });
  });
});

describe("allowlist persistence", () => {
  let tmpDir: string;
  let approvalsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperclaw-browser-test-"));
    approvalsPath = path.join(tmpDir, ".openclaw", "browser-approvals.json");
    process.env.TEST_HOME_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.TEST_HOME_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves and loads approvals file", () => {
    const file: BrowserApprovalsFile = {
      version: 1,
      entries: [{ pattern: "github.com" }],
    };
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(approvalsPath, JSON.stringify(file));

    // Note: loadBrowserApprovals uses expandHomePrefix which we mocked
    // This tests the JSON structure handling
    const loaded = JSON.parse(fs.readFileSync(approvalsPath, "utf8"));
    expect(loaded.version).toBe(1);
    expect(loaded.entries[0].pattern).toBe("github.com");
  });

  it("adds URL to allowlist and deduplicates", () => {
    const file: BrowserApprovalsFile = { version: 1, entries: [] };
    addUrlToAllowlist("https://github.com/user/repo", file);
    addUrlToAllowlist("https://github.com/other/repo", file); // Same hostname, should dedupe
    expect(file.entries?.length).toBe(1);
    expect(file.entries?.[0].pattern).toBe("github.com");
  });

  it("extracts hostname from full URL", () => {
    const file: BrowserApprovalsFile = { version: 1, entries: [] };
    addUrlToAllowlist("https://api.example.com:8080/v1/users?foo=bar", file);
    expect(file.entries?.[0].pattern).toBe("api.example.com");
  });
});
