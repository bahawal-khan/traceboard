import { describe, expect, it } from "vitest";
import { createLogger, sanitize } from "@/lib/logger";
import { newRequestId, requestIdFrom } from "@/lib/request-id";
import { QUOTAS } from "@/lib/quotas";

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger({}, { minLevel: "debug", sink: (l) => lines.push(l) }) };
}

describe("logger", () => {
  it("redacts sensitive field names", () => {
    const { lines, log } = capture();
    log.info("ingest", {
      requestId: "r1",
      headers: { authorization: "Bearer abcdefgh12345678" },
      body: { prompt: "my secret prompt" },
      apiKey: "lm_abcdefghijklmnop",
      projectId: "p1",
    });
    const out = lines[0];
    expect(out).not.toContain("my secret prompt");
    expect(out).not.toContain("abcdefgh12345678");
    expect(out).not.toContain("lm_abcdefghijklmnop");
    const rec = JSON.parse(out);
    expect(rec.projectId).toBe("p1");
    expect(rec.requestId).toBe("r1");
    expect(rec.headers).toBe("[redacted]");
  });

  it("scrubs secret-looking values in free text and errors", () => {
    const { lines, log } = capture();
    log.error("failed with lm_abcdefghijklmnop", {
      err: new Error("connect postgres://user:pw@host/db with sk-ant-abcdefghijklmnopqrstuv"),
      note: "Bearer abcdefghijklmnop",
    });
    const out = lines[0];
    for (const s of ["lm_abcdefghijklmnop", "user:pw", "sk-ant-abcdefghijklmnopqrstuv", "Bearer abcdefghijklmnop"]) {
      expect(out).not.toContain(s);
    }
  });

  it("respects the minimum level and limits depth and length", () => {
    const lines: string[] = [];
    const log = createLogger({}, { minLevel: "warn", sink: (l) => lines.push(l) });
    log.info("hidden");
    log.warn("shown");
    expect(lines).toHaveLength(1);
    expect(sanitize("x".repeat(2000)) as string).toContain("[truncated]");
    expect(JSON.stringify(sanitize({ a: { b: { c: { d: { e: 1 } } } } }))).toContain("[depth-limit]");
  });

  it("child loggers carry base fields", () => {
    const { lines, log } = capture();
    log.child({ requestId: "r2" }).info("hi");
    expect(JSON.parse(lines[0]).requestId).toBe("r2");
  });
});

describe("request id", () => {
  it("keeps a safe incoming id and replaces unsafe ones", () => {
    expect(requestIdFrom(new Headers({ "x-request-id": "abc-12345678" }))).toBe("abc-12345678");
    const bad = requestIdFrom(new Headers({ "x-request-id": "bad id with spaces" }));
    expect(bad).toMatch(/^[0-9a-f-]{36}$/);
    expect(newRequestId()).not.toBe(newRequestId());
  });
});

describe("quotas", () => {
  it("matches the documented free-tier defaults", () => {
    expect(QUOTAS.ingestRequestsPerDayPerProject).toBe(3_000);
    expect(QUOTAS.eventsPerDayPerProject).toBe(1_900); // derived from the measured row size, see tests/quotas-capacity.test.ts
    expect(QUOTAS.projectsPerUser).toBe(2);
    expect(QUOTAS.keysPerProject).toBe(5);
  });
});
