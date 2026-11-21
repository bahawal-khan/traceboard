import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { DecryptionError, looksEncrypted } from "@/lib/crypto";
import { PgEventStore } from "@/lib/events/pg-store";
import { contentAad, createContentCipher } from "@/lib/ingest/content";
import type { NormalizedEvent } from "@/lib/ingest/normalize";
import { QUOTAS, RETENTION } from "@/lib/quotas";
import { createApiKey } from "@/lib/repo/api-keys";
import { ctxFromApiKey, ctxFromSession } from "@/lib/repo/ctx";
import { createProject } from "@/lib/repo/projects";
import { ensureEventPartitions } from "./helpers/job-role";
import { cleanupOwners } from "./helpers/cleanup";

/** Opt-in, encrypted, expiring content capture. Real database as app_rw. Skipped without DATABASE_URL. */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

run("event content (database)", () => {
  const sql = neon(url!);
  const users: string[] = [];
  const cipher = createContentCipher(randomBytes(32));
  const store = new PgEventStore({ cipher });
  const raw = (owner: string, ids: string[], build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${owner}, true), set_config('app.project_ids', ${ids.join(",")}, true)`,
      ...build(t),
    ]);
  const q = async (x: { owner: string; project: string }, text: string) => (await raw(x.owner, [x.project], (t) => [t.query(text)]))[1] as Record<string, unknown>[];

  const tenant = async (opts: { capture?: boolean; retentionDays?: number } = {}) => {
    const owner = `test_${randomUUID()}`;
    users.push(owner);
    await sql`select claim_user_slot(${owner}, 100000)`;
    mockAuth.mockResolvedValue({ userId: owner });
    const project = (await createProject((await ctxFromSession())!, { name: "content-test" })).id;
    const { secret } = await createApiKey((await ctxFromSession())!, project, { scopes: ["ingest"] });
    if (opts.capture !== undefined || opts.retentionDays !== undefined) {
      await raw(owner, [project], (t) => [
        t`update projects set capture_content = ${opts.capture ?? false}, content_retention_days = ${opts.retentionDays ?? 7} where id = ${project}`,
      ]);
    }
    return { owner, project, ctx: (await ctxFromApiKey(secret))! };
  };
  const base = Date.now() - 3600_000;
  const ev = (o: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
    eventId: randomUUID(), occurredAt: new Date(base),
    traceId: null, spanId: null, parentId: null, threadId: null, kind: "llm", name: null, model: null, provider: null,
    inputTokens: null, outputTokens: null, cachedTokens: null, latencyMs: null, ttftMs: null, costMicro: null, costUsd: null,
    status: "ok", error: null, promptHash: null, argsHash: null, userIdHash: null, tags: null,
    content: { input: "SENTINEL-PROMPT mail jane@example.com", output: "SENTINEL-ANSWER" },
    ...o,
  });

  beforeAll(async () => {
    await ensureEventPartitions();
  });
  afterAll(async () => {
    await cleanupOwners(sql, users); // one round trip for all users (tests/db/helpers/cleanup.ts)
  });

  it("is OFF by default: no content row is stored, but the event is", async () => {
    const a = await tenant();
    const r = await store.persist(a.ctx, [ev()]);
    expect(r.inserted).toBe(1);
    expect(r.contentStored).toBe(0);
    expect(await q(a, "select count(*)::int as n from event_content")).toEqual([{ n: 0 }]);
    expect(await q(a, "select count(*)::int as n from events")).toEqual([{ n: 1 }]);
  });

  it("when the project opted in, stores ONLY ciphertext that decrypts with the right context", async () => {
    const a = await tenant({ capture: true });
    const e = ev();
    const r = await store.persist(a.ctx, [e]);
    expect(r.contentStored).toBe(1);
    const [row] = await q(a, `select input_text, output_text, redaction_report, project_id from event_content where event_id = '${e.eventId}'`);
    expect(looksEncrypted(String(row!.input_text))).toBe(true);
    expect(looksEncrypted(String(row!.output_text))).toBe(true);
    expect(row!.project_id).toBe(a.project);
    expect(cipher.decrypt(String(row!.input_text), contentAad(a.project, e.eventId, "input"))).toBe("SENTINEL-PROMPT mail [redacted:email]");
    expect(cipher.decrypt(String(row!.output_text), contentAad(a.project, e.eventId, "output"))).toBe("SENTINEL-ANSWER");
    expect(() => cipher.decrypt(String(row!.input_text), contentAad(a.project, e.eventId, "output"))).toThrow(DecryptionError);
    expect(row!.redaction_report).toMatchObject({ v: 1, enc: "aes-256-gcm", keyVersion: 1, redactions: { email: 1 }, truncated: false });
  });

  it("no plaintext sentinel exists anywhere in the tenant's rows (events, content, rollups)", async () => {
    const a = await tenant({ capture: true });
    await store.persist(a.ctx, [ev(), ev()]);
    for (const table of ["events", "event_content", "metrics_minute", "metrics_hourly", "usage_daily"]) {
      const rows = await q(a, `select row_to_json(t)::text as j from ${table} t`);
      for (const r of rows) {
        expect(String(r.j), table).not.toContain("SENTINEL");
        expect(String(r.j), table).not.toContain("jane@example.com");
      }
    }
  });

  it("retention is the project's days capped by the platform limit", async () => {
    const wide = await tenant({ capture: true, retentionDays: 30 });
    const narrow = await tenant({ capture: true, retentionDays: 1 });
    await store.persist(wide.ctx, [ev()]);
    await store.persist(narrow.ctx, [ev()]);
    const days = async (x: typeof wide) =>
      ((await q(x, "select extract(epoch from (expires_at - now())) / 86400 as d from event_content"))[0]!.d as number);
    const w = Number(await days(wide));
    const n = Number(await days(narrow));
    expect(w).toBeGreaterThan(RETENTION.contentDays - 0.05);
    expect(w).toBeLessThanOrEqual(RETENTION.contentDays);
    expect(n).toBeGreaterThan(0.95);
    expect(n).toBeLessThanOrEqual(1);
  });

  it("a duplicate batch stores content once and does not rewrite it", async () => {
    const a = await tenant({ capture: true });
    const batch = [ev(), ev()];
    expect((await store.persist(a.ctx, batch)).contentStored).toBe(2);
    const before = await q(a, "select event_id, input_text, output_text, expires_at from event_content order by event_id");
    const again = await store.persist(a.ctx, batch);
    expect(again.inserted).toBe(0);
    expect(again.contentStored).toBe(0);
    expect(await q(a, "select event_id, input_text, output_text, expires_at from event_content order by event_id")).toEqual(before);
  });

  it("without an encryption key, nothing is stored (and certainly nothing in clear)", async () => {
    const a = await tenant({ capture: true });
    const r = await new PgEventStore({ cipher: null }).persist(a.ctx, [ev()]);
    expect(r.inserted).toBe(1);
    expect(r.contentStored).toBe(0);
    expect(await q(a, "select count(*)::int as n from event_content")).toEqual([{ n: 0 }]);
  });

  it("events without content never create a content row, even when capture is on", async () => {
    const a = await tenant({ capture: true });
    const r = await store.persist(a.ctx, [ev({ content: null }), ev({ content: {} })]);
    expect(r.inserted).toBe(2);
    expect(r.contentStored).toBe(0);
  });

  it("IDOR: the same event id in two projects keeps two independent content rows, each visible only to its owner", async () => {
    const a = await tenant({ capture: true });
    const b = await tenant({ capture: true });
    const e = ev();
    expect((await store.persist(b.ctx, [e])).contentStored).toBe(1); // B first: must not block A
    expect((await store.persist(a.ctx, [e])).contentStored).toBe(1);
    const rowA = (await q(a, `select input_text from event_content where event_id = '${e.eventId}'`))[0]!;
    const rowB = (await q(b, `select input_text from event_content where event_id = '${e.eventId}'`))[0]!;
    expect(rowA.input_text).not.toBe(rowB.input_text);
    // Each decrypts only under its own project: a tenant's ciphertext is useless in the other's context.
    expect(cipher.decrypt(String(rowA.input_text), contentAad(a.project, e.eventId, "input"))).toContain("SENTINEL-PROMPT");
    expect(() => cipher.decrypt(String(rowA.input_text), contentAad(b.project, e.eventId, "input"))).toThrow(DecryptionError);
    expect(await q(a, `select count(*)::int as n from event_content where project_id = '${b.project}'`)).toEqual([{ n: 0 }]);
  });

  it("a project that opts out stores nothing for later batches", async () => {
    const a = await tenant({ capture: true });
    await store.persist(a.ctx, [ev()]);
    await raw(a.owner, [a.project], (t) => [t`update projects set capture_content = false where id = ${a.project}`]);
    expect((await store.persist(a.ctx, [ev()])).contentStored).toBe(0);
    expect(await q(a, "select count(*)::int as n from event_content")).toEqual([{ n: 1 }]);
  });

  it("the primary key of event_content is (project_id, event_id)", async () => {
    const rows = await sql`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'public.event_content'::regclass and i.indisprimary order by a.attname`;
    expect(rows.map((r) => r.attname)).toEqual(["event_id", "project_id"]);
  });

  describe("daily content cap (QUOTAS.contentRowsPerDayPerProject)", () => {
    const CAP = QUOTAS.contentRowsPerDayPerProject;
    const many = (n: number) => Array.from({ length: n }, () => ev());
    const counters = async (x: { owner: string; project: string }) =>
      (await q(x, "select content_rows::int as rows, events::int as events from usage_daily where day = (now() at time zone 'UTC')::date"))[0]!;

    it("stores up to the cap, drops the rest, and still stores EVERY event", async () => {
      const a = await tenant({ capture: true });
      const r = await store.persist(a.ctx, many(CAP + 5));
      expect(r.inserted).toBe(CAP + 5);
      expect(r.contentStored).toBe(CAP);
      expect(r.contentDropped).toBe(5);
      expect(await q(a, "select count(*)::int as n from event_content")).toEqual([{ n: CAP }]);
      expect(await counters(a)).toEqual({ rows: CAP, events: CAP + 5 });
    });

    it("once the cap is reached, later batches store no content and report it dropped; counters do not move", async () => {
      const a = await tenant({ capture: true });
      await store.persist(a.ctx, many(CAP));
      const r = await store.persist(a.ctx, many(3));
      expect(r).toMatchObject({ inserted: 3, contentStored: 0, contentDropped: 3 });
      expect(await counters(a)).toEqual({ rows: CAP, events: CAP + 3 });
    });

    it("fills the remaining slots exactly (cap - 2 stored, then a batch of 5 keeps 2 and drops 3)", async () => {
      const a = await tenant({ capture: true });
      expect((await store.persist(a.ctx, many(CAP - 2))).contentStored).toBe(CAP - 2);
      const r = await store.persist(a.ctx, many(5));
      expect(r).toMatchObject({ contentStored: 2, contentDropped: 3 });
      expect((await counters(a)).rows).toBe(CAP);
    });

    it("duplicates, events without content, and projects with capture off consume no slots and are not reported as dropped", async () => {
      const a = await tenant({ capture: true });
      const batch = many(4);
      await store.persist(a.ctx, batch);
      const dup = await store.persist(a.ctx, batch);
      expect(dup).toMatchObject({ inserted: 0, contentStored: 0, contentDropped: 0 });
      const none = await store.persist(a.ctx, [ev({ content: null }), ev({ content: {} })]);
      expect(none).toMatchObject({ contentStored: 0, contentDropped: 0 });
      expect((await counters(a)).rows).toBe(4);

      const off = await tenant();
      const r = await store.persist(off.ctx, many(3));
      expect(r).toMatchObject({ contentStored: 0, contentDropped: 0 });
      expect((await counters(off)).rows).toBe(0);
    });

    it("the cap is per project: another tenant at its cap does not affect this one, and it sees only its own counter", async () => {
      const a = await tenant({ capture: true });
      const b = await tenant({ capture: true });
      await store.persist(a.ctx, many(CAP));
      expect((await store.persist(b.ctx, many(2))).contentStored).toBe(2);
      expect((await counters(b)).rows).toBe(2);
      // content_slots_left is SECURITY INVOKER: under A's session B's counter is invisible (RLS), so it reports a full allowance.
      const [mine] = await raw(a.owner, [a.project], (t) => [t`select content_slots_left(${b.project}::uuid, ${CAP}::int) as n`]).then((r) => r[1] as { n: number }[]);
      expect(mine!.n).toBe(CAP);
    });

    it("the cap counts today's UTC day only: yesterday's counter does not block today", async () => {
      const a = await tenant({ capture: true });
      await store.persist(a.ctx, many(CAP));
      await raw(a.owner, [a.project], (t) => [t`update usage_daily set day = day - 1 where project_id = ${a.project}`]);
      const r = await store.persist(a.ctx, many(2));
      expect(r).toMatchObject({ contentStored: 2, contentDropped: 0 });
    });
  });
});
