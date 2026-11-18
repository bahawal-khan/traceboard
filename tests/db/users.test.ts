import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { ensureSignedInUserSlot } from "@/lib/repo/users";

/** MAX_USERS cap: atomic under concurrency, existing users never locked out. As app_rw; skipped without DATABASE_URL. */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("MAX_USERS signup cap (claim_user_slot)", () => {
  const sql = neon(url!);
  const created: string[] = [];
  const newUser = () => {
    const u = `test_${randomUUID()}`;
    created.push(u);
    return u;
  };
  const claim = async (user: string, max: number) => (await sql`select claim_user_slot(${user}, ${max}) as s`)[0].s as string;
  const release = (owner: string) =>
    sql.transaction((t) => [t`select set_config('app.owner_id', ${owner}, true)`, t`select release_user_slot()`]);

  const used = async () => (await sql`select app_user_count() as n`)[0].n as number;

  afterAll(async () => {
    for (const u of created) await release(u);
  });

  it("creates a slot, then reports existing", async () => {
    const u = newUser();
    expect(await claim(u, 100000)).toBe("created");
    expect(await claim(u, 100000)).toBe("existing");
  });

  it("refuses a new user when the cap is reached, but never locks out an existing user", async () => {
    const existing = newUser();
    expect(await claim(existing, 100000)).toBe("created");
    const n = await used();
    const newcomer = newUser();
    expect(await claim(newcomer, n)).toBe("full"); // cap == current count: no room
    expect(await claim(existing, n)).toBe("existing"); // existing user still allowed
    expect(await claim(existing, 1)).toBe("existing");
  });

  it("holds the cap under concurrent signups: 8 simultaneous new users, 3 free slots", async () => {
    const before = await used();
    const cap = before + 3;
    const users = Array.from({ length: 8 }, newUser);
    const results = await Promise.all(users.map((u) => claim(u, cap)));
    expect(results.filter((r) => r === "created")).toHaveLength(3);
    expect(results.filter((r) => r === "full")).toHaveLength(5);
    expect(await used()).toBe(cap);
  });

  it("release frees exactly the caller's own slot", async () => {
    const a = newUser();
    const b = newUser();
    await claim(a, 100000);
    await claim(b, 100000);
    await release(a);
    expect(await claim(a, 100000)).toBe("created"); // slot was free again
    expect(await claim(b, 100000)).toBe("existing"); // b untouched
    const [noOwner] = await sql`select release_user_slot() as r`; // no app.owner_id: does nothing
    expect(noOwner.r).toBe(false);
  });

  it("app_user_count() returns a number and exposes no ids", async () => {
    const before = await used();
    const u = newUser();
    await claim(u, 100000);
    expect(await used()).toBe(before + 1);
  });

  it("validates input", async () => {
    await expect(sql`select claim_user_slot('', 10)`).rejects.toThrow(/invalid user id/i);
    await expect(sql`select claim_user_slot(${"x".repeat(129)}, 10)`).rejects.toThrow(/invalid user id/i);
    await expect(sql`select claim_user_slot('u', 0)`).rejects.toThrow(/invalid max/i);
    await expect(sql`select claim_user_slot('u', 100001)`).rejects.toThrow(/invalid max/i);
  });

  it("app_rw cannot write app_users directly and sees only its own row", async () => {
    const u = newUser();
    await claim(u, 100000);
    await expect(sql`insert into app_users (user_id) values ('test_sneaky')`).rejects.toThrow(/permission denied/i);
    await expect(sql`delete from app_users`).rejects.toThrow(/permission denied/i);
    const [none] = await sql`select count(*)::int as n from app_users`;
    expect(none.n).toBe(0); // no owner scope: fail closed
    const [, mine] = await sql.transaction((t) => [t`select set_config('app.owner_id', ${u}, true)`, t`select user_id from app_users`]);
    expect(mine).toEqual([{ user_id: u }]);
  });

  describe("ensureSignedInUserSlot()", () => {
    it("returns signed_out without a session", async () => {
      mockAuth.mockResolvedValue({ userId: null });
      expect(await ensureSignedInUserSlot()).toBe("signed_out");
    });

    it("creates then reports existing for a signed-in user (MAX_USERS from env)", async () => {
      vi.stubEnv("MAX_USERS", "100000");
      const u = newUser();
      mockAuth.mockResolvedValue({ userId: u });
      expect(await ensureSignedInUserSlot()).toBe("created");
      expect(await ensureSignedInUserSlot()).toBe("existing");
      vi.unstubAllEnvs();
    });

    it("returns full when the env cap equals the number of users", async () => {
      const n = await used();
      vi.stubEnv("MAX_USERS", String(Math.max(n, 1)));
      const u = newUser();
      mockAuth.mockResolvedValue({ userId: u });
      expect(await ensureSignedInUserSlot()).toBe("full");
      vi.unstubAllEnvs();
    });
  });
});
