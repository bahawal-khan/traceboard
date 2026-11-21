import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminSql, jobSql } from "./helpers/job-role";

/**
 * The storage guard (migration 0012): level written and idempotent, conserve on/off with hysteresis, claim_user_slot refusing NEW
 * users at critical while existing users keep working, and who may write app_state. app_state is GLOBAL, so every test restores it
 * (level ok, conserve as found) in afterAll; the db project runs files one at a time. Needs JOB_DATABASE_URL (app_job).
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("storage guard (database)", () => {
  const sql = neon(url!); // app_rw
  const job = jobSql(); // app_job
  const users: string[] = [];
  let levelBefore: string | null = null;

  const state = async (key: string) => ((await sql`select value #>> '{}' as v from app_state where key = ${key}`)[0]?.v as string | undefined) ?? null;
  const stamp = async (key: string) => ((await sql`select updated_at::text as t from app_state where key = ${key}`)[0]?.t as string | undefined) ?? null;
  const apply = async (level: string) => (await job`select * from apply_storage_level(${level})`)[0]!;
  const claim = async (user: string, max = 100000) => (await sql`select claim_user_slot(${user}, ${max}) as s`)[0]!.s as string;
  const newUser = () => {
    const u = `test_${randomUUID()}`;
    users.push(u);
    return u;
  };
  const release = (owner: string) => sql.transaction((t) => [t`select set_config('app.owner_id', ${owner}, true)`, t`select release_user_slot()`]);

  beforeAll(async () => {
    levelBefore = await state("storage_level");
  });
  afterAll(async () => {
    // Leave the guard as found. Signups must never stay paused for the next test file: end at ok, then restore a pre-existing warn/critical.
    await apply("ok");
    if (levelBefore === "warn" || levelBefore === "critical") await apply(levelBefore);
    for (const u of users) await release(u);
  });

  describe("levels (hysteresis)", () => {
    const level = async (prev: string | null, ratio: number) => (await job`select storage_level_for(${prev}, ${ratio}::numeric) as l`)[0]!.l as string;

    it("enters warn at 70% and critical at 85%", async () => {
      expect(await level("ok", 0.69)).toBe("ok");
      expect(await level("ok", 0.7)).toBe("warn");
      expect(await level("ok", 0.849)).toBe("warn");
      expect(await level("ok", 0.85)).toBe("critical");
      expect(await level("ok", 3)).toBe("critical");
      expect(await level(null, 0.1)).toBe("ok");
    });

    it("leaves a level only 5 points below its threshold, so a reading at the edge does not flap", async () => {
      expect(await level("critical", 0.84)).toBe("critical");
      expect(await level("critical", 0.8)).toBe("critical");
      expect(await level("critical", 0.79)).toBe("warn");
      expect(await level("warn", 0.69)).toBe("warn");
      expect(await level("warn", 0.65)).toBe("warn");
      expect(await level("warn", 0.64)).toBe("ok");
      expect(await level("critical", 0.5)).toBe("ok");
      expect(await level("ok", 0.67)).toBe("ok"); // no hysteresis when coming from ok
    });
  });

  describe("apply_storage_level: level and conserve flag", () => {
    it("writes the level; warn and critical turn conserve on; going back to ok turns it off", async () => {
      await apply("ok");
      expect(await state("storage_level")).toBe("ok");

      expect(await apply("warn")).toMatchObject({ level: "warn", conserve: true, signups_paused: false });
      expect(await state("storage_level")).toBe("warn");
      expect(await state("conserve")).toBe("true");

      expect(await apply("critical")).toMatchObject({ level: "critical", previous_level: "warn", conserve: true, signups_paused: true });
      expect(await state("storage_level")).toBe("critical");
      expect(await state("conserve")).toBe("true");

      expect(await apply("ok")).toMatchObject({ level: "ok", previous_level: "critical", conserve: false, signups_paused: false });
      expect(await state("storage_level")).toBe("ok");
      expect(await state("conserve")).toBe("false");
    });

    it("is idempotent: a repeat with the same level changes no row (updated_at does not move)", async () => {
      await apply("warn");
      const [lvl, con] = [await stamp("storage_level"), await stamp("conserve")];
      const again = await apply("warn");
      expect(again).toMatchObject({ level: "warn", previous_level: "warn", conserve: true });
      expect(await stamp("storage_level")).toBe(lvl);
      expect(await stamp("conserve")).toBe(con);
      await apply("ok");
      const [lvl2, con2] = [await stamp("storage_level"), await stamp("conserve")];
      await apply("ok");
      expect(await stamp("storage_level")).toBe(lvl2);
      expect(await stamp("conserve")).toBe(con2);
    });

    it("a conserve flag set by an operator (as the owner) while the level is ok is left alone by a repeat ok run", async () => {
      if (!process.env.MIGRATION_DATABASE_URL) return; // only the owner can write app_state directly; skipped without MIGRATION_DATABASE_URL
      const admin = adminSql();
      await apply("ok");
      await admin`insert into app_state (key, value) values ('conserve', 'true'::jsonb) on conflict (key) do update set value = 'true'::jsonb`;
      try {
        await apply("ok"); // ok -> ok: must not touch conserve
        expect(await state("conserve")).toBe("true");
        await apply("warn");
        await apply("ok"); // warn -> ok: now it is turned off
        expect(await state("conserve")).toBe("false");
      } finally {
        await admin`update app_state set value = 'false'::jsonb where key = 'conserve'`;
      }
    });

    it("rejects an unknown or null level", async () => {
      for (const bad of ["", "OK", "panic", "warn; drop table app_state"]) {
        await expect(job`select * from apply_storage_level(${bad})`).rejects.toThrow(/invalid level/i);
      }
      await expect(job`select * from apply_storage_level(null)`).rejects.toThrow(/invalid level/i);
    });

    it("the ingest path sees the flag: flush_hint source (app_state conserve) reads true under warn and false after", async () => {
      await apply("warn");
      expect((await sql`select coalesce((select value = 'true'::jsonb from app_state where key = 'conserve'), false) as c`)[0]!.c).toBe(true);
      await apply("ok");
      expect((await sql`select coalesce((select value = 'true'::jsonb from app_state where key = 'conserve'), false) as c`)[0]!.c).toBe(false);
    });
  });

  describe("apply_storage_guard: the measured path the job calls", () => {
    it("measures, records a level consistent with storage_level_for, and is idempotent on re-run", async () => {
      await apply("ok");
      const first = (await job`select level, previous_level, ratio::text as ratio, conserve, signups_paused from apply_storage_guard()`)[0]!;
      const [rep] = await job`select events_ratio::text as er, database_bytes::text as db from storage_report()`;
      const expected = Math.max(Number(rep!.er), Number(rep!.db) / 1_000_000_000);
      expect(Math.abs(Number(first.ratio) - expected)).toBeLessThan(0.01); // sizes move between the two calls, a little
      const want = (await job`select storage_level_for('ok', ${first.ratio}::numeric) as l`)[0]!.l;
      expect(first.level).toBe(want);
      expect(await state("storage_level")).toBe(first.level);
      expect(first.signups_paused).toBe(first.level === "critical");
      const second = (await job`select level, previous_level from apply_storage_guard()`)[0]!;
      expect(second.level).toBe(first.level); // same database, same level (no flapping)
      expect(second.previous_level).toBe(first.level);
    });
  });

  describe("claim_user_slot at critical", () => {
    it("refuses NEW users with 'paused' at critical, creates nothing, and accepts them again below it", async () => {
      const before = (await sql`select app_user_count() as n`)[0]!.n as number;
      await apply("critical");
      const u = newUser();
      expect(await claim(u)).toBe("paused");
      expect((await sql`select app_user_count() as n`)[0]!.n).toBe(before);

      await apply("warn"); // warn still allows signups
      expect(await claim(u)).toBe("created");
      await apply("ok");
    });

    it("existing users are never affected: claiming again at critical returns 'existing'", async () => {
      await apply("ok");
      const u = newUser();
      expect(await claim(u)).toBe("created");
      await apply("critical");
      expect(await claim(u)).toBe("existing");
      await apply("ok");
    });

    it("the full-cap answer is unchanged below critical, and at critical the pause answers first for a NEW user", async () => {
      await apply("ok");
      expect(await claim(newUser())).toBe("created"); // at least one user exists, so cap = count leaves no room
      const used = (await sql`select app_user_count() as n`)[0]!.n as number;
      const u = newUser();
      expect(await claim(u, used)).toBe("full"); // cap = current count: nobody new fits
      await apply("critical");
      expect(await claim(u, used)).toBe("paused");
      await apply("ok");
    });

    it("input validation is unchanged", async () => {
      await expect(sql`select claim_user_slot('', 10)`).rejects.toThrow(/invalid user id/i);
      await expect(sql`select claim_user_slot('u', 0)`).rejects.toThrow(/invalid max/i);
    });
  });

  describe("who may write app_state", () => {
    it("app_rw cannot write the guard keys (or any key): INSERT and UPDATE are refused, SELECT still works", async () => {
      await expect(sql`update app_state set value = '"ok"'::jsonb where key = 'storage_level'`).rejects.toThrow(/permission denied/i);
      await expect(sql`insert into app_state (key, value) values ('storage_level', '"critical"'::jsonb) on conflict (key) do update set value = excluded.value`).rejects.toThrow(/permission denied/i);
      await expect(sql`insert into app_state (key, value) values ('conserve', 'true'::jsonb) on conflict (key) do update set value = excluded.value`).rejects.toThrow(/permission denied/i);
      await expect(sql`delete from app_state where key = 'conserve'`).rejects.toThrow(/permission denied/i);
      expect((await sql`select count(*)::int as n from app_state`)[0]!.n).toBeGreaterThanOrEqual(0);
    });

    it("app_job has no direct access to app_state; it can write only through the functions, and only the two guard keys", async () => {
      await expect(job`select * from app_state`).rejects.toThrow(/permission denied/i);
      await expect(job`insert into app_state (key, value) values ('anything', '1'::jsonb)`).rejects.toThrow(/permission denied/i);
      await expect(job`update app_state set value = '1'::jsonb`).rejects.toThrow(/permission denied/i);
      await expect(job`delete from app_state`).rejects.toThrow(/permission denied/i);
      await apply("ok");
      await apply("warn");
      await apply("ok");
      const keys = (await sql`select key from app_state`).map((r) => r.key as string);
      expect(keys).toEqual(expect.arrayContaining(["storage_level", "conserve"]));
    });

    it("another tenant (an ordinary signed-in user's session) has no way to reach the writers", async () => {
      for (const call of [
        () => sql`select * from apply_storage_level('critical')`,
        () => sql`select * from apply_storage_guard()`,
        () => sql`select storage_level_for('ok', 1)`,
      ]) await expect(call()).rejects.toThrow(/permission denied/i);
    });
  });
});
