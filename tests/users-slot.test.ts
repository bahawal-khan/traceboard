import { beforeEach, describe, expect, it, vi } from "vitest";

/** ensureSignedInUserSlot: the answers of claim_user_slot reach the dashboard layout. Clerk and the driver are mocked. */
const m = vi.hoisted(() => ({ userId: "user_1" as string | null, status: "created" as unknown, calls: [] as unknown[][] }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: m.userId }) }));
vi.mock("@/lib/db/client", () => ({
  getSql: () => (_s: TemplateStringsArray, ...values: unknown[]) => {
    m.calls.push(values);
    return Promise.resolve([{ status: m.status }]);
  },
}));

import { ensureSignedInUserSlot } from "@/lib/repo/users";

beforeEach(() => {
  m.userId = "user_1";
  m.status = "created";
  m.calls = [];
  process.env.MAX_USERS = "7";
});

describe("ensureSignedInUserSlot", () => {
  it("returns every status claim_user_slot can answer, including paused (storage guard at critical)", async () => {
    for (const status of ["existing", "created", "full", "paused"]) {
      m.status = status;
      expect(await ensureSignedInUserSlot()).toBe(status);
    }
  });

  it("passes the signed-in user and the configured cap to the database, nothing else", async () => {
    await ensureSignedInUserSlot();
    expect(m.calls).toEqual([["user_1", 7]]);
  });

  it("answers signed_out without touching the database when there is no session", async () => {
    m.userId = null;
    expect(await ensureSignedInUserSlot()).toBe("signed_out");
    expect(m.calls).toEqual([]);
  });

  it("rejects an answer it does not know instead of letting the user in", async () => {
    for (const bad of ["ok", "", null, undefined, 1]) {
      m.status = bad;
      await expect(ensureSignedInUserSlot()).rejects.toThrow("unexpected claim_user_slot result");
    }
  });
});
