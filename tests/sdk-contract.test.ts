import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ingestBody, ingestEvent, INGEST_LIMITS } from "@/lib/ingest/validate";

/**
 * Cross-language contract: the Python SDK (sdk/python) builds events from deliberately nasty inputs into a committed
 * fixture (sdk/python/tests/fixtures/contract_events.json, kept current by sdk/python/tests/test_contract.py). The REAL
 * server schema must accept every one of them. If the SDK ever produces an event the server rejects, the whole batch
 * would be refused with a 422 in production; this test makes that a build failure instead.
 */
const fixture = JSON.parse(readFileSync("sdk/python/tests/fixtures/contract_events.json", "utf8")) as { events: Record<string, unknown>[] };

describe("Python SDK events against the server schema", () => {
  it("has a meaningful fixture within the server's batch limit", () => {
    expect(fixture.events.length).toBeGreaterThanOrEqual(25);
    expect(fixture.events.length).toBeLessThanOrEqual(INGEST_LIMITS.maxEventsPerBatch);
  });

  it("every event is accepted by the strict ingest event schema", () => {
    for (const [i, e] of fixture.events.entries()) {
      const r = ingestEvent.safeParse(e);
      expect(r.success, `event #${i}: ${JSON.stringify(r.success ? "" : r.error.issues)}`).toBe(true);
    }
  });

  it("the whole batch is accepted, exactly as the SDK would send it", () => {
    expect(ingestBody.safeParse({ events: fixture.events }).success).toBe(true);
  });

  it("the fixture is not vacuous: the same schema rejects the things the SDK removes", () => {
    const base = fixture.events[0]!;
    for (const bad of [{ cost_usd: 1 }, { project_id: "p" }, { error: "line1\nline2" }, { trace_id: "t".repeat(129) }, { input_tokens: -1 }, { prompt_hash: "A".repeat(64) }, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, { ts: "2026-11-20T11:59:00" }]) {
      expect(ingestEvent.safeParse({ ...base, ...bad }).success, JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
  });

  it("exercises the boundaries it claims to: UTF-16 length, byte-capped content, lone surrogates, big counts", () => {
    const text = JSON.stringify(fixture.events);
    expect(fixture.events.some((e) => typeof e.span_id === "string" && (e.span_id as string).length === 128)).toBe(true); // 64 emoji = 128 UTF-16 units
    expect(fixture.events.some((e) => e.input_tokens === 10_000_000)).toBe(true);
    expect(fixture.events.some((e) => e.content && new TextEncoder().encode((e.content as { input?: string }).input ?? "").length === 2048)).toBe(true);
    expect(text).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i); // no lone high surrogate left in the JSON
  });
});
