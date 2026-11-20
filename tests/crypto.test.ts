import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DecryptionError, decryptString, encryptString, looksEncrypted } from "@/lib/crypto";

const key = randomBytes(32);
const ring = new Map([[1, key]]);
const AAD = "content|p|e|input";

describe("AES-256-GCM helpers", () => {
  it("round-trips, including unicode and the empty string", () => {
    for (const text of ["hello", "héllo wörld 日本語 🙂", "", "x".repeat(5000)]) {
      expect(decryptString(ring, encryptString(key, 1, text, AAD), AAD)).toBe(text);
    }
  });

  it("never contains the plaintext and has the documented shape", () => {
    const out = encryptString(key, 1, "super secret prompt", AAD);
    expect(out).not.toContain("super");
    expect(out).not.toContain(Buffer.from("super secret prompt").toString("base64url"));
    expect(looksEncrypted(out)).toBe(true);
    expect(out.split(".")).toHaveLength(5);
    expect(out.startsWith("v1.1.")).toBe(true);
  });

  it("uses a fresh random IV every time", () => {
    const outs = new Set(Array.from({ length: 50 }, () => encryptString(key, 1, "same", AAD)));
    expect(outs.size).toBe(50);
  });

  it("binds the ciphertext to its AAD: another project, event or field fails", () => {
    const out = encryptString(key, 1, "data", "content|P1|E1|input");
    for (const bad of ["content|P2|E1|input", "content|P1|E2|input", "content|P1|E1|output", ""]) {
      expect(() => decryptString(ring, out, bad), bad).toThrow(DecryptionError);
    }
  });

  it("rejects a wrong key, a tampered part, and an unknown key version", () => {
    const out = encryptString(key, 1, "data", AAD);
    expect(() => decryptString(new Map([[1, randomBytes(32)]]), out, AAD)).toThrow(DecryptionError);
    const parts = out.split(".");
    const flip = (i: number) => {
      const p = [...parts];
      const b = Buffer.from(p[i]!, "base64url");
      b[0] = b[0]! ^ 1;
      p[i] = b.toString("base64url");
      return p.join(".");
    };
    for (const i of [2, 3, 4]) expect(() => decryptString(ring, flip(i), AAD), `part ${i}`).toThrow(DecryptionError);
    expect(() => decryptString(new Map([[2, key]]), out, AAD)).toThrow(DecryptionError); // version 1 not in the ring
  });

  it("rotation: old ciphertexts still decrypt while new ones use the new version", () => {
    const k2 = randomBytes(32);
    const old = encryptString(key, 1, "old", AAD);
    const fresh = encryptString(k2, 2, "new", AAD);
    const both = new Map([[1, key], [2, k2]]);
    expect(decryptString(both, old, AAD)).toBe("old");
    expect(decryptString(both, fresh, AAD)).toBe("new");
    expect(fresh.startsWith("v1.2.")).toBe(true);
  });

  it("throws one generic error for any malformed input, never a detail", () => {
    for (const bad of ["", "garbage", "v1.1.a.b", "v2.1.a.b.c", "v1.x.a.b.c", "v1.1..." , "v1.1.AAAAAAAAAAAAAAAA.AA.AAAAAAAAAAAAAAAAAAAAAA"]) {
      try {
        decryptString(ring, bad, AAD);
        expect.unreachable(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(DecryptionError);
        expect((e as Error).message).toBe("decryption failed");
      }
    }
  });

  it("insists on a 32-byte key and a sane version", () => {
    expect(() => encryptString(randomBytes(16), 1, "x", AAD)).toThrow(/32 bytes/);
    expect(() => encryptString(key, 0, "x", AAD)).toThrow();
    expect(() => encryptString(key, 1.5, "x", AAD)).toThrow();
  });
});
