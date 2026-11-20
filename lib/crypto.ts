import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM helpers. Output format: `v1.<keyVersion>.<iv>.<ciphertext>.<tag>`, each part base64url.
 *
 *  - random 96-bit IV per call (never reused with a key),
 *  - the key version is stored with the data so keys can rotate: decryption looks the key up by version,
 *  - `aad` (additional authenticated data) binds a ciphertext to its context (project, event, field), so a
 *    ciphertext copied to another row or tenant fails to decrypt.
 * Callers pass keys in; this module never reads the environment and never logs.
 */
const FORMAT = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class DecryptionError extends Error {
  constructor() {
    super("decryption failed"); // deliberately generic: no detail about which check failed
    this.name = "DecryptionError";
  }
}

export type KeyRing = ReadonlyMap<number, Buffer>;

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error("encryption key must be 32 bytes");
}

export function encryptString(key: Buffer, keyVersion: number, plaintext: string, aad: string): string {
  assertKey(key);
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new Error("invalid key version");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT, keyVersion, iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptString(keys: KeyRing, payload: string, aad: string): string {
  try {
    const parts = payload.split(".");
    if (parts.length !== 5 || parts[0] !== FORMAT) throw new DecryptionError();
    const key = keys.get(Number(parts[1]));
    if (!key) throw new DecryptionError();
    assertKey(key);
    const iv = Buffer.from(parts[2]!, "base64url");
    const tag = Buffer.from(parts[4]!, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16) throw new DecryptionError();
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptionError();
  }
}

/** True for a string that has the shape of our ciphertext (used by tests and guards, not for security). */
export function looksEncrypted(s: string): boolean {
  return /^v1\.\d+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$/.test(s);
}
