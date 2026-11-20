import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_KEY_SCOPES, generateApiKey, hashApiKey, looksLikeApiKey } from "@/lib/api-key";
import { createApiKeyInput } from "@/lib/validation/api-keys";

describe("generateApiKey", () => {
  it("produces lm_ + 43 base64url chars that pass the shape check", () => {
    const k = generateApiKey();
    expect(k.secret).toMatch(/^lm_[A-Za-z0-9_-]{43}$/);
    expect(looksLikeApiKey(k.secret)).toBe(true);
  });

  it("hashes with sha256 and keeps only a short display prefix", () => {
    const k = generateApiKey();
    expect(k.hash).toBe(hashApiKey(k.secret));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.prefix).toBe(k.secret.slice(0, 8));
    expect(k.prefix).toHaveLength(8);
    expect(k.hash).not.toContain(k.secret);
  });

  it("never repeats across many generations", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateApiKey().secret));
    expect(seen.size).toBe(2000);
  });
});

describe("createApiKeyInput", () => {
  it("defaults to the ingest scope and an empty name", () => {
    expect(createApiKeyInput.parse({})).toEqual({ scopes: ["ingest"], name: "" });
  });

  it("trims the name, allows empty and exactly 60 characters", () => {
    expect(createApiKeyInput.parse({ name: "  production  " }).name).toBe("production");
    expect(createApiKeyInput.parse({ name: "" }).name).toBe("");
    expect(createApiKeyInput.parse({ name: "   " }).name).toBe("");
    expect(createApiKeyInput.parse({ name: "x".repeat(60) }).name).toHaveLength(60);
  });

  it("rejects a name over 60 characters, with control characters, or of the wrong type", () => {
    for (const name of ["x".repeat(61), "a\u0000b", "a\nb", 5, null]) {
      expect(() => createApiKeyInput.parse({ name }), JSON.stringify(name)).toThrow();
    }
  });
  it("accepts known scopes and rejects unknown, empty, duplicate and extra fields", () => {
    expect(createApiKeyInput.parse({ scopes: [...API_KEY_SCOPES] }).scopes).toEqual([...API_KEY_SCOPES]);
    for (const bad of [{ scopes: [] }, { scopes: ["admin"] }, { scopes: ["ingest", "ingest"] }, { scopes: "ingest" }, { scopes: ["ingest"], extra: 1 }]) {
      expect(() => createApiKeyInput.parse(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("keys are never logged by the key code paths", () => {
  it("has no console or logger calls in the repo, routes or generator", () => {
    for (const f of [
      "lib/api-key.ts",
      "lib/repo/api-keys.ts",
      "app/api/dashboard/projects/[id]/keys/route.ts",
      "app/api/dashboard/projects/[id]/keys/[keyId]/route.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/console\.|logger\.|log\.(debug|info|warn|error)/);
    }
  });
});
