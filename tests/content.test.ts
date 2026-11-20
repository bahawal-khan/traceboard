import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({ getEnv: vi.fn() }));
vi.mock("@/lib/env", () => envMock);

import { DecryptionError, looksEncrypted } from "@/lib/crypto";
import { contentAad, contentCipherFromEnv, createContentCipher, prepareContent } from "@/lib/ingest/content";
import { QUOTAS } from "@/lib/quotas";

const key = randomBytes(32);
const cipher = createContentCipher(key);
const P = "11111111-1111-4111-8111-111111111111";
const E = "3f0c1b2e-8a64-4d1f-9c7e-5b2a6d9e1f40";

describe("prepareContent", () => {
  it("returns null when there is no content", () => {
    expect(prepareContent(cipher, P, E, null)).toBeNull();
    expect(prepareContent(cipher, P, E, {})).toBeNull();
  });

  it("stores ciphertext only, bound to project, event and field", () => {
    const c = prepareContent(cipher, P, E, { input: "what is the capital of France", output: "Paris" })!;
    expect(looksEncrypted(c.input!)).toBe(true);
    expect(looksEncrypted(c.output!)).toBe(true);
    expect(JSON.stringify(c)).not.toContain("France");
    expect(JSON.stringify(c)).not.toContain("Paris");
    expect(cipher.decrypt(c.input!, contentAad(P, E, "input"))).toBe("what is the capital of France");
    expect(cipher.decrypt(c.output!, contentAad(P, E, "output"))).toBe("Paris");
    // Swapped fields, another event or another project cannot decrypt it.
    expect(() => cipher.decrypt(c.input!, contentAad(P, E, "output"))).toThrow(DecryptionError);
    expect(() => cipher.decrypt(c.input!, contentAad(P, "other-event", "input"))).toThrow(DecryptionError);
    expect(() => cipher.decrypt(c.input!, contentAad("other-project", E, "input"))).toThrow(DecryptionError);
  });

  it("handles one field only", () => {
    const c = prepareContent(cipher, P, E, { output: "only output" })!;
    expect(c.input).toBeNull();
    expect(cipher.decrypt(c.output!, contentAad(P, E, "output"))).toBe("only output");
  });

  it("redacts BEFORE encrypting and records counts, never the matched text", () => {
    const c = prepareContent(cipher, P, E, { input: "email jane@example.com key sk-proj-abcdefghijklmnopqrstuvwx" })!;
    const plain = cipher.decrypt(c.input!, contentAad(P, E, "input"));
    expect(plain).toBe("email [redacted:email] key [redacted:secret]");
    expect(c.report).toMatchObject({ v: 1, enc: "aes-256-gcm", keyVersion: 1, truncated: false, redactions: { secret: 1, email: 1, card: 0, phone: 0 } });
    expect(JSON.stringify(c.report)).not.toContain("jane");
  });

  it("truncates to the configured byte cap after redaction and says so", () => {
    const long = "word ".repeat(1000);
    const c = prepareContent(cipher, P, E, { input: long })!;
    const plain = cipher.decrypt(c.input!, contentAad(P, E, "input"));
    expect(Buffer.byteLength(plain)).toBeLessThanOrEqual(QUOTAS.contentCaptureBytesPerEvent);
    expect(c.report.truncated).toBe(true);
  });

  it("a key glued to the preceding word is still redacted", () => {
    const c = prepareContent(cipher, P, E, { input: `token:lm_${"Y".repeat(43)} and xlm_${"Y".repeat(43)}` })!;
    const plain = cipher.decrypt(c.input!, contentAad(P, E, "input"));
    expect(plain).not.toContain("YYYY");
  });

  it("a secret near the size cap is redacted whole, not cut into an unmatched prefix", () => {
    const secret = `lm_${"Z".repeat(43)}`;
    const text = "a".repeat(QUOTAS.contentCaptureBytesPerEvent - 20) + " " + secret; // the secret straddles the cap
    const c = prepareContent(cipher, P, E, { input: text })!;
    const plain = cipher.decrypt(c.input!, contentAad(P, E, "input"));
    expect(plain).not.toContain("lm_Z");
    expect(plain.endsWith("[redacted:secret]")).toBe(true);
  });
});

describe("contentCipherFromEnv (CONTENT_ENCRYPTION_KEY)", () => {
  beforeEach(() => envMock.getEnv.mockReset());

  it("is null when the key is not configured, so content is dropped rather than stored in clear", () => {
    envMock.getEnv.mockReturnValue({ CONTENT_ENCRYPTION_KEY: undefined });
    expect(contentCipherFromEnv()).toBeNull();
  });

  it("builds a working cipher from the base64 key", () => {
    const k = randomBytes(32);
    envMock.getEnv.mockReturnValue({ CONTENT_ENCRYPTION_KEY: k.toString("base64") });
    const c = contentCipherFromEnv()!;
    expect(c.keyVersion).toBe(1);
    const enc = c.encrypt("hello", "aad");
    expect(createContentCipher(k).decrypt(enc, "aad")).toBe("hello"); // same key => same cipher
    expect(() => createContentCipher(randomBytes(32)).decrypt(enc, "aad")).toThrow(DecryptionError);
  });
});
