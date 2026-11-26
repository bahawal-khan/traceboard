import { costMicro, type ModelPrice } from "@/lib/ingest/cost";
import { LATENCY_BOUNDS_MS, LATENCY_BUCKETS } from "@/lib/ingest/rollup";
import type { DemoSnapshot, DemoThread, RollupRow, SpanRow, TraceDetail } from "@/lib/dashboard/types";

/**
 * Deterministic synthetic traffic for the public demo project. Pure: the same seed gives byte-identical output, so the
 * committed snapshot is reproducible (tests/demo-snapshot.test.ts regenerates and compares it).
 *
 * Everything is FAKE: ids are counters, tool arguments are random hashes, there is no prompt or completion text and no
 * personal data. Volume respects the free-tier quota (QUOTAS.eventsPerDayPerProject, checked by a test).
 *
 * The rollups are produced with the same rules as the ingest statement: every event counts as a call; events without a
 * model roll up under ''; the cost of an unpriced model adds NOTHING; events without latency are in no latency bucket.
 */

export const DEMO_SEED = 20261121;
/** Fixed "now" of the demo: the snapshot is a photograph, not a live feed. */
export const DEMO_ANCHOR_MS = Date.UTC(2026, 10, 21, 12, 0, 0);
export const DEMO_WINDOW_DAYS = 7;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Prices copied from db/seed/model-prices.json on 2026-11-21 (USD per 1M tokens). A fixed copy on purpose: re-seeding
 * the real price table must not silently change the committed demo. `acme-local-7b` has no price: it is the demo's
 * "unknown cost" model.
 */
export const DEMO_PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5-5": { model: "claude-sonnet-5-5", inputPer1m: "2.00", cachedInputPer1m: "0.10", outputPer1m: "10.00" },
  "claude-haiku-5-5": { model: "claude-haiku-5-5", inputPer1m: "0.10", cachedInputPer1m: "0.01", outputPer1m: "0.50" },
  "gpt-6.2-astra": { model: "gpt-6.2-astra", inputPer1m: "8.00", cachedInputPer1m: "0.40", outputPer1m: "40.00" },
};
export const UNPRICED_DEMO_MODEL = "acme-local-7b";

const MODELS: ReadonlyArray<{ id: string; weight: number; speed: number }> = [
  { id: "claude-sonnet-5-5", weight: 0.45, speed: 1 },
  { id: "claude-haiku-5-5", weight: 0.33, speed: 0.6 },
  { id: "gpt-6.2-astra", weight: 0.16, speed: 1.3 },
  { id: UNPRICED_DEMO_MODEL, weight: 0.06, speed: 1.8 },
];

const AGENTS = ["support-agent", "triage-agent", "sql-assistant"] as const;
const TOOLS = ["search_docs", "lookup_order", "create_ticket", "run_sql"] as const;

export interface DemoEvent {
  traceId: string;
  spanId: string;
  parentId: string | null;
  kind: "agent" | "llm" | "retrieval" | "tool";
  name: string;
  model: string | null;
  startMs: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costMicro: number | null;
  status: "ok" | "error";
  error: string | null;
  argsHash: string | null;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  readonly rng = mulberry32(DEMO_SEED);
  private traceN = 0;
  private spanN = 0;
  readonly events: DemoEvent[] = [];

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.rng() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rng() * xs.length)]!;
  }
  hash(): string {
    let s = "";
    for (let i = 0; i < 16; i++) s += this.int(0, 15).toString(16);
    return s;
  }
  traceId(): string {
    return `tr_${String(++this.traceN).padStart(5, "0")}`;
  }
  spanId(): string {
    return `sp_${String(++this.spanN).padStart(6, "0")}`;
  }
  model(): { id: string; speed: number } {
    let x = this.rng();
    for (const m of MODELS) {
      if (x < m.weight) return m;
      x -= m.weight;
    }
    return MODELS[0]!;
  }

  llmEvent(traceId: string, parentId: string | null, model: { id: string; speed: number }, startMs: number, fail = false): DemoEvent {
    const inputTokens = this.int(500, 3500);
    const cachedTokens = this.rng() < 0.6 ? Math.floor(inputTokens * (0.3 + this.rng() * 0.6)) : 0;
    const outputTokens = this.int(60, 700);
    const tail = this.rng() < 0.03 ? 5 : 1;
    const latencyMs = Math.max(1, Math.round((250 + outputTokens * 7) * model.speed * Math.exp((this.rng() - 0.5) * 0.8) * tail));
    const price = DEMO_PRICES[model.id];
    return {
      traceId,
      spanId: this.spanId(),
      parentId,
      kind: "llm",
      name: "chat",
      model: model.id,
      startMs,
      latencyMs,
      inputTokens,
      outputTokens,
      cachedTokens,
      costMicro: price ? costMicro(price, inputTokens, outputTokens, cachedTokens) : null,
      status: fail ? "error" : "ok",
      error: fail ? "provider_error" : null,
      argsHash: null,
    };
  }

  /** agent -> retrieval -> llm -> tool -> llm, the common shape. Returns the events of one trace. */
  normalTrace(startMs: number, failTool: boolean): DemoEvent[] {
    const traceId = this.traceId();
    const root = this.spanId();
    const model = this.model();
    const out: DemoEvent[] = [];
    let t = startMs + this.int(5, 30);

    const retrieval: DemoEvent = {
      traceId, spanId: this.spanId(), parentId: root, kind: "retrieval", name: "vector_search", model: null,
      startMs: t, latencyMs: this.int(40, 220), inputTokens: null, outputTokens: null, cachedTokens: null, costMicro: null,
      status: "ok", error: null, argsHash: null,
    };
    out.push(retrieval);
    t += retrieval.latencyMs + this.int(2, 20);

    const llm1 = this.llmEvent(traceId, root, model, t);
    out.push(llm1);
    t += llm1.latencyMs + this.int(2, 20);

    const tool: DemoEvent = {
      traceId, spanId: this.spanId(), parentId: root, kind: "tool", name: this.pick(TOOLS), model: null,
      startMs: t, latencyMs: failTool ? this.int(5000, 8000) : this.int(60, 900), inputTokens: null, outputTokens: null,
      cachedTokens: null, costMicro: null, status: failTool ? "error" : "ok", error: failTool ? "tool_timeout" : null, argsHash: this.hash(),
    };
    out.push(tool);
    t += tool.latencyMs + this.int(2, 20);

    if (!failTool) {
      const llm2 = this.llmEvent(traceId, root, model, t);
      out.push(llm2);
      t += llm2.latencyMs;
    }

    out.unshift({
      traceId, spanId: root, parentId: null, kind: "agent", name: this.pick(AGENTS), model: null,
      startMs, latencyMs: t - startMs + this.int(10, 60), inputTokens: null, outputTokens: null, cachedTokens: null,
      costMicro: null, status: failTool ? "error" : "ok", error: failTool ? "tool_timeout" : null, argsHash: null,
    });
    return out;
  }

  /** The same tool with the same arguments, again and again: the pattern Guard will stop (Phase 4). */
  loopTrace(startMs: number): DemoEvent[] {
    const traceId = "tr_loop1";
    const root = this.spanId();
    const model = MODELS[1]!; // haiku
    const sameArgs = this.hash();
    const out: DemoEvent[] = [];
    let t = startMs + 10;
    for (let i = 0; i < 6; i++) {
      const llm = this.llmEvent(traceId, root, model, t);
      out.push(llm);
      t += llm.latencyMs + 5;
      const tool: DemoEvent = {
        traceId, spanId: this.spanId(), parentId: root, kind: "tool", name: "search_docs", model: null, startMs: t,
        latencyMs: this.int(80, 160), inputTokens: null, outputTokens: null, cachedTokens: null, costMicro: null,
        status: "ok", error: null, argsHash: sameArgs,
      };
      out.push(tool);
      t += tool.latencyMs + 5;
    }
    out.unshift({
      traceId, spanId: root, parentId: null, kind: "agent", name: "support-agent", model: null, startMs,
      latencyMs: t - startMs, inputTokens: null, outputTokens: null, cachedTokens: null, costMicro: null,
      status: "error", error: "stopped after 6 identical tool calls", argsHash: null,
    });
    return out;
  }

  /** The parent span never arrived (OTLP GenAI-only filter, per-instance memory): children point at a missing span. */
  orphanTrace(startMs: number): DemoEvent[] {
    const traceId = "tr_orph1";
    const missingParent = "sp_missing_parent";
    const model = MODELS[0]!;
    const llm = this.llmEvent(traceId, missingParent, model, startMs + 20);
    const tool: DemoEvent = {
      traceId, spanId: this.spanId(), parentId: missingParent, kind: "tool", name: "lookup_order", model: null,
      startMs: startMs + 20 + llm.latencyMs + 8, latencyMs: this.int(60, 300), inputTokens: null, outputTokens: null,
      cachedTokens: null, costMicro: null, status: "ok", error: null, argsHash: this.hash(),
    };
    return [llm, tool];
  }
}

/** Relative traffic by UTC hour (a working-day curve) and by weekday. */
function trafficFactor(ms: number): number {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const day = d.getUTCDay();
  const curve = h >= 5 && h <= 21 ? 0.3 + 0.7 * Math.sin((Math.PI * (h - 5)) / 16) : 0.25;
  return curve * (day === 0 || day === 6 ? 0.55 : 1);
}

export function generateDemoEvents(): DemoEvent[] {
  const g = new Gen();
  const start = DEMO_ANCHOR_MS - DEMO_WINDOW_DAYS * DAY;
  const hours = DEMO_WINDOW_DAYS * 24;
  for (let i = 0; i < hours; i++) {
    const hourStart = start + i * HOUR;
    const lambda = 20 * trafficFactor(hourStart);
    const n = Math.max(0, Math.round(lambda + (g.rng() - 0.5) * lambda * 0.6));
    for (let k = 0; k < n; k++) {
      const t0 = hourStart + Math.floor(g.rng() * (HOUR - 20_000));
      g.events.push(...g.normalTrace(t0, g.rng() < 0.03));
    }
  }
  // Hand-placed traces the dashboard must handle (one each).
  g.events.push(...g.loopTrace(DEMO_ANCHOR_MS - 5 * HOUR + 11 * 60_000));
  g.events.push(...g.orphanTrace(DEMO_ANCHOR_MS - 2 * HOUR + 7 * 60_000));

  return g.events.filter((e) => e.startMs >= start && e.startMs < DEMO_ANCHOR_MS).sort((a, b) => a.startMs - b.startMs || (a.spanId < b.spanId ? -1 : 1));
}

/** Same rules as the ingest statement's hourly rollup (see the file comment). */
export function rollupEvents(events: readonly DemoEvent[]): RollupRow[] {
  const rows = new Map<string, RollupRow>();
  for (const e of events) {
    const bucket = Math.floor(e.startMs / HOUR) * HOUR;
    const model = e.model ?? "";
    const key = `${bucket}|${model}`;
    let r = rows.get(key);
    if (!r) {
      r = { bucket, model, calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, costMicro: 0, latSumMs: 0, lat: new Array<number>(LATENCY_BUCKETS).fill(0) };
      rows.set(key, r);
    }
    r.calls += 1;
    if (e.status === "error") r.errors += 1;
    r.inputTokens += e.inputTokens ?? 0;
    r.outputTokens += e.outputTokens ?? 0;
    r.costMicro += e.costMicro ?? 0; // unknown cost adds nothing
    r.latSumMs += e.latencyMs;
    r.lat[LATENCY_BOUNDS_MS.filter((b) => b <= e.latencyMs).length]! += 1; // width_bucket
  }
  return [...rows.values()].sort((a, b) => a.bucket - b.bucket || (a.model < b.model ? -1 : 1));
}

function toDetail(events: DemoEvent[]): TraceDetail {
  const start = Math.min(...events.map((e) => e.startMs));
  const end = Math.max(...events.map((e) => e.startMs + e.latencyMs));
  const spans: SpanRow[] = events
    .slice()
    .sort((a, b) => a.startMs - b.startMs || (a.spanId < b.spanId ? -1 : 1))
    .map((e) => ({
      spanId: e.spanId, parentId: e.parentId, kind: e.kind, name: e.name, model: e.model, offsetMs: e.startMs - start,
      latencyMs: e.latencyMs, inputTokens: e.inputTokens, outputTokens: e.outputTokens, cachedTokens: e.cachedTokens,
      costMicro: e.costMicro, status: e.status, error: e.error, argsHash: e.argsHash,
    }));
  const llm = events.filter((e) => e.kind === "llm");
  const known = llm.filter((e) => e.costMicro !== null);
  const root = events.find((e) => e.parentId === null) ?? events[0]!;
  return {
    summary: {
      traceId: events[0]!.traceId,
      name: root.name,
      startedAt: new Date(start).toISOString(),
      durationMs: end - start,
      spanCount: events.length,
      status: events.some((e) => e.status === "error") ? "error" : "ok",
      inputTokens: llm.reduce((s, e) => s + (e.inputTokens ?? 0), 0),
      outputTokens: llm.reduce((s, e) => s + (e.outputTokens ?? 0), 0),
      costMicro: known.length ? known.reduce((s, e) => s + (e.costMicro ?? 0), 0) : null,
      unpricedSpans: llm.length - known.length,
    },
    spans,
  };
}

const SAMPLE_TRACES = 36;

/** Turns per thread, cycled: a one-turn thread, a long one and in-between ones. */
const THREAD_SIZES = [3, 1, 4, 2] as const;

/**
 * Groups the sample traces into threads. Uses NO random numbers (so no existing value of the sample can change): the traces,
 * oldest first, are cut into consecutive runs of THREAD_SIZES; every fifth trace has no thread at all, and the orphan trace
 * (its parent never arrived) never has one. Ids are counters ("th_demo_01"), never real session ids.
 */
export function assignDemoThreads(traces: readonly TraceDetail[]): DemoThread[] {
  const oldestFirst = [...traces].filter((t) => t.summary.traceId !== "tr_orph1").sort((a, b) => (a.summary.startedAt < b.summary.startedAt ? -1 : 1));
  const threads: DemoThread[] = [];
  let open: string[] = [];
  let sizeIdx = 0;
  const close = () => {
    if (open.length > 0) threads.push({ threadId: `th_demo_${String(threads.length + 1).padStart(2, "0")}`, traceIds: open });
    open = [];
  };
  oldestFirst.forEach((t, i) => {
    if (i % 5 === 4) return; // a trace with no thread
    open.push(t.summary.traceId);
    if (open.length >= THREAD_SIZES[sizeIdx % THREAD_SIZES.length]!) {
      close();
      sizeIdx += 1;
    }
  });
  close();
  return threads;
}

export function generateDemoSnapshot(): DemoSnapshot {
  const events = generateDemoEvents();
  const byTrace = new Map<string, DemoEvent[]>();
  for (const e of events) (byTrace.get(e.traceId) ?? byTrace.set(e.traceId, []).get(e.traceId)!).push(e);

  const ordered = [...byTrace.values()].sort((a, b) => b[0]!.startMs - a[0]!.startMs); // newest first
  const chosen = new Map<string, DemoEvent[]>();
  for (const id of ["tr_loop1", "tr_orph1"]) if (byTrace.has(id)) chosen.set(id, byTrace.get(id)!);
  // One failed trace and one with an unpriced model, so the sample always shows both.
  const failed = ordered.find((t) => t[0]!.status === "error" && t[0]!.traceId !== "tr_loop1");
  const unpriced = ordered.find((t) => t.some((e) => e.model === UNPRICED_DEMO_MODEL));
  for (const t of [failed, unpriced]) if (t) chosen.set(t[0]!.traceId, t);
  for (const t of ordered) {
    if (chosen.size >= SAMPLE_TRACES) break;
    chosen.set(t[0]!.traceId, t);
  }

  const traces = [...chosen.values()].map(toDetail).sort((a, b) => (a.summary.startedAt < b.summary.startedAt ? 1 : -1));
  const todayStart = Math.floor(DEMO_ANCHOR_MS / DAY) * DAY;
  return {
    version: 1,
    generatedAt: new Date(DEMO_ANCHOR_MS).toISOString(),
    pricedModels: Object.keys(DEMO_PRICES).sort(),
    usage: { eventsToday: events.filter((e) => e.startMs >= todayStart).length },
    rollups: rollupEvents(events),
    traces,
    threads: assignDemoThreads(traces),
  };
}

/**
 * Stable text form: one rollup row and one trace per line, so a regenerated snapshot produces a reviewable diff.
 * `JSON.parse` of the result equals the snapshot.
 */
export function serializeDemoSnapshot(s: DemoSnapshot): string {
  const lines = (xs: readonly unknown[]) => xs.map((x) => `    ${JSON.stringify(x)}`).join(",\n");
  return [
    "{",
    `  "version": ${s.version},`,
    `  "generatedAt": ${JSON.stringify(s.generatedAt)},`,
    `  "pricedModels": ${JSON.stringify(s.pricedModels)},`,
    `  "usage": ${JSON.stringify(s.usage)},`,
    `  "rollups": [\n${lines(s.rollups)}\n  ],`,
    `  "traces": [\n${lines(s.traces)}\n  ],`,
    `  "threads": [\n${lines(s.threads)}\n  ]`,
    "}",
    "",
  ].join("\n");
}
