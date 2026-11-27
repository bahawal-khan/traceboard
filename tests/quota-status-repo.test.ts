import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/repo/quota-status.ts against a mocked driver: statement shape (one transaction, metadata only, bound parameters), tenant
 * scoping, the single not-found behaviour and the mapping. The real database (RLS, UTC day, the conserve flag, IDOR) is
 * tests/db/quota-status.test.ts, run by the owner.
 */
const m = vi.hoisted(() => ({
  results: [] as unknown[][],
  transactions: [] as Array<Array<{ sql: string; values: unknown[] }>>,
}));

vi.mock("@/lib/db/client", () => ({
  getSql: () => ({
    transaction: (build: (t: (s: TemplateStringsArray, ...v: unknown[]) => unknown) => unknown[]) => {
      const t = (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
      m.transactions.push(build(t) as Array<{ sql: string; values: unknown[] }>);
      return Promise.resolve([[{ set_config: "x" }], ...m.results]);
    },
  }),
}));

import { QUOTAS } from "@/lib/quotas";
import { NotFoundError } from "@/lib/repo/errors";
import { readProjectStatus } from "@/lib/repo/quota-status";
import { issueCtx, type SessionCtx } from "@/lib/repo/tenant";

const PID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ctx = issueCtx<SessionCtx>({ kind: "session", ownerId: "user_a", projectIds: [PID], readOnly: false });
const status = (proj: unknown[], usage: unknown[], state: unknown[]) => {
  m.results = [proj, usage, state];
  return readProjectStatus(ctx, PID);
};

beforeEach(() => {
  m.results = [];
  m.transactions = [];
});

describe("the statements", () => {
  it("are ONE transaction of set_config + three static templates: ownership, today's usage row, the conserve flag", async () => {
    await status([{ id: PID }], [], []);
    expect(m.transactions).toHaveLength(1);
    const [, own, usage, state] = m.transactions[0]!;
    expect(m.transactions[0]).toHaveLength(4);
    expect(own!.sql).toMatch(/from projects where id = \?::uuid and owner_id = \?/);
    expect(own!.values).toEqual([PID, "user_a"]);
    expect(usage!.sql).toContain("from usage_daily where project_id = ?::uuid");
    expect(usage!.sql).toContain("(now() at time zone 'UTC')::date");
    expect(usage!.values).toEqual([PID]);
    expect(state!.sql).toContain("from app_state where key = 'conserve'");
    expect(state!.values).toEqual([]);
  });
  it("read metadata only: no events, no content, no wildcard, no writes", async () => {
    await status([{ id: PID }], [], []);
    const all = m.transactions[0]!.slice(1).map((q) => q.sql).join(" ; ");
    expect(all).not.toMatch(/\bfrom\s+(events|event_content)\b/i);
    expect(all).not.toMatch(/select\s+\*/i);
    expect(all).not.toMatch(/\b(insert|update|delete|truncate|alter|drop)\b/i);
    expect(all).not.toMatch(/prompt|content|payload|error/i);
  });
  it("the project id is only ever a bound parameter", async () => {
    await status([{ id: PID }], [], []);
    for (const q of m.transactions[0]!.slice(1)) expect(q.sql).not.toContain(PID);
  });
});

describe("tenant scoping and not-found", () => {
  it("a project that is not the caller's gives NotFoundError, and the database is never touched", async () => {
    await expect(readProjectStatus(ctx, OTHER)).rejects.toBeInstanceOf(NotFoundError);
    await expect(readProjectStatus(ctx, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
    await expect(readProjectStatus(ctx, "")).rejects.toBeInstanceOf(NotFoundError);
    expect(m.transactions).toHaveLength(0);
  });
  it("a project the database does not return (deleted, foreign by RLS) is the same NotFoundError, whatever the other rows say", async () => {
    await expect(status([], [{ events: "5" }], [{ conserve: true }])).rejects.toBeInstanceOf(NotFoundError);
    await expect(status([], [], [])).rejects.toMatchObject({ message: new NotFoundError().message });
  });
});

describe("mapping", () => {
  it("no usage row today is a real zero; the limit is the daily quota", async () => {
    expect(await status([{ id: PID }], [], [])).toEqual({ eventsToday: 0, eventsLimit: QUOTAS.eventsPerDayPerProject, conserve: false });
  });
  it("counts come back as text (bigint) and are converted", async () => {
    expect((await status([{ id: PID }], [{ events: "1700" }], [])).eventsToday).toBe(1700);
  });
  it("conserve is true only for a literal true; missing, false or anything else is false", async () => {
    expect((await status([{ id: PID }], [], [{ conserve: true }])).conserve).toBe(true);
    for (const v of [false, null, "true", 1]) expect((await status([{ id: PID }], [], [{ conserve: v }])).conserve).toBe(false);
    expect((await status([{ id: PID }], [], [])).conserve).toBe(false);
  });
  it("a nonsense count never becomes a banner-triggering number", async () => {
    expect((await status([{ id: PID }], [{ events: "garbage" }], [])).eventsToday).toBe(0);
    expect((await status([{ id: PID }], [{ events: "-5" }], [])).eventsToday).toBe(0);
  });
});
