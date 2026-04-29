/**
 * Unit tests for SecretsStore — encrypted local vault.
 *
 * Tests verify:
 * 1. Encryption/decryption round-trip
 * 2. Key derivation from gateway token
 * 3. Path traversal prevention
 * 4. Secret isolation (different names → different ciphertexts)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretsStore } from "./secrets-store.js";

describe("SecretsStore", () => {
  let tmpDir: string;
  let secretsDir: string;
  let stateDir: string;
  let store: SecretsStore;
  let originalToken: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperclaw-secrets-test-"));
    secretsDir = path.join(tmpDir, "secrets");
    stateDir = tmpDir;
    originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    // Set a consistent test token
    process.env.OPENCLAW_GATEWAY_TOKEN =
      "test-gateway-token-" + crypto.randomBytes(16).toString("hex");
    store = new SecretsStore({ dir: secretsDir, stateDir });
  });

  afterEach(() => {
    if (originalToken !== undefined) {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
    } else {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("basic operations", () => {
    it("stores and retrieves a secret", () => {
      store.set("api_key", "sk-secret-12345");
      const retrieved = store.get("api_key");
      expect(retrieved).toBe("sk-secret-12345");
    });

    it("returns null for non-existent secret", () => {
      expect(store.get("nonexistent")).toBeNull();
    });

    it("lists stored secrets", () => {
      store.set("secret1", "value1");
      store.set("secret2", "value2");
      const names = store.list();
      expect(names).toContain("secret1");
      expect(names).toContain("secret2");
    });

    it("checks existence with has()", () => {
      expect(store.has("mykey")).toBe(false);
      store.set("mykey", "myvalue");
      expect(store.has("mykey")).toBe(true);
    });

    it("deletes a secret", () => {
      store.set("todelete", "value");
      expect(store.has("todelete")).toBe(true);
      store.delete("todelete");
      expect(store.has("todelete")).toBe(false);
    });

    it("overwrites existing secret", () => {
      store.set("key", "original");
      store.set("key", "updated");
      expect(store.get("key")).toBe("updated");
    });
  });

  describe("encryption properties", () => {
    it("stores ciphertext, not plaintext", () => {
      const secret = "super-secret-password-12345";
      store.set("encrypted", secret);
      const filePath = path.join(secretsDir, "encrypted.enc");
      const raw = fs.readFileSync(filePath, "utf8");
      expect(raw).not.toContain(secret);
      expect(raw).toContain("ciphertext");
      expect(raw).toContain("salt");
      expect(raw).toContain("iv");
      expect(raw).toContain("tag");
    });

    it("uses unique salt/IV per write", () => {
      store.set("key1", "value");
      store.set("key2", "value"); // Same value, different key
      const file1 = JSON.parse(fs.readFileSync(path.join(secretsDir, "key1.enc"), "utf8"));
      const file2 = JSON.parse(fs.readFileSync(path.join(secretsDir, "key2.enc"), "utf8"));
      expect(file1.salt).not.toBe(file2.salt);
      expect(file1.iv).not.toBe(file2.iv);
    });

    it("fails decryption with wrong gateway token", () => {
      store.set("tokentest", "myvalue");
      // Change the token
      process.env.OPENCLAW_GATEWAY_TOKEN =
        "different-token-" + crypto.randomBytes(16).toString("hex");
      const store2 = new SecretsStore({ dir: secretsDir, stateDir });
      // Decryption should fail (auth tag mismatch)
      expect(store2.get("tokentest")).toBeNull();
    });
  });

  describe("path traversal prevention", () => {
    it("sanitizes path traversal attempts", () => {
      store.set("../../../etc/passwd", "malicious");
      // Should not create file outside secrets dir
      expect(fs.existsSync("/etc/passwd.enc")).toBe(false);
      // ../../../etc/passwd -> 9 special chars become underscores: _________etc_passwd
      expect(fs.existsSync(path.join(secretsDir, "_________etc_passwd.enc"))).toBe(true);
    });

    it("sanitizes special characters in name", () => {
      store.set("foo/bar\\baz:qux", "value");
      const files = fs.readdirSync(secretsDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^[a-zA-Z0-9_-]+\.enc$/);
    });
  });

  describe("unicode and edge cases", () => {
    it("handles unicode secrets", () => {
      const secret = "密码🔐пароль";
      store.set("unicode", secret);
      expect(store.get("unicode")).toBe(secret);
    });

    it("handles empty string secret", () => {
      store.set("empty", "");
      expect(store.get("empty")).toBe("");
    });

    it("handles large secrets", () => {
      const largeSecret = "x".repeat(100_000);
      store.set("large", largeSecret);
      expect(store.get("large")).toBe(largeSecret);
    });
  });
});
