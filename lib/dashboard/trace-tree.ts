/**
 * Pure, iterative tree builder for the trace detail page (tree and waterfall). No recursion anywhere, so a chain of
 * thousands of spans cannot overflow the stack; no I/O; no input mutation.
 *
 * Rules (all deterministic: the output depends on WHAT the spans are, never on the order they arrive in):
 *  - Total order: spans are sorted by (start, key, then every other field as a canonical string). Children keep that order.
 *  - Duplicate span keys: the first in that order is kept, the rest are only counted (`duplicates`).
 *  - A span without a parent is a root. A span whose parent is not in the trace becomes an extra root, marked `orphan`.
 *  - A span that is its own parent, or lies on a parent cycle, is broken deterministically: on each cycle the member that
 *    sorts first becomes a root and is marked `cycleBroken`. Spans hanging off a cycle keep their place below it.
 *  - Depth is capped at MAX_TREE_DEPTH; deeper spans are still listed, at the capped depth, marked `depthCapped`.
 *  - Latency that is missing, negative or not a number counts as 0 and is marked `durationKnown: false`; a start that is not a
 *    finite number is replaced by the earliest valid start and marked `startInvalid`.
 *  - Every input span is either in `rows` exactly once or counted in `duplicates`: rows.length + duplicates === input.length.
 */

export const MAX_TREE_DEPTH = 64;

/** The fields of a span this module reads. Structurally the same as `SpanRow` from lib/repo/trace-detail (a type check at the page proves it). */
export interface SpanInput {
  key: string;
  parentId: string | null;
  name: string | null;
  kind: string | null;
  model: string | null;
  isError: boolean;
  startUs: number;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costMicro: number | null;
  unpriced: boolean;
}

export interface TreeRow<S extends SpanInput = SpanInput> {
  span: S;
  /** 0 for a root; capped at MAX_TREE_DEPTH. */
  depth: number;
  /** Direct children in the tree (after orphan and cycle handling). */
  childCount: number;
  /** The parent id points at a span that is not in this trace (it was never received, or fell outside the window). */
  orphan: boolean;
  /** This span was made a root to break a parent cycle (or because it is its own parent). */
  cycleBroken: boolean;
  /** Its true depth exceeds MAX_TREE_DEPTH. */
  depthCapped: boolean;
  /** Milliseconds from the trace start to this span's start. Never negative. */
  startOffsetMs: number;
  /** Never negative; 0 when the latency is unknown. */
  durationMs: number;
  durationKnown: boolean;
  startInvalid: boolean;
}

export interface TraceTree<S extends SpanInput = SpanInput> {
  /** Display order (pre-order: parent, then its children by start). */
  rows: TreeRow<S>[];
  /** Spans dropped because an earlier span had the same key. */
  duplicates: number;
  rootCount: number;
  orphanCount: number;
  cycleCount: number;
  depthCappedCount: number;
  /** What the waterfall needs: the trace's first start (microseconds since the epoch) and its length in ms (>= 0). */
  scale: { startUs: number; totalMs: number };
}

interface Item<S extends SpanInput> {
  span: S;
  startUs: number;
  startInvalid: boolean;
  canon: string;
}

const lt = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

function canonical(s: SpanInput, startUs: number): string {
  return JSON.stringify([s.key, s.parentId, s.name, s.kind, s.model, s.isError, startUs, s.latencyMs, s.inputTokens, s.outputTokens, s.cachedTokens, s.costMicro, s.unpriced]);
}

export function buildTraceTree<S extends SpanInput>(input: readonly S[]): TraceTree<S> {
  // 1. A start that is not a number is replaced by the earliest valid start (order independent).
  let minValid = Number.POSITIVE_INFINITY;
  for (const s of input) if (Number.isFinite(s.startUs) && s.startUs < minValid) minValid = s.startUs;
  const fallback = Number.isFinite(minValid) ? minValid : 0;
  const items: Item<S>[] = input.map((span) => {
    const ok = Number.isFinite(span.startUs);
    const startUs = ok ? span.startUs : fallback;
    return { span, startUs, startInvalid: !ok, canon: canonical(span, startUs) };
  });

  // 2. Total order. Ties on (start, key) fall through to the canonical text, so equal keys always sort the same way.
  items.sort((a, b) => (a.startUs !== b.startUs ? (a.startUs < b.startUs ? -1 : 1) : a.span.key !== b.span.key ? lt(a.span.key, b.span.key) : lt(a.canon, b.canon)));

  // 3. First of each key wins.
  const kept: Item<S>[] = [];
  const index = new Map<string, number>();
  let duplicates = 0;
  for (const it of items) {
    if (index.has(it.span.key)) {
      duplicates += 1;
      continue;
    }
    index.set(it.span.key, kept.length);
    kept.push(it);
  }
  const n = kept.length;
  if (n === 0) return { rows: [], duplicates, rootCount: 0, orphanCount: 0, cycleCount: 0, depthCappedCount: 0, scale: { startUs: 0, totalMs: 0 } };

  // 4. Parent of each span: -1 = root. Missing parent = orphan root. Self parent = cycle of length 1.
  const parent = new Int32Array(n).fill(-1);
  const orphan = new Uint8Array(n);
  const cycleBroken = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const pid = kept[i]!.span.parentId;
    if (pid === null) continue;
    const p = index.get(pid);
    if (p === undefined) orphan[i] = 1;
    else if (p === i) cycleBroken[i] = 1;
    else parent[i] = p;
  }

  // 5. Cycles. Every span has at most one parent, so the graph is a forest plus cycles. Walk up from each span; reaching a span
  //    that is on the current path means a cycle: its member with the smallest index (earliest in the total order) loses its parent.
  const state = new Uint8Array(n); // 0 unseen, 1 on the current path, 2 done
  const pathPos = new Int32Array(n);
  let cycleCount = cycleBroken.reduce((a, b) => a + b, 0);
  for (let start = 0; start < n; start++) {
    if (state[start] !== 0) continue;
    const path: number[] = [];
    let cur = start;
    while (cur !== -1 && state[cur] === 0) {
      state[cur] = 1;
      pathPos[cur] = path.length;
      path.push(cur);
      cur = parent[cur]!;
    }
    if (cur !== -1 && state[cur] === 1) {
      let breakAt = cur;
      for (let j = pathPos[cur]!; j < path.length; j++) if (path[j]! < breakAt) breakAt = path[j]!;
      parent[breakAt] = -1;
      cycleBroken[breakAt] = 1;
      cycleCount += 1;
    }
    for (const p of path) state[p] = 2;
  }

  // 6. Children lists in total order (ascending index), roots likewise.
  const childHead = new Int32Array(n).fill(-1);
  const childNext = new Int32Array(n).fill(-1);
  const childCount = new Int32Array(n);
  const roots: number[] = [];
  const tail = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = parent[i]!;
    if (p === -1) {
      roots.push(i);
      continue;
    }
    childCount[p] = childCount[p]! + 1;
    if (childHead[p] === -1) childHead[p] = i;
    else childNext[tail[p]!] = i;
    tail[p] = i;
  }

  // 7. Timing scale: first start and last end over the kept spans. Unknown latency ends where it starts.
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  const durations = new Float64Array(n);
  const known = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const it = kept[i]!;
    const lat = it.span.latencyMs;
    const ok = typeof lat === "number" && Number.isFinite(lat) && lat >= 0;
    known[i] = ok ? 1 : 0;
    durations[i] = ok ? lat : 0;
    if (it.startUs < first) first = it.startUs;
    const end = it.startUs + durations[i]! * 1000;
    if (end > last) last = end;
  }
  const totalMs = Math.max(0, (last - first) / 1000);

  // 8. Pre-order walk with an explicit stack. Pushing children in reverse makes the first child pop first.
  const rows: TreeRow<S>[] = [];
  const stack: Array<[number, number]> = [];
  for (let r = roots.length - 1; r >= 0; r--) stack.push([roots[r]!, 0]);
  let depthCappedCount = 0;
  while (stack.length > 0) {
    const [i, depth] = stack.pop()!;
    const it = kept[i]!;
    const capped = depth > MAX_TREE_DEPTH;
    if (capped) depthCappedCount += 1;
    rows.push({
      span: it.span,
      depth: capped ? MAX_TREE_DEPTH : depth,
      childCount: childCount[i]!,
      orphan: orphan[i] === 1,
      cycleBroken: cycleBroken[i] === 1,
      depthCapped: capped,
      startOffsetMs: Math.max(0, (it.startUs - first) / 1000),
      durationMs: durations[i]!,
      durationKnown: known[i] === 1,
      startInvalid: it.startInvalid,
    });
    const kids: number[] = [];
    for (let c = childHead[i]!; c !== -1; c = childNext[c]!) kids.push(c);
    for (let k = kids.length - 1; k >= 0; k--) stack.push([kids[k]!, depth + 1]);
  }

  return {
    rows,
    duplicates,
    rootCount: roots.length,
    orphanCount: orphan.reduce((a, b) => a + b, 0),
    cycleCount,
    depthCappedCount,
    scale: { startUs: first, totalMs },
  };
}
