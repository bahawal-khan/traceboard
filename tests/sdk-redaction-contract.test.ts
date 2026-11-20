import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redactText } from "@/lib/ingest/redact";

/**
 * The Python SDK redacts captured content locally (sdk/python/llm_monitor/_redact.py, a port of lib/ingest/redact.ts).
 * Both must give IDENTICAL output and counts for every case in the shared fixture, otherwise the client would let through
 * something the server catches (or the reverse), and the two rule sets would drift unnoticed.
 * Regenerate with `python tests/gen_redaction_fixtures.py` from sdk/python; the Python tests check the fixture is current.
 */
const fixture = JSON.parse(readFileSync("sdk/python/tests/fixtures/redaction_cases.json", "utf8")) as {
  cases: Array<{ name: string; input: string; expected: string; report: { secret: number; email: number; card: number; phone: number } }>;
};

describe("server redactor against the Python SDK's redaction fixture", () => {
  it("has a meaningful fixture", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(35);
    expect(new Set(fixture.cases.map((c) => c.name)).size).toBe(fixture.cases.length);
  });

  for (const c of fixture.cases) {
    it(`gives the same text and counts: ${c.name}`, () => {
      const r = redactText(c.input);
      expect(r.text).toBe(c.expected);
      expect(r.report).toEqual(c.report);
    });
  }

  it("redacting twice changes nothing (idempotent) on every case", () => {
    for (const c of fixture.cases) expect(redactText(redactText(c.input).text).text, c.name).toBe(redactText(c.input).text);
  });
});
