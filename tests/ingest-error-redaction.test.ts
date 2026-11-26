import { describe, expect, it } from "vitest";
import { LOADED_MACHINE_TIMEOUT_MS } from "./helpers/timeouts";
import { ERROR_MAX_CHARS, normalizeEvents, sanitizeError } from "@/lib/ingest/normalize";
import { PriceBook } from "@/lib/ingest/cost";
import type { IngestEvent } from "@/lib/ingest/validate";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const prices = new PriceBook(async () => []);

function run(error: string | undefined): string | null {
  const ev = { event_id: "11111111-1111-4111-8111-111111111111", ts: "2026-01-01T12:00:00Z", kind: "llm", status: "error", error } as IngestEvent;
  return normalizeEvents([ev], prices, NOW).accepted[0]!.error;
}

describe("error text redaction (normalizeEvents)", () => {
  it("redacts an email", () => {
    const out = run("failed for alice@example.com while saving");
    expect(out).toBe("failed for [redacted:email] while saving");
  });
  it("redacts a Luhn-valid card number", () => {
    expect(run("card 4111 1111 1111 1111 declined")).toBe("card [redacted:card] declined");
  });
  it("keeps a digit run that fails Luhn", () => {
    expect(run("order 4111 1111 1111 1112 failed")).toContain("4111 1111 1111 1112");
  });
  it("redacts an API secret and a bearer token", () => {
    const out = run("401 with sk-live-abcdefghijklmnop1234 and Authorization: Bearer abcdefghijklmnopqrstuv");
    expect(out).not.toMatch(/sk-live|abcdefghijklmnop/);
    expect(out).toContain("[redacted:secret]");
  });
  it("redacts a connection string", () => {
    expect(run("connect postgres://u:pw@db.example.com/x failed")).toBe("connect [redacted:secret] failed");
  });
  it("leaves a clean error unchanged", () => {
    expect(run("TimeoutError: upstream took 30001 ms (status 504)")).toBe("TimeoutError: upstream took 30001 ms (status 504)");
  });
  it("absent error stays null", () => {
    expect(run(undefined)).toBeNull();
  });
  it("is deterministic: same input, same output, every time", () => {
    const input = "x@y.com sk-test-abcdefghijklmnop12 4111111111111111 +92 300 1234567";
    const first = run(input);
    for (let i = 0; i < 20; i++) expect(run(input)).toBe(first);
  });
  it("cuts to 500 characters AFTER redaction", () => {
    const out = run("a".repeat(480) + " alice@example.com " + "b".repeat(100))!;
    expect(out.length).toBeLessThanOrEqual(ERROR_MAX_CHARS);
    expect(out).not.toContain("alice");
    // a secret straddling the 500 limit must not leave a readable prefix
    const straddle = run("a".repeat(490) + "alice.longname@example.com")!;
    expect(straddle).not.toContain("alice");
  });
  it("never ends on half a surrogate pair", () => {
    const out = sanitizeError("a".repeat(499) + "😀😀")!;
    expect(out.length).toBeLessThanOrEqual(ERROR_MAX_CHARS);
    const last = out.charCodeAt(out.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
  it("stays fast on very long hostile input (input cap)", () => {
    for (const hostile of ["1".repeat(1_000_000), "1 ".repeat(500_000), "-".repeat(1_000_000), "a".repeat(1_000_000)]) {
      const t = performance.now();
      const out = sanitizeError(hostile)!;
      expect(performance.now() - t).toBeLessThan(500);
      expect(out.length).toBeLessThanOrEqual(ERROR_MAX_CHARS);
    }
  }, LOADED_MACHINE_TIMEOUT_MS);
});
