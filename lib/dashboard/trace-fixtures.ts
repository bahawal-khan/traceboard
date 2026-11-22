import type { SpanInput } from "@/lib/dashboard/trace-tree";

/**
 * Deterministic span sets for the dev fixtures page and the tests: an ordinary trace, a failed one, an orphan trace, a
 * parent cycle, a deep chain, an unpriced one, a partial one and a 2,000-span one. Metadata only (names, times, counts).
 * No randomness and no clock, so the same call always returns the same spans.
 */

export const TRACE_FIXTURE_NAMES = ["ok", "failed", "orphan", "cycle", "deep", "unpriced", "partial", "instant", "large"] as const;
export type TraceFixtureName = (typeof TRACE_FIXTURE_NAMES)[number];

export interface TraceFixture {
  traceId: string;
  spans: SpanInput[];
  truncated: boolean;
}

const BASE_MS = Date.UTC(2026, 10, 21, 12, 29, 20);

interface Extra {
  kind?: string | null;
  model?: string | null;
  err?: boolean;
  unpriced?: boolean;
  tin?: number | null;
  tout?: number | null;
  tcached?: number | null;
  cost?: number | null;
}

function span(key: string, parent: string | null, name: string | null, offsetMs: number, latencyMs: number | null, x: Extra = {}): SpanInput {
  return {
    key,
    parentId: parent,
    name,
    kind: x.kind === undefined ? (x.model ? "llm" : "tool") : x.kind,
    model: x.model ?? null,
    isError: x.err ?? false,
    startUs: (BASE_MS + offsetMs) * 1000,
    latencyMs,
    inputTokens: x.tin ?? null,
    outputTokens: x.tout ?? null,
    cachedTokens: x.tcached ?? null,
    costMicro: x.cost ?? null,
    unpriced: x.unpriced ?? false,
  };
}

const llm = (model: string, tin: number, tout: number, cost: number | null, extra: Extra = {}): Extra => ({ model, tin, tout, cost, ...extra });

function ok(): SpanInput[] {
  return [
    span("s1", null, "agent.run", 0, 4820, { kind: "agent" }),
    span("s2", "s1", "plan", 20, 900, llm("gpt-4o", 1200, 180, 4200)),
    span("s3", "s1", "tool.search", 940, 1200),
    span("s4", "s3", "http.get", 960, 1100),
    span("s5", "s1", "summarize", 2200, 1500, llm("gpt-4o-mini", 5200, 400, 900, { tcached: 4000 })),
    span("s6", "s1", "answer", 3750, 1050, llm("gpt-4o", 3800, 520, 11800)),
    span("s7", "s1", "tool.save", 4810, 0),
  ];
}

function failed(): SpanInput[] {
  return [
    span("f1", null, "agent.run", 0, 31400, { kind: "agent", err: true }),
    span("f2", "f1", "plan", 10, 1800, llm("gpt-4o", 2200, 300, 7600)),
    span("f3", "f1", "tool.fetch_invoice", 1900, 9000, { err: true }),
    span("f4", "f3", "http.get", 1950, null, { err: true }), // never finished: latency unknown
    span("f5", "f1", "retry.plan", 11000, 2400, llm("gpt-4o", 2400, 350, 8200)),
    span("f6", "f1", "tool.fetch_invoice", 13500, 7000),
    span("f7", "f1", "answer", 21000, 10400, llm("gpt-4o", 9000, 900, 24000)),
  ];
}

function orphan(): SpanInput[] {
  return [
    span("o1", "gone-root", "tool.search", 0, 700),
    span("o2", "o1", "http.get", 20, 600),
    span("o3", "never-sent", "answer", 800, 1500, llm("gpt-4o-mini", 800, 200, 500)),
  ];
}

function cycle(): SpanInput[] {
  return [
    span("c1", "c3", "alpha", 0, 500),
    span("c2", "c1", "beta", 100, 300),
    span("c3", "c2", "gamma", 200, 200),
    span("c4", "c2", "below the loop", 250, 100),
    span("c5", "c5", "points at itself", 600, 150),
  ];
}

function deep(): SpanInput[] {
  const spans: SpanInput[] = [];
  for (let i = 0; i < 80; i++) spans.push(span(`d${i}`, i === 0 ? null : `d${i - 1}`, i === 0 ? "agent.run" : `step ${i}`, i * 40, 3200 - i * 35 > 0 ? 3200 - i * 35 : 5));
  spans.push(span("d-long", "d0", "A very long span name that has to be cut off instead of pushing the columns out of the screen", 3300, 400, { kind: "tool" }));
  return spans;
}

function unpriced(): SpanInput[] {
  return [
    span("u1", null, "support.answer", 0, 2600, { kind: "agent" }),
    span("u2", "u1", "classify", 20, 700, llm("acme-local-7b", 600, 20, null, { unpriced: true })),
    span("u3", "u1", "draft", 760, 1400, llm("gpt-4o", 2100, 480, 9100)),
    span("u4", "u1", "tool.lookup", 760, 300),
    span("u5", "u1", "polish", 2180, 400, llm("acme-local-7b", 300, 300, null, { unpriced: true })),
  ];
}

function partial(): SpanInput[] {
  const spans = ok();
  // A second span with an id already used (a client resent it): only the earliest is kept.
  spans.push(span("s3", "s1", "tool.search (resent)", 950, 1190));
  spans.push(span("s8", "s1", "late.step", 4900, 600, llm("gpt-4o", 400, 50, 1500)));
  return spans;
}

/** Every span starts and ends in the same millisecond: the total duration is 0 ms. */
function instant(): SpanInput[] {
  return [
    span("i1", null, "cache.lookup", 0, 0, { kind: "tool" }),
    span("i2", "i1", "key.hash", 0, 0),
    span("i3", "i1", "result.decode", 0, 0),
  ];
}

/** Exactly 2,000 spans: a root, 40 steps, and 49 children per step (every 7th child has a child of its own). */
function large(): SpanInput[] {
  const spans: SpanInput[] = [span("L0", null, "agent.run", 0, 120_000, { kind: "agent" })];
  let n = 1;
  for (let step = 0; step < 40 && n < 2000; step++) {
    const stepKey = `L${n}`;
    spans.push(span(stepKey, "L0", `step ${step + 1}`, step * 2900, 2800, { kind: "agent" }));
    n += 1;
    for (let c = 0; c < 49 && n < 2000; c++) {
      const key = `L${n}`;
      const start = step * 2900 + c * 55;
      const isLlm = c % 5 === 0;
      const bad = (step * 49 + c) % 97 === 0;
      const noPrice = isLlm && (step + c) % 11 === 0;
      spans.push(
        span(
          key,
          stepKey,
          isLlm ? "llm.call" : `tool.${["search", "read", "write", "calc"][c % 4]}`,
          start,
          c % 31 === 30 ? null : 40 + ((step * 7 + c * 13) % 400),
          isLlm ? llm("gpt-4o-mini", 800 + c, 120, noPrice ? null : 300 + c, { err: bad, unpriced: noPrice }) : { err: bad },
        ),
      );
      n += 1;
      if (c % 7 === 6 && n < 2000) {
        spans.push(span(`L${n}`, key, "http.get", start + 5, 25));
        n += 1;
      }
    }
  }
  return spans;
}

const ID: Record<TraceFixtureName, string> = {
  ok: "9f2c41d8e0a74b6c8d3e5f7a1b2c3d4e",
  failed: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  orphan: "e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3",
  cycle: "cyc1e0a1b2c3d4e5f60718293a4b5c6d",
  deep: "dee9a1b2c3d4e5f60718293a4b5c6d7e",
  unpriced: "b7c8d9e0f1a2b3c4d5e6f708192a3b4c",
  partial: "9a7b1a1b2c3d4e5f60718293a4b5c6d7",
  instant: "1257a17c3d4e5f60718293a4b5c6d7e8",
  large: "1a2b3c4d5e6f708192a3b4c5d6e7f809",
};

export function traceFixture(name: TraceFixtureName): TraceFixture {
  const build: Record<TraceFixtureName, () => SpanInput[]> = { ok, failed, orphan, cycle, deep, unpriced, partial, instant, large };
  return { traceId: ID[name], spans: build[name](), truncated: name === "partial" || name === "large" };
}
