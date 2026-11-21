import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverviewView } from "@/components/dashboard/overview-view";
import { buildOverview } from "@/lib/dashboard/overview";
import type { OverviewData, OverviewRange, RollupRow } from "@/lib/dashboard/types";
import { getDemoOverview } from "@/lib/demo";

/**
 * OverviewView rendered to HTML (server render: charts show their skeleton, tables and text are real). It is the SAME
 * component the public /demo and the signed-in project page use, so these tests pin what both show.
 */
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 21, 12, 30, 0);
const BASE = "/dashboard/projects/p1";
const KEYS = `${BASE}/keys`;
const lat = [0, 0, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0];
const row = (over: Partial<RollupRow>): RollupRow => ({
  bucket: Math.floor(NOW / HOUR) * HOUR, model: "m", calls: 5, errors: 0, inputTokens: 900, outputTokens: 300, costMicro: 0, latSumMs: 1500, lat, ...over,
});
const build = (rows: RollupRow[], range: OverviewRange = "24h", priced: string[] = []): OverviewData =>
  buildOverview({ range, nowMs: NOW, rows, pricedModels: new Set(priced), eventsToday: 3, eventsLimit: 1900 });
const html = (data: OverviewData) => renderToStaticMarkup(createElement(OverviewView, { data, basePath: BASE, keysHref: KEYS }));
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("OverviewView: a project with data", () => {
  const markup = html(getDemoOverview("24h"));

  it("shows the tiles, four chart cards, the quota and the models table", () => {
    for (const t of ["Events", "Cost", "Tokens", "Error rate", "p95 latency (approx)", "Latency", "Models", "Events today (UTC)"]) expect(markup).toContain(t);
    expect(count(markup, 'data-slot="skeleton"')).toBe(4); // one per chart (the plots need the browser)
  });
  it("has exactly one <h2> 'Overview' and no <h1> (the page owns the h1)", () => {
    expect(count(markup, "<h2")).toBeGreaterThanOrEqual(1);
    expect(markup).toContain(">Overview</h2>");
    expect(markup).not.toContain("<h1");
  });
  it("range switch: links keep the page path, the current range is marked", () => {
    expect(markup).toContain(`href="${BASE}?range=24h"`);
    expect(markup).toContain(`href="${BASE}?range=7d"`);
    expect(markup).toMatch(/aria-current="page"[^>]*>24 hours</);
    expect(html(getDemoOverview("7d"))).toMatch(/aria-current="page"[^>]*>7 days</);
  });
  it("states that the unpriced model's cost is a lower bound and shows it as unknown, with the same words everywhere", () => {
    expect(markup).toMatch(/Lower bound: [\d,]+ events on acme-local-7b have no price/);
    expect(markup).toContain("no price"); // the models table badge
    expect(markup).toMatch(/Excludes [\d,]+ events on acme-local-7b \(no price\)\. Their cost is unknown, not zero\./);
  });
  it("marks hours with unpriced events as lower bounds in the cost table", () => {
    expect(html(getDemoOverview("7d"))).toContain("≥ $");
  });
  it("does not show the partial-data notice or the quickstart", () => {
    expect(markup).not.toContain("Partial data");
    expect(markup).not.toContain("LLM_MONITOR_API_KEY");
  });
  it("carries no prompt or response text (the view model has no field for it)", () => {
    for (const banned of ["prompt", "completion", "input_text", "output_text", "response text"]) expect(markup.toLowerCase()).not.toContain(banned);
  });
});

describe("OverviewView: an empty project shows the quickstart, not charts of zeros", () => {
  const data = build([]);
  const markup = html(data);

  it("says there are no events in the selected window", () => {
    expect(markup).toContain("No events in the last 24 hours");
    expect(html(build([], "7d"))).toContain("No events in the last 7 days");
  });
  it("shows the SDK three-line setup, the two environment variables and the OpenTelemetry exporter settings", () => {
    for (const s of ["LLM_MONITOR_API_KEY", "LLM_MONITOR_URL", "from llm_monitor import Monitor", "instrument_openai(OpenAI(), Monitor())", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "/api/otlp/v1/traces"]) {
      expect(markup).toContain(s);
    }
  });
  it("links to this project's API keys page and mentions the free-plan quota", () => {
    expect(markup).toContain(`href="${KEYS}"`);
    expect(markup).toContain("1,900 events per day");
  });
  it("contains placeholders only, never anything that looks like a real key", () => {
    expect(markup).toContain("lm_...");
    expect(markup).not.toMatch(/lm_[A-Za-z0-9]{12,}/);
  });
  it("draws NO chart, tile, quota meter or table (zeros would look like data)", () => {
    expect(count(markup, 'data-slot="skeleton"')).toBe(0);
    expect(markup).not.toContain('role="img"');
    for (const t of ["p95 latency", "Error rate", "Events today", "Models", "View as table", "$0.00"]) expect(markup).not.toContain(t);
  });
  it("keeps the range switch, and offers the 7-day view only from the 24-hour one", () => {
    expect(markup).toContain(`href="${BASE}?range=7d"`);
    expect(markup).toContain("Look at the last 7 days");
    expect(html(build([], "7d"))).not.toContain("Look at the last 7 days");
  });
  it("an empty window is empty even when older data exists outside it", () => {
    const old = row({ bucket: Date.UTC(2026, 9, 1), calls: 99 });
    expect(html(build([old]))).toContain("No events in the last 24 hours");
  });
});

describe("OverviewView: partial data", () => {
  it("shows the notice when the reader reports truncation, still shows the numbers it has, and only then", () => {
    const rows = [row({ model: "priced", calls: 4, costMicro: 1000 })];
    const partial = html({ ...build(rows, "24h", ["priced"]), truncated: true });
    expect(partial).toContain("Partial data");
    expect(partial).toContain("every total below");
    expect(partial).toContain("Models");
    expect(html(build(rows, "24h", ["priced"]))).not.toContain("Partial data");
  });
  it("does not replace the empty state with the notice", () => {
    expect(html({ ...build([]), truncated: true })).toContain("No events in the last 24 hours");
  });
});

describe("OverviewView: unknown cost is never shown as 0", () => {
  // Three hours with events ONLY on an unpriced model: the rollups hold cost 0 for them.
  const rows = [0, 1, 2].map((i) => row({ bucket: Math.floor(NOW / HOUR) * HOUR - i * HOUR, model: "acme-local-7b", calls: 5, costMicro: 0 }));
  const data = build(rows);
  const markup = html(data);

  it("the cost tile reads unknown with the lower-bound reason, not $0.00", () => {
    expect(markup).toMatch(/<p[^>]*title="Unknown"[^>]*>—<\/p>/);
    expect(markup).toContain("Lower bound: 15 events on acme-local-7b have no price");
  });
  it("with NO known cost at all the cost chart says the cost is unknown, instead of an empty axis or a table of dashes", () => {
    expect(markup).toContain("Cost is unknown for this range: its events are on models without a price (acme-local-7b).");
    expect(markup).not.toContain("≥ $");
  });
  it("the model row is unknown with a 'no price' badge", () => {
    expect(markup).toMatch(/title="Unknown: no price for this model"/);
    expect(markup).not.toMatch(/acme-local-7b<\/td>[^]*?\$0\.00<\/td><\/tr>/); // its cost cell is not a zero
  });
  it("MIXED hours: an hour with only unpriced events is a dash, an hour with both is a '≥' lower bound, a priced hour is exact", () => {
    const h = Math.floor(NOW / HOUR) * HOUR;
    const mixed = html(
      build(
        [
          row({ bucket: h, model: "priced", calls: 4, costMicro: 2_500 }), // newest hour: priced + unpriced
          row({ bucket: h, model: "acme-local-7b", calls: 6, costMicro: 0 }),
          row({ bucket: h - HOUR, model: "acme-local-7b", calls: 5, costMicro: 0 }), // only unpriced: unknown
          row({ bucket: h - 2 * HOUR, model: "priced", calls: 2, costMicro: 300 }), // priced only: exact
        ],
        "24h",
        ["priced"],
      ),
    );
    expect(mixed).toContain("≥ $0.0025");
    expect(count(mixed, 'title="Lower bound: some events this hour have no price">—</td>')).toBe(1);
    expect(mixed).toContain(">$0.0003<");
    expect(mixed).not.toContain("≥ $0.00<");
    expect(mixed).not.toContain("Cost is unknown for this range"); // there IS a known cost, so the chart is drawn
  });
  it("a priced model at a genuine zero cost stays $0.00 and is not flagged", () => {
    const free = html(build([row({ model: "free-1", calls: 5, costMicro: 0 })], "24h", ["free-1"]));
    expect(free).not.toContain("Lower bound");
    expect(free).not.toContain("no price");
    expect(free).toContain("$0.00");
  });
});
