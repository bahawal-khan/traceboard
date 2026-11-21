import { describe, expect, it } from "vitest";
import { costMicro, microToUsdString, parsePrice, PriceBook, stripDateSuffix, type ModelPrice } from "@/lib/ingest/cost";
import { checkTs, normalizeEvents, TS_WINDOW_MS } from "@/lib/ingest/normalize";
import { ingestBody, ingestEvent, INGEST_LIMITS } from "@/lib/ingest/validate";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const ID = "3f0c1b2e-8a64-4d1f-9c7e-5b2a6d9e1f40";
const HASH = "a".repeat(64);
const ev = (o: Record<string, unknown> = {}) => ({ event_id: ID, ts: "2026-11-20T11:59:00Z", ...o });

const SONNET: ModelPrice = { model: "claude-sonnet-5-5", inputPer1m: "2.00", cachedInputPer1m: "0.10", outputPer1m: "10.00" };
const NOCACHE: ModelPrice = { model: "plain", inputPer1m: "0.15", cachedInputPer1m: null, outputPer1m: "0.60" };
const book = (rows: ModelPrice[]) => new PriceBook(async () => rows, 60_000, () => NOW);

describe("ingest schema", () => {
  it("accepts a minimal event and applies defaults", () => {
    const e = ingestEvent.parse(ev());
    expect(e.kind).toBe("llm");
    expect(e.status).toBe("ok");
  });

  it("requires ts and event_id", () => {
    expect(ingestEvent.safeParse({ event_id: ID }).success).toBe(false);
    expect(ingestEvent.safeParse({ ts: "2026-11-20T11:59:00Z" }).success).toBe(false);
  });

  it("rejects timestamps without an offset and non-ISO strings", () => {
    expect(ingestEvent.safeParse(ev({ ts: "2026-11-20T11:59:00" })).success).toBe(false);
    expect(ingestEvent.safeParse(ev({ ts: "yesterday" })).success).toBe(false);
    expect(ingestEvent.safeParse(ev({ ts: "2026-11-20T11:59:00+05:00" })).success).toBe(true);
  });

  it("is strict: server-computed and tenant columns are rejected", () => {
    for (const k of ["cost_usd", "project_id", "received_at", "id", "unknown"]) {
      expect(ingestEvent.safeParse(ev({ [k]: k === "cost_usd" ? 1 : "x" })).success, k).toBe(false);
    }
    expect(ingestBody.safeParse({ events: [ev()], extra: 1 }).success).toBe(false);
  });

  it("bounds every field", () => {
    const bad: Record<string, unknown>[] = [
      { event_id: "not-a-uuid" },
      { trace_id: "x".repeat(129) },
      { name: "a\nb" },
      { model: "" },
      { kind: "weird" },
      { status: "maybe" },
      { input_tokens: -1 },
      { input_tokens: 1.5 },
      { output_tokens: INGEST_LIMITS.maxTokens + 1 },
      { latency_ms: INGEST_LIMITS.maxLatencyMs + 1 },
      { prompt_hash: "ABC" },
      { prompt_hash: "A".repeat(64) },
      { error: "e".repeat(501) },
      { tags: Array.from({ length: INGEST_LIMITS.maxTags + 1 }, (_, i) => `t${i}`) },
      { tags: ["x".repeat(41)] },
      { content: { input: "é".repeat(1100) } }, // 2,200 bytes > 2,048
      { content: { other: "x" } },
    ];
    for (const b of bad) expect(ingestEvent.safeParse(ev(b)).success, JSON.stringify(b).slice(0, 60)).toBe(false);
    expect(ingestEvent.safeParse(ev({ prompt_hash: HASH, args_hash: HASH, user_id_hash: HASH, tags: ["a"], content: { input: "hi" } })).success).toBe(true);
  });

  it("limits the batch size: 1..100 events", () => {
    expect(ingestBody.safeParse({ events: [] }).success).toBe(false);
    expect(ingestBody.safeParse({ events: Array.from({ length: 100 }, () => ev()) }).success).toBe(true);
    expect(ingestBody.safeParse({ events: Array.from({ length: 101 }, () => ev()) }).success).toBe(false);
    expect(ingestBody.safeParse({}).success).toBe(false);
  });
});

describe("cost arithmetic", () => {
  it("parses decimal prices exactly", () => {
    expect(parsePrice("8.00")).toBe(BigInt(8_000_000));
    expect(parsePrice("0.01")).toBe(BigInt(10_000));
    expect(parsePrice("0.000001")).toBe(BigInt(1));
    expect(parsePrice("12")).toBe(BigInt(12_000_000));
    for (const bad of ["", "-1", "1e3", "1.1234567", "abc", "1."]) expect(() => parsePrice(bad), bad).toThrow();
  });

  it("USD per 1M tokens is micro-USD per token", () => {
    expect(costMicro(SONNET, 1_000_000, 0)).toBe(2_000_000);
    expect(costMicro(SONNET, 0, 1_000_000)).toBe(10_000_000);
    expect(costMicro(SONNET, 1000, 500)).toBe(2_000 + 5_000);
  });

  it("bills cached tokens at the cache price, as a subset of the total input", () => {
    // 1,000 total input, 600 cached: 400 * 2 + 600 * 0.1 = 860
    expect(costMicro(SONNET, 1000, 0, 600)).toBe(860);
    // cached above the total is clamped, not billed twice
    expect(costMicro(SONNET, 1000, 0, 5000)).toBe(100);
  });

  it("falls back to the input price when no cache price exists", () => {
    expect(costMicro(NOCACHE, 1_000_000, 0, 500_000)).toBe(150_000);
  });

  it("rounds half up to whole micro-USD", () => {
    expect(costMicro({ ...NOCACHE, inputPer1m: "0.5" }, 1, 0)).toBe(1); // 0.5 -> 1
    expect(costMicro({ ...NOCACHE, inputPer1m: "0.4" }, 1, 0)).toBe(0);
  });

  it("formats numeric(12,6) text", () => {
    expect(microToUsdString(0)).toBe("0.000000");
    expect(microToUsdString(7)).toBe("0.000007");
    expect(microToUsdString(1_234_567)).toBe("1.234567");
    expect(microToUsdString(25_000_000)).toBe("25.000000");
  });
});

describe("PriceBook", () => {
  it("returns null for unknown models and missing token counts, never a guess", async () => {
    const b = book([SONNET]);
    await b.ready();
    expect(b.cost("nope", 10, 10)).toBeNull();
    expect(b.cost(undefined, 10, 10)).toBeNull();
    expect(b.cost("claude-sonnet-5-5", undefined, undefined)).toBeNull();
    expect(b.cost("Claude-Sonnet-5-5", 1000, 0)).toBe(2000); // lookup is case-insensitive
  });

  it("hasPrice follows the exact rule cost() uses (case, then ONE date suffix), and is false for '' and unknown ids", async () => {
    const b = book([SONNET]);
    await b.ready();
    expect(b.hasPrice("claude-sonnet-5-5")).toBe(true);
    expect(b.hasPrice("Claude-Sonnet-5-5")).toBe(true);
    expect(b.hasPrice("claude-sonnet-5-5-2026-11-01")).toBe(true);
    expect(b.hasPrice("claude-sonnet-5-5-20261101")).toBe(true);
    expect(b.hasPrice("claude-sonnet-5-5-2026-13-45")).toBe(false); // not a real date: no stripping
    expect(b.hasPrice("claude-sonnet-5-5-extra")).toBe(false); // no prefix or fuzzy matching
    expect(b.hasPrice("")).toBe(false);
    expect(b.hasPrice("nope")).toBe(false);
    // it agrees with cost() on every one of those ids
    for (const id of ["claude-sonnet-5-5", "Claude-Sonnet-5-5", "claude-sonnet-5-5-2026-11-01", "claude-sonnet-5-5-2026-13-45", "nope"]) {
      expect(b.hasPrice(id)).toBe(b.cost(id, 1, 1) !== null);
    }
  });

  it("caches within the ttl and reloads after it", async () => {
    let t = NOW;
    let loads = 0;
    const b = new PriceBook(async () => (loads++, [SONNET]), 60_000, () => t);
    await b.ready();
    await b.ready();
    expect(loads).toBe(1);
    t += 61_000;
    await b.ready();
    expect(loads).toBe(2);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    let loads = 0;
    const b = new PriceBook(async () => (loads++, [SONNET]), 60_000, () => NOW);
    await Promise.all([b.ready(), b.ready(), b.ready()]);
    expect(loads).toBe(1);
  });

  it("keeps serving the last good list when a refresh fails", async () => {
    let t = NOW;
    let fail = false;
    const b = new PriceBook(async () => (fail ? Promise.reject(new Error("db down")) : [SONNET]), 60_000, () => t);
    await b.ready();
    t += 61_000;
    fail = true;
    await expect(b.ready()).resolves.toBeUndefined();
    expect(b.cost("claude-sonnet-5-5", 1000, 0)).toBe(2000);
  });

  it("throws when there has never been a successful load", async () => {
    const b = new PriceBook(() => Promise.reject(new Error("db down")), 60_000, () => NOW);
    await expect(b.ready()).rejects.toThrow("price list unavailable");
  });
});

describe("model lookup", () => {
  const GPT: ModelPrice = { model: "gpt-4o", inputPer1m: "2.50", cachedInputPer1m: "1.25", outputPer1m: "10.00" };
  const DATED: ModelPrice = { model: "dated-model-2025-01-01", inputPer1m: "9.00", cachedInputPer1m: null, outputPer1m: "9.00" };
  const loaded = async () => {
    const b = book([GPT, SONNET, DATED, { ...GPT, model: "dated-model", inputPer1m: "1.00" }]);
    await b.ready();
    return b;
  };

  it("strips only a real trailing date", () => {
    expect(stripDateSuffix("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(stripDateSuffix("gpt-4o-20240806")).toBe("gpt-4o");
    for (const id of ["gpt-4o", "gpt-4o-2024", "gpt-4o-2024-13-06", "gpt-4o-2024-02-30", "gpt-4o-20241301", "gpt-4o-2024-0806", "gpt-4o-1999-01-01", "gpt-4o-2024-08-06-preview", "2024-08-06"])
      expect(stripDateSuffix(id), id).toBeNull();
  });

  it("matches gpt-4o-2024-08-06 style ids after the exact match fails", async () => {
    const b = await loaded();
    expect(b.cost("gpt-4o-2024-08-06", 1_000_000, 0)).toBe(2_500_000);
    expect(b.cost("GPT-4o-20240806", 1_000_000, 0)).toBe(2_500_000);
    expect(b.cost("claude-sonnet-5-5-2026-11-01", 1_000_000, 0)).toBe(2_000_000);
  });

  it("an exact id always wins, even if it ends in a date", async () => {
    const b = await loaded();
    expect(b.cost("dated-model-2025-01-01", 1_000_000, 0)).toBe(9_000_000); // not the "dated-model" price
    expect(b.cost("dated-model-2025-02-02", 1_000_000, 0)).toBe(1_000_000); // stripped to "dated-model"
  });

  it("returns null (never 0) for unknown models, including a known name plus a non-date suffix", async () => {
    const b = await loaded();
    expect(b.cost("unknown-model-2024-08-06", 1000, 1000)).toBeNull();
    expect(b.cost("gpt-4o-mini", 1000, 1000)).toBeNull(); // no prefix matching
    expect(b.cost("gpt-4o-2024-08-06-preview", 1000, 1000)).toBeNull();
  });

  it("does not strip something that only looks like a date", async () => {
    const b = await loaded();
    expect(b.cost("gpt-4o-2024-13-45", 1000, 1000)).toBeNull();
    expect(b.cost("gpt-4o-99999999", 1000, 1000)).toBeNull();
    expect(b.cost("gpt-4o-2024", 1000, 1000)).toBeNull();
  });
});

describe("cached token billing", () => {
  it("bills (input - cached) at the input rate and cached at the cached rate, output at the output rate", () => {
    // 1,000,000 total input, 250,000 cached, 100,000 output on 2.00 / 0.10 / 10.00 per 1M
    const expected = 750_000 * 2 + 250_000 * 0.1 + 100_000 * 10; // micro-USD
    expect(costMicro(SONNET, 1_000_000, 100_000, 250_000)).toBe(expected);
    expect(expected).toBe(1_500_000 + 25_000 + 1_000_000);
  });

  it("does not double count: cost with cached is below cost without", () => {
    expect(costMicro(SONNET, 1000, 0, 600)).toBeLessThan(costMicro(SONNET, 1000, 0, 0));
  });
});

describe("normalizeEvents", () => {
  const prepared = async () => {
    const b = book([SONNET]);
    await b.ready();
    return b;
  };

  it("accepts the window edges and rejects outside them, with a reason", () => {
    expect(checkTs(new Date(NOW - TS_WINDOW_MS), NOW)).toBeNull();
    expect(checkTs(new Date(NOW + TS_WINDOW_MS), NOW)).toBeNull();
    expect(checkTs(new Date(NOW - TS_WINDOW_MS - 1), NOW)).toBe("ts_too_old");
    expect(checkTs(new Date(NOW + TS_WINDOW_MS + 1), NOW)).toBe("ts_in_future");
  });

  it("rejects events individually, never the whole batch, and never rewrites ts", async () => {
    const b = await prepared();
    const old = "3f0c1b2e-8a64-4d1f-9c7e-5b2a6d9e1f41";
    const future = "3f0c1b2e-8a64-4d1f-9c7e-5b2a6d9e1f42";
    const { accepted, rejected } = normalizeEvents(
      [
        ingestEvent.parse(ev()),
        ingestEvent.parse(ev({ event_id: old, ts: "2026-11-10T00:00:00Z" })),
        ingestEvent.parse(ev({ event_id: future, ts: "2026-12-30T00:00:00Z" })),
      ],
      b,
      NOW,
    );
    expect(accepted.map((a) => a.eventId)).toEqual([ID]);
    expect(accepted[0]!.occurredAt).toEqual(new Date("2026-11-20T11:59:00Z"));
    expect(rejected).toEqual([
      { event_id: old, reason: "ts_too_old" },
      { event_id: future, reason: "ts_in_future" },
    ]);
  });

  it("is deterministic across retries: the same input gives the same rows", async () => {
    const b = await prepared();
    const input = [ingestEvent.parse(ev({ model: "claude-sonnet-5-5", input_tokens: 10 }))];
    expect(normalizeEvents(input, b, NOW)).toEqual(normalizeEvents(input, b, NOW + 5 * 60_000));
  });

  it("prices events on the server and maps optional fields to null", async () => {
    const b = await prepared();
    const { accepted } = normalizeEvents(
      [ingestEvent.parse(ev({ model: "claude-sonnet-5-5", input_tokens: 1000, output_tokens: 500, cached_tokens: 600 }))],
      b,
      NOW,
    );
    const row = accepted[0]!;
    expect(row.costMicro).toBe(860 + 5000);
    expect(row.costUsd).toBe("0.005860");
    expect(row.cachedTokens).toBe(600);
    expect(row.traceId).toBeNull();
    expect(row.content).toBeNull();
  });

  it("leaves cost null for an unknown model", async () => {
    const b = await prepared();
    const { accepted } = normalizeEvents([ingestEvent.parse(ev({ model: "mystery", input_tokens: 10 }))], b, NOW);
    expect(accepted[0]!.costMicro).toBeNull();
    expect(accepted[0]!.costUsd).toBeNull();
  });

  it("handles cached_tokens > input_tokens deterministically: capped at the total, billed once", async () => {
    const b = await prepared();
    const { accepted } = normalizeEvents([ingestEvent.parse(ev({ model: "claude-sonnet-5-5", input_tokens: 1000, cached_tokens: 5000 }))], b, NOW);
    expect(accepted[0]!.cachedTokens).toBe(1000);
    expect(accepted[0]!.costMicro).toBe(100); // 1,000 cached * 0.10
  });

  it("stores no cached count when there is no input total", async () => {
    const b = await prepared();
    const { accepted } = normalizeEvents([ingestEvent.parse(ev({ model: "claude-sonnet-5-5", output_tokens: 100, cached_tokens: 50 }))], b, NOW);
    expect(accepted[0]!.cachedTokens).toBeNull();
    expect(accepted[0]!.costMicro).toBe(1000);
  });
});
