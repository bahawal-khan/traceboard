import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { demoSnapshotSchema } from "@/lib/dashboard/types";
import {
  DEMO_ANCHOR_MS,
  DEMO_PRICES,
  UNPRICED_DEMO_MODEL,
  generateDemoEvents,
  generateDemoSnapshot,
  rollupEvents,
  serializeDemoSnapshot,
} from "@/lib/demo/generate";
import { QUOTAS } from "@/lib/quotas";

const FILE = "lib/demo/snapshot.json";
const snapshot = generateDemoSnapshot();

// `npm run demo:snapshot` regenerates the committed file. Without the flag this test only COMPARES.
if (process.env.UPDATE_DEMO_SNAPSHOT === "1") {
  writeFileSync(FILE, serializeDemoSnapshot(snapshot));
}

describe("demo snapshot file", () => {
  it("is committed and equals what the generator produces now (run `npm run demo:snapshot` after changing the generator)", () => {
    expect(existsSync(FILE)).toBe(true);
    expect(readFileSync(FILE, "utf8")).toBe(serializeDemoSnapshot(snapshot));
  });
  it("passes its own strict schema", () => {
    expect(() => demoSnapshotSchema.parse(JSON.parse(readFileSync(FILE, "utf8")))).not.toThrow();
  });
  it("is deterministic: two generations are identical", () => {
    expect(serializeDemoSnapshot(generateDemoSnapshot())).toBe(serializeDemoSnapshot(snapshot));
  });
  it("stays small enough to ship in the bundle (under 400 KB)", () => {
    expect(readFileSync(FILE).length).toBeLessThan(400_000);
  });
});

describe("demo traffic respects the free tier and the rollup rules", () => {
  const events = generateDemoEvents();

  it("never exceeds the per-project daily event quota on any UTC day", () => {
    const perDay = new Map<number, number>();
    for (const e of events) {
      const d = Math.floor(e.startMs / 86_400_000);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    expect(perDay.size).toBeGreaterThanOrEqual(7);
    for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(QUOTAS.eventsPerDayPerProject);
  });
  it("only has events inside the 7-day window ending at the anchor", () => {
    for (const e of events) {
      expect(e.startMs).toBeGreaterThanOrEqual(DEMO_ANCHOR_MS - 7 * 86_400_000);
      expect(e.startMs).toBeLessThan(DEMO_ANCHOR_MS);
    }
  });
  it("rolls up every event exactly once (calls, errors, tokens, cost)", () => {
    const rows = rollupEvents(events);
    expect(rows.reduce((s, r) => s + r.calls, 0)).toBe(events.length);
    expect(rows.reduce((s, r) => s + r.errors, 0)).toBe(events.filter((e) => e.status === "error").length);
    expect(rows.reduce((s, r) => s + r.inputTokens, 0)).toBe(events.reduce((s, e) => s + (e.inputTokens ?? 0), 0));
    expect(rows.reduce((s, r) => s + r.costMicro, 0)).toBe(events.reduce((s, e) => s + (e.costMicro ?? 0), 0));
    for (const r of rows) expect(r.lat.reduce((a, b) => a + b, 0)).toBe(r.calls); // every demo event has a latency
  });
  it("adds nothing to cost for the unpriced model, and gives it a null cost (never 0)", () => {
    const unpriced = events.filter((e) => e.model === UNPRICED_DEMO_MODEL);
    expect(unpriced.length).toBeGreaterThan(20);
    for (const e of unpriced) expect(e.costMicro).toBeNull();
    for (const r of rollupEvents(events).filter((x) => x.model === UNPRICED_DEMO_MODEL)) expect(r.costMicro).toBe(0);
    expect(Object.keys(DEMO_PRICES)).not.toContain(UNPRICED_DEMO_MODEL);
    expect(snapshot.pricedModels).not.toContain(UNPRICED_DEMO_MODEL);
  });
  it("counts today's events from the start of the anchor's UTC day", () => {
    const start = Math.floor(DEMO_ANCHOR_MS / 86_400_000) * 86_400_000;
    expect(snapshot.usage.eventsToday).toBe(events.filter((e) => e.startMs >= start).length);
    expect(snapshot.usage.eventsToday).toBeGreaterThan(0);
  });
});

describe("the sample traces contain what the trace view must handle", () => {
  const byId = new Map(snapshot.traces.map((t) => [t.summary.traceId, t]));

  it("has an orphan: a span whose parent is not in the trace", () => {
    const orphan = byId.get("tr_orph1")!;
    const ids = new Set(orphan.spans.map((s) => s.spanId));
    const missing = orphan.spans.filter((s) => s.parentId !== null && !ids.has(s.parentId));
    expect(missing.length).toBeGreaterThanOrEqual(2);
    expect(orphan.spans.some((s) => s.parentId === null)).toBe(false); // no root either
  });
  it("has a loop: six tool spans with the same arguments hash in one trace, ending in an error", () => {
    const loop = byId.get("tr_loop1")!;
    const tools = loop.spans.filter((s) => s.kind === "tool");
    expect(tools).toHaveLength(6);
    expect(new Set(tools.map((s) => s.argsHash)).size).toBe(1);
    expect(loop.summary.status).toBe("error");
  });
  it("has a trace with an unpriced call whose cost is unknown, not zero", () => {
    const t = snapshot.traces.find((x) => x.summary.unpricedSpans > 0)!;
    expect(t).toBeDefined();
    const span = t.spans.find((s) => s.model === UNPRICED_DEMO_MODEL)!;
    expect(span.costMicro).toBeNull();
  });
  it("has a failed (non-loop) trace and ordinary healthy ones", () => {
    expect(snapshot.traces.some((t) => t.summary.status === "error" && t.summary.traceId !== "tr_loop1")).toBe(true);
    expect(snapshot.traces.filter((t) => t.summary.status === "ok").length).toBeGreaterThan(20);
  });
  it("lists newest first and summaries agree with their spans", () => {
    const starts = snapshot.traces.map((t) => t.summary.startedAt);
    expect([...starts].sort().reverse()).toEqual(starts);
    for (const t of snapshot.traces) {
      expect(t.summary.spanCount).toBe(t.spans.length);
      const llm = t.spans.filter((s) => s.kind === "llm");
      expect(t.summary.inputTokens).toBe(llm.reduce((s, x) => s + (x.inputTokens ?? 0), 0));
    }
  });
  it("carries NO prompt or completion text and no unexpected keys", () => {
    const text = readFileSync(FILE, "utf8");
    for (const banned of ["prompt", "completion", "input_text", "output_text", "content", "@", "api_key", "Bearer"]) {
      expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
    }
    // strict schemas: an extra key would have failed the parse above; prove the schema really is strict
    const tampered = JSON.parse(readFileSync(FILE, "utf8"));
    tampered.traces[0].spans[0].input_text = "secret";
    expect(() => demoSnapshotSchema.parse(tampered)).toThrow();
  });
});
