import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "@/lib/env";

const good = {
  DATABASE_URL: "postgres://u:p@h/db",
  CLERK_SECRET_KEY: "sk_test_x",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x",
  CRON_SECRET: "c".repeat(16),
  JOB_HMAC_SECRET: "j".repeat(32),
  PROVIDER_KEY_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
};

describe("parseEnv", () => {
  it("accepts a complete env and applies defaults", () => {
    const env = parseEnv(good);
    expect(env.MAX_USERS).toBe(10);
    expect(env.DEMO_SOURCE).toBe("static");
    expect(env.RESEND_API_KEY).toBeUndefined();
  });

  it("names missing variables without echoing any value", () => {
    try {
      parseEnv({ ...good, DATABASE_URL: undefined, CRON_SECRET: "tooshort-val" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const err = e as EnvError;
      expect(err.variables.sort()).toEqual(["CRON_SECRET", "DATABASE_URL"]);
      expect(err.message).not.toContain("tooshort-val");
    }
  });

  it("rejects a master key that is not 32 bytes", () => {
    expect(() => parseEnv({ ...good, PROVIDER_KEY_MASTER_KEY: "dGlueQ==" })).toThrow(EnvError);
  });
});
