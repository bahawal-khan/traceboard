import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The ingest route file must stay a thin export of the tested handler: no db, no auth shortcuts, bounded duration. */
describe("app/api/ingest/route.ts", () => {
  const src = readFileSync("app/api/ingest/route.ts", "utf8");

  it("exports only POST, built by createIngestHandler", () => {
    const exported = [...src.matchAll(/export\s+(?:async\s+)?(?:const|function)\s+([A-Za-z]+)/g)].map((m) => m[1]);
    expect(exported.filter((n) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(n!))).toEqual(["POST"]);
    expect(src).toMatch(/export\s+const\s+POST\s*=\s*createIngestHandler\(/);
  });

  it("has no direct database, driver or session access", () => {
    expect(src).not.toMatch(/@neondatabase|lib\/db|getSql|@clerk|auth\(\)|lib\/repo/);
  });

  it("runs on the Node runtime, dynamically, with a short maxDuration (Hobby maximum is 300 s)", () => {
    expect(src).toMatch(/export const runtime = "nodejs"/);
    expect(src).toMatch(/export const dynamic = "force-dynamic"/);
    const m = /export const maxDuration = (\d+)/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(30);
  });

  it("is not wrapped by the dashboard session guard (it authenticates with API keys)", () => {
    expect(src).not.toMatch(/sessionRoute/);
  });
});
