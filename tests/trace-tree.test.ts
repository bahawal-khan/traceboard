import { describe, expect, it } from "vitest";
import { MAX_TREE_DEPTH, buildTraceTree, type SpanInput } from "@/lib/dashboard/trace-tree";

const span = (key: string, parentId: string | null, startUs: number, latencyMs: number | null = 10, over: Partial<SpanInput> = {}): SpanInput => ({
  key, parentId, name: key, kind: "llm", model: null, isError: false, startUs, latencyMs, inputTokens: null, outputTokens: null, cachedTokens: null,
  costMicro: null, unpriced: false, ...over,
});
const keys = (t: ReturnType<typeof buildTraceTree>) => t.rows.map((r) => r.span.key);
const depths = (t: ReturnType<typeof buildTraceTree>) => t.rows.map((r) => r.depth);

describe("buildTraceTree: the normal case", () => {
  it("lists parents before their children, children by start time, with depths", () => {
    const t = buildTraceTree([
      span("c2", "root", 3_000), span("root", null, 0, 5_000), span("c1", "root", 1_000), span("g1", "c1", 1_500), span("g2", "c2", 3_500),
    ]);
    expect(keys(t)).toEqual(["root", "c1", "g1", "c2", "g2"]);
    expect(depths(t)).toEqual([0, 1, 2, 1, 2]);
    expect(t.rows.map((r) => r.childCount)).toEqual([2, 1, 0, 1, 0]);
    expect(t).toMatchObject({ duplicates: 0, rootCount: 1, orphanCount: 0, cycleCount: 0, depthCappedCount: 0 });
  });
  it("equal starts are ordered by key", () => {
    expect(keys(buildTraceTree([span("r", null, 0), span("b", "r", 5), span("a", "r", 5), span("c", "r", 5)]))).toEqual(["r", "a", "b", "c"]);
  });
  it("timing scale: first start, total length to the latest END, offsets and durations in ms", () => {
    const t = buildTraceTree([span("r", null, 1_000_000, 100), span("c", "r", 1_050_000, 500)]); // starts in microseconds
    expect(t.scale).toEqual({ startUs: 1_000_000, totalMs: 550 });
    expect(t.rows.map((r) => [r.startOffsetMs, r.durationMs, r.durationKnown])).toEqual([[0, 100, true], [50, 500, true]]);
  });
  it("microsecond starts keep their order", () => {
    expect(keys(buildTraceTree([span("b", null, 1_000_002), span("a", null, 1_000_001), span("c", null, 1_000_003)]))).toEqual(["a", "b", "c"]);
  });
  it("empty input and a single span", () => {
    expect(buildTraceTree([])).toEqual({ rows: [], duplicates: 0, rootCount: 0, orphanCount: 0, cycleCount: 0, depthCappedCount: 0, scale: { startUs: 0, totalMs: 0 } });
    expect(buildTraceTree([span("only", null, 7, 3)]).scale).toEqual({ startUs: 7, totalMs: 3 });
  });
  it("does not modify its input", () => {
    const input = Object.freeze([Object.freeze(span("b", "a", 2)), Object.freeze(span("a", null, 1))]);
    expect(() => buildTraceTree(input)).not.toThrow();
    expect(input.map((s) => s.key)).toEqual(["b", "a"]);
  });
  it("odd keys are plain data (no prototype tricks)", () => {
    const t = buildTraceTree([span("__proto__", null, 1), span("constructor", "__proto__", 2), span("", "constructor", 3), span("toString", "ghost", 4)]);
    expect(keys(t)).toEqual(["__proto__", "constructor", "", "toString"]);
    expect(t.rows[3]!.orphan).toBe(true);
  });
});

describe("buildTraceTree: orphans", () => {
  it("a span whose parent is missing becomes an extra root, marked orphan, ordered among the roots by start", () => {
    const t = buildTraceTree([span("root", null, 0), span("lost-child", "gone", 5), span("child", "root", 10), span("lost-grandchild", "lost-child", 6)]);
    expect(keys(t)).toEqual(["root", "child", "lost-child", "lost-grandchild"]);
    expect(t.rows.map((r) => r.orphan)).toEqual([false, false, true, false]);
    expect(t).toMatchObject({ rootCount: 2, orphanCount: 1 });
  });
  it("a trace with no true root is all orphans, still complete", () => {
    const t = buildTraceTree([span("a", "x1", 1), span("b", "x2", 2), span("c", "a", 3)]);
    expect(keys(t)).toEqual(["a", "c", "b"]);
    expect(t.orphanCount).toBe(2);
  });
});

describe("buildTraceTree: duplicates", () => {
  it("keeps the first (by the total order), counts the rest, and children attach to the kept one", () => {
    const t = buildTraceTree([span("r", null, 0), span("d", "r", 5, 1), span("d", "r", 9, 2), span("d", "r", 7, 3), span("k", "d", 20)]);
    expect(keys(t)).toEqual(["r", "d", "k"]);
    expect(t.duplicates).toBe(2);
    expect(t.rows[1]!.span.latencyMs).toBe(1);
    expect(t.rows[2]!.depth).toBe(2);
  });
  it("the same start and key but different content still picks the same one whatever the input order", () => {
    const a = span("d", null, 5, 1, { name: "alpha" });
    const b = span("d", null, 5, 2, { name: "beta" });
    expect(buildTraceTree([a, b]).rows[0]!.span).toEqual(buildTraceTree([b, a]).rows[0]!.span);
  });
});

describe("buildTraceTree: cycles", () => {
  it("a span that is its own parent becomes a root, marked", () => {
    const t = buildTraceTree([span("a", "a", 1), span("b", "a", 2)]);
    expect(keys(t)).toEqual(["a", "b"]);
    expect(t.rows[0]).toMatchObject({ depth: 0, cycleBroken: true });
    expect(t.cycleCount).toBe(1);
  });
  it("a 2-cycle and a 3-cycle are broken at the member that sorts first", () => {
    const two = buildTraceTree([span("b", "a", 2), span("a", "b", 1)]);
    expect(keys(two)).toEqual(["a", "b"]);
    expect(two.rows.map((r) => r.cycleBroken)).toEqual([true, false]);
    const three = buildTraceTree([span("z", "y", 3), span("y", "x", 2), span("x", "z", 1)]);
    expect(keys(three)).toEqual(["x", "y", "z"]);
    expect(depths(three)).toEqual([0, 1, 2]);
    expect(three.rows[0]).toMatchObject({ cycleBroken: true, depth: 0 });
    expect(three.cycleCount).toBe(1);
  });
  it("spans hanging off a cycle stay below it; a separate cycle is counted separately", () => {
    const t = buildTraceTree([span("a", "b", 1), span("b", "a", 2), span("tail", "b", 3), span("p", "q", 10), span("q", "p", 11)]);
    expect(keys(t)).toEqual(["a", "b", "tail", "p", "q"]);
    expect(depths(t)).toEqual([0, 1, 2, 0, 1]);
    expect(t.cycleCount).toBe(2);
  });
});

describe("buildTraceTree: depth cap and size", () => {
  it("a chain of 5,000 spans does not overflow the stack; everything is listed, deep spans are capped and marked", () => {
    const chain = Array.from({ length: 5_000 }, (_, i) => span(`s${String(i).padStart(5, "0")}`, i === 0 ? null : `s${String(i - 1).padStart(5, "0")}`, i));
    const t = buildTraceTree(chain);
    expect(t.rows).toHaveLength(5_000);
    expect(t.rows[MAX_TREE_DEPTH]!).toMatchObject({ depth: MAX_TREE_DEPTH, depthCapped: false });
    expect(t.rows[MAX_TREE_DEPTH + 1]!).toMatchObject({ depth: MAX_TREE_DEPTH, depthCapped: true });
    expect(Math.max(...t.rows.map((r) => r.depth))).toBe(MAX_TREE_DEPTH);
    expect(t.depthCappedCount).toBe(5_000 - MAX_TREE_DEPTH - 1);
  });
  it("10,000 children of one root are fine", () => {
    const wide = [span("root", null, 0), ...Array.from({ length: 10_000 }, (_, i) => span(`c${String(i).padStart(5, "0")}`, "root", i + 1))];
    const t = buildTraceTree(wide);
    expect(t.rows).toHaveLength(10_001);
    expect(t.rows[0]!.childCount).toBe(10_000);
  });
});

describe("buildTraceTree: missing and odd numbers", () => {
  it("missing, negative and non-finite latency count as 0 and are marked unknown; they never move the scale", () => {
    const t = buildTraceTree([
      span("a", null, 0, null), span("b", "a", 100, -5), span("c", "a", 200, Number.NaN), span("d", "a", 300, Number.POSITIVE_INFINITY), span("e", "a", 400, 50),
    ]);
    expect(t.rows.map((r) => [r.durationMs, r.durationKnown])).toEqual([[0, false], [0, false], [0, false], [0, false], [50, true]]);
    expect(t.scale.totalMs).toBeCloseTo(50.4, 6); // the last span starts 0.4 ms in (starts are microseconds) and runs 50 ms
  });
  it("a start that is not a number takes the earliest valid start and is marked", () => {
    const t = buildTraceTree([span("a", null, 1_000), span("b", "a", Number.NaN), span("c", "a", 2_000)]);
    expect(t.rows.find((r) => r.span.key === "b")).toMatchObject({ startInvalid: true, startOffsetMs: 0 });
    expect(t.scale.startUs).toBe(1_000);
    expect(buildTraceTree([span("x", null, Number.NaN)]).scale.startUs).toBe(0);
  });
  it("offsets are never negative and total is never negative", () => {
    const t = buildTraceTree([span("a", null, -50), span("b", "a", -100, -1)]);
    expect(t.rows.every((r) => r.startOffsetMs >= 0)).toBe(true);
    expect(t.scale.totalMs).toBeGreaterThanOrEqual(0);
  });
});

// ---- property / fuzz tests: a seeded generator (no dependency), so a failure reproduces from its seed ----

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEY_POOL = ["a", "b", "c", "d", "e", "f", "__proto__", "constructor", "", "ключ", "k\u{1F600}", "x y", "0", "1"];
function randomSpans(rand: () => number): SpanInput[] {
  const n = Math.floor(rand() * 60);
  const pool = KEY_POOL.concat(Array.from({ length: Math.floor(rand() * 40) }, (_, i) => `s${i}`)).slice(0, Math.max(1, Math.floor(n * 0.8)));
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  return Array.from({ length: n }, () => {
    const r = rand();
    const parentId = r < 0.25 ? null : r < 0.8 ? pick(pool) : `ghost-${Math.floor(rand() * 5)}`;
    const startRoll = rand();
    const startUs = startRoll < 0.03 ? Number.NaN : startRoll < 0.05 ? Number.POSITIVE_INFINITY : startRoll < 0.08 ? -Math.floor(rand() * 1000) : Math.floor(rand() * 6) * 1000 + (rand() < 0.5 ? 0 : 1);
    const latRoll = rand();
    const latencyMs = latRoll < 0.15 ? null : latRoll < 0.25 ? -Math.floor(rand() * 100) : latRoll < 0.3 ? Number.NaN : Math.floor(rand() * 5000);
    return {
      key: pick(pool), parentId, name: rand() < 0.5 ? null : pick(["x", "y", "z"]), kind: rand() < 0.5 ? "llm" : null, model: rand() < 0.3 ? "m" : null,
      isError: rand() < 0.2, startUs, latencyMs, inputTokens: rand() < 0.5 ? null : Math.floor(rand() * 100), outputTokens: null, cachedTokens: null,
      costMicro: rand() < 0.5 ? null : Math.floor(rand() * 100), unpriced: rand() < 0.1,
    };
  });
}
function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe("buildTraceTree: properties on random input", () => {
  const CASES = 600;
  it(`${CASES} random traces (duplicates, cycles, self parents, ghosts, NaN, negatives, ties): never throws, every span appears exactly once, the output is valid`, () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const rand = mulberry32(seed);
      const input = randomSpans(rand);
      const t = buildTraceTree(input);
      const ctx = `seed ${seed}`;

      // nothing lost, nothing invented
      expect(t.rows.length + t.duplicates, ctx).toBe(input.length);
      const outKeys = t.rows.map((r) => r.span.key);
      expect(new Set(outKeys).size, ctx).toBe(outKeys.length);
      expect(new Set(outKeys), ctx).toEqual(new Set(input.map((s) => s.key)));

      // a valid pre-order forest: the first row is a root, a row is at most one level below the previous one
      const depthOk = t.rows.every((r, i) => (i === 0 ? r.depth === 0 : r.depth <= t.rows[i - 1]!.depth + 1));
      expect(depthOk, ctx).toBe(true);

      // every non-root row's parent is a real span of the trace and was listed BEFORE it (so there is no cycle left)
      const position = new Map(outKeys.map((k, i) => [k, i]));
      let roots = 0;
      let orphans = 0;
      let cycles = 0;
      t.rows.forEach((r, i) => {
        const pid = r.span.parentId;
        const isRoot = pid === null || r.orphan || r.cycleBroken;
        if (isRoot) {
          roots += 1;
          expect(r.depth, ctx).toBe(0);
        } else {
          expect(position.has(pid!), ctx).toBe(true);
          expect(position.get(pid!)!, ctx).toBeLessThan(i);
        }
        if (r.orphan) {
          orphans += 1;
          expect(position.has(pid!), ctx).toBe(false);
        }
        if (r.cycleBroken) cycles += 1;
        expect(r.startOffsetMs, ctx).toBeGreaterThanOrEqual(0);
        expect(r.durationMs, ctx).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(r.startOffsetMs + r.durationMs), ctx).toBe(true);
        expect(r.startOffsetMs + r.durationMs, ctx).toBeLessThanOrEqual(t.scale.totalMs + 1e-6);
      });
      expect(t.rootCount, ctx).toBe(roots);
      expect(t.orphanCount, ctx).toBe(orphans);
      expect(t.cycleCount, ctx).toBe(cycles);
      expect(Number.isFinite(t.scale.totalMs) && t.scale.totalMs >= 0, ctx).toBe(true);
      expect(Number.isFinite(t.scale.startUs), ctx).toBe(true);
      // child counts add up
      expect(t.rows.reduce((a, r) => a + r.childCount, 0), ctx).toBe(t.rows.length - roots);
    }
  });

  it("the output does not depend on the order of the input (4 shuffles each of 400 random traces)", () => {
    for (let seed = 1000; seed < 1400; seed++) {
      const rand = mulberry32(seed);
      const input = randomSpans(rand);
      const base = buildTraceTree(input);
      for (let k = 0; k < 4; k++) {
        const other = buildTraceTree(shuffled(input, mulberry32(seed * 31 + k)));
        expect(other, `seed ${seed} shuffle ${k}`).toEqual(base);
      }
      expect(buildTraceTree([...input].reverse()), `seed ${seed} reversed`).toEqual(base);
    }
  });

  it("a single big cycle and a deep random forest still terminate and keep every span", () => {
    const ring = Array.from({ length: 3_000 }, (_, i) => span(`r${String(i).padStart(4, "0")}`, `r${String((i + 1) % 3_000).padStart(4, "0")}`, i));
    const t = buildTraceTree(ring);
    expect(t.rows).toHaveLength(3_000);
    expect(t.cycleCount).toBe(1);
    expect(t.rows[0]!.cycleBroken).toBe(true);
    const rand = mulberry32(42);
    const forest = Array.from({ length: 4_000 }, (_, i) => span(`n${i}`, i === 0 || rand() < 0.05 ? null : `n${Math.floor(rand() * i)}`, Math.floor(rand() * 1000)));
    expect(buildTraceTree(forest).rows).toHaveLength(4_000);
  });
});
