import { neonConfig } from "@neondatabase/serverless";
import { afterEach, describe, expect, it } from "vitest";
import { configureLocalNeon, LOCAL_NEON_HOST } from "@/db/neon-local.mjs";

describe("configureLocalNeon", () => {
  const original = neonConfig.fetchEndpoint;
  afterEach(() => {
    neonConfig.fetchEndpoint = original;
  });

  it("points the driver at the local proxy over http only for the local host", () => {
    expect(configureLocalNeon(`postgres://u:p@${LOCAL_NEON_HOST}:5432/main`)).toBe(true);
    const fe = neonConfig.fetchEndpoint as (host: string) => string;
    expect(fe(LOCAL_NEON_HOST)).toBe("http://db.localtest.me:4444/sql");
    expect(fe("ep-cool-123.us-east-2.aws.neon.tech")).toBe("https://ep-cool-123.us-east-2.aws.neon.tech/sql");
  });

  it("does nothing for real Neon hosts, invalid strings and missing values", () => {
    for (const v of ["postgres://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/neondb", "not a url", "", undefined, null]) {
      neonConfig.fetchEndpoint = original;
      expect(configureLocalNeon(v as string), String(v)).toBe(false);
      expect(neonConfig.fetchEndpoint).toBe(original);
    }
  });
});
