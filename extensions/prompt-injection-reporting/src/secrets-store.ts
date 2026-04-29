/**
 * Encrypted local secrets vault — AES-256-GCM, key derived from gateway token via PBKDF2.
 *
 * Storage: ~/.openclaw/state/secrets/<name>.enc
 * Each file: JSON { salt: hex, iv: hex, tag: hex, ciphertext: hex }
 *
 * The encryption key is derived at runtime from the OPENCLAW_GATEWAY_TOKEN env var.
 * Rotating the gateway token = rotating all encryption keys (old secrets become unreadable).
 *
 * The agent NEVER sees plaintext secrets — the deposit_secret tool reads from the vault
 * and injects directly into browser form fields without returning the value to the model.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KEY_LEN = 32; // 256-bit
const PBKDF2_ITER = 100_000;
const PBKDF2_DIGEST = "sha256";
const ENC_ALGO = "aes-256-gcm";

type EncryptedEntry = {
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, KEY_LEN, PBKDF2_DIGEST);
}

function resolvePassword(stateDir: string): string {
  // Prefer explicit env var, fall back to gateway token, then a fixed fallback warning
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (token && token.length >= 16) return token;
  // Fall back to a file-based key if token is absent
  const keyFile = path.join(stateDir, ".secrets-key");
  if (fs.existsSync(keyFile)) {
    return fs.readFileSync(keyFile, "utf8").trim();
  }
  // Generate and persist a random key on first use
  const generated = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  return generated;
}

export class SecretsStore {
  private readonly dir: string;
  private readonly stateDir: string;

  constructor(opts: { dir: string; stateDir: string }) {
    this.dir = opts.dir;
    this.stateDir = opts.stateDir;
  }

  private entryPath(name: string): string {
    // Sanitize name to prevent path traversal
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    return path.join(this.dir, `${safe}.enc`);
  }

  /** List all stored secret names. */
  list(): string[] {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(".enc"))
        .map((f) => f.slice(0, -4));
    } catch {
      return [];
    }
  }

  /** Check whether a named secret exists. */
  has(name: string): boolean {
    return fs.existsSync(this.entryPath(name));
  }

  /** Store a plaintext secret, encrypted. Overwrites if exists. */
  set(name: string, plaintext: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const password = resolvePassword(this.stateDir);
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    const key = deriveKey(password, salt);
    const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
    const cipherBuf = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const entry: EncryptedEntry = {
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      ciphertext: cipherBuf.toString("hex"),
    };
    fs.writeFileSync(this.entryPath(name), JSON.stringify(entry, null, 2), { mode: 0o600 });
  }

  /**
   * Retrieve a plaintext secret by name.
   * IMPORTANT: The caller is responsible for never logging or returning this to the model.
   */
  get(name: string): string | null {
    const p = this.entryPath(name);
    if (!fs.existsSync(p)) return null;
    try {
      const raw = fs.readFileSync(p, "utf8");
      const entry = JSON.parse(raw) as EncryptedEntry;
      const password = resolvePassword(this.stateDir);
      const salt = Buffer.from(entry.salt, "hex");
      const iv = Buffer.from(entry.iv, "hex");
      const tag = Buffer.from(entry.tag, "hex");
      const ciphertext = Buffer.from(entry.ciphertext, "hex");
      const key = deriveKey(password, salt);
      const decipher = crypto.createDecipheriv(ENC_ALGO, key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString("utf8");
    } catch {
      return null;
    }
  }

  /** Delete a named secret. */
  delete(name: string): void {
    const p = this.entryPath(name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
