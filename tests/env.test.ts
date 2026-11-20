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

describe("CONTENT_ENCRYPTION_KEY", () => {
  const key = Buffer.alloc(32, 7).toString("base64");

  it("is optional: absent or empty means content capture is unavailable", () => {
    expect(parseEnv(good).CONTENT_ENCRYPTION_KEY).toBeUndefined();
    expect(parseEnv({ ...good, CONTENT_ENCRYPTION_KEY: "" }).CONTENT_ENCRYPTION_KEY).toBeUndefined();
  });

  it("accepts a 32-byte base64 key", () => {
    expect(parseEnv({ ...good, CONTENT_ENCRYPTION_KEY: key }).CONTENT_ENCRYPTION_KEY).toBe(key);
  });

  it("rejects a key of the wrong length or that is not base64, naming only the variable", () => {
    for (const bad of ["dGlueQ==", Buffer.alloc(16, 1).toString("base64"), Buffer.alloc(64, 1).toString("base64"), "not base64 at all!!"]) {
      try {
        parseEnv({ ...good, CONTENT_ENCRYPTION_KEY: bad });
        expect.unreachable(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(EnvError);
        expect((e as EnvError).variables).toEqual(["CONTENT_ENCRYPTION_KEY"]);
        expect((e as EnvError).message).not.toContain(bad);
      }
    }
  });

  it("must differ from the provider-key master key (key separation)", () => {
    expect(() => parseEnv({ ...good, CONTENT_ENCRYPTION_KEY: good.PROVIDER_KEY_MASTER_KEY })).toThrow(EnvError);
    expect(() => parseEnv({ ...good, CONTENT_ENCRYPTION_KEY: key })).not.toThrow();
  });
});

