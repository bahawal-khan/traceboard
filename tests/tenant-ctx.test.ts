import { describe, expect, it } from "vitest";
import { TenantError, issueCtx, withTenant, type TenantCtx } from "@/lib/repo/tenant";
import { hashApiKey, looksLikeApiKey } from "@/lib/api-key";

const PID = "11111111-1111-4111-8111-111111111111";

describe("tenant context cannot be forged", () => {
  it("is a compile error to build a context by hand", () => {
    // @ts-expect-error the brand is unreachable outside lib/repo/tenant.ts
    const forged: TenantCtx = { kind: "session", ownerId: "user_x", projectIds: [PID], readOnly: false };
    expect(forged).toBeDefined();
  });

  it("withTenant rejects a context that was cast into existence (no db access happens)", async () => {
    const forged = { kind: "session", ownerId: "user_x", projectIds: [PID], readOnly: false } as unknown as TenantCtx;
    await expect(withTenant(forged, () => [])).rejects.toBeInstanceOf(TenantError);
    await expect(withTenant(null as unknown as TenantCtx, () => [])).rejects.toBeInstanceOf(TenantError);
  });

  it("rejects a spread copy of a genuine context", async () => {
    const real = issueCtx({ kind: "demo", ownerId: null, projectIds: [PID], readOnly: true });
    await expect(withTenant({ ...real } as TenantCtx, () => [])).rejects.toBeInstanceOf(TenantError);
  });

  it("validates ids and freezes issued contexts", () => {
    expect(() => issueCtx({ kind: "demo", ownerId: null, projectIds: ["a,b"], readOnly: true })).toThrow();
    const c = issueCtx({ kind: "demo", ownerId: null, projectIds: [PID], readOnly: true });
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.projectIds)).toBe(true);
    expect(() => {
      (c.projectIds as string[]).push("x");
    }).toThrow();
  });
});

describe("api key helpers", () => {
  it("accepts only the lm_ + 43 base64url shape", () => {
    expect(looksLikeApiKey(`lm_${"A".repeat(43)}`)).toBe(true);
    expect(looksLikeApiKey(`lm_${"A".repeat(42)}`)).toBe(false);
    expect(looksLikeApiKey(`xx_${"A".repeat(43)}`)).toBe(false);
    expect(looksLikeApiKey(`lm_${"A".repeat(42)}'`)).toBe(false);
    expect(looksLikeApiKey("")).toBe(false);
  });

  it("hashes to sha256 hex deterministically", () => {
    const h = hashApiKey("lm_x");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey("lm_x")).toBe(h);
    expect(hashApiKey("lm_y")).not.toBe(h);
  });
});
