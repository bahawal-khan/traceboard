"use client";

import { ChartCard } from "@/components/charts/chart-card";
import { StatTile } from "@/components/charts/stat-tile";
import { StatusBadge } from "@/components/charts/status-badge";
import { TimeSeriesChart } from "@/components/charts/time-series-chart";
import { ProjectNav } from "@/components/dashboard/project-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { formatCompact, formatCostUsd, formatDuration, formatPercent } from "@/lib/format";

// Deterministic fake data (no Math.random: server and client must render the same).
const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 20, 0, 0, 0);
const rows = Array.from({ length: 48 }, (_, i) => {
  const wave = 1 + Math.sin(i / 5);
  return {
    t: START + i * HOUR,
    input: Math.round(8000 * wave + (i % 7) * 400),
    output: Math.round(2600 * wave + (i % 5) * 150),
    cost: i === 20 || i === 21 ? null : Number((0.4 * wave + (i % 4) * 0.05).toFixed(4)),
    p50: Math.round(600 + 250 * wave),
    p95: Math.round(1800 + 900 * wave + (i % 9) * 40),
  };
});

const tokenSeries = [
  { key: "input", label: "Input tokens", color: "var(--chart-1)" },
  { key: "output", label: "Output tokens", color: "var(--chart-2)" },
];

export function DesignGallery() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Chart kit (development only)</h1>
          <p className="text-sm text-muted-foreground">Fake, deterministic data. This page does not exist in production builds.</p>
        </div>
        <ThemeToggle />
      </div>

      <ProjectNav
        projectId="demo"
        basePath="/design"
        items={[
          { segment: "", label: "Overview" },
          { segment: "traces", label: "Traces" },
          { segment: "threads", label: "Threads" },
          { segment: "keys", label: "API keys" },
        ]}
      />

      <section aria-label="Headline numbers" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Calls (24 h)" value={formatCompact(12840)} hint="+8% vs previous 24 h" />
        <StatTile label="Cost (24 h)" value={formatCostUsd(18.42)} hint="Excludes 3 calls on an unpriced model" />
        <StatTile label="Cost of unknown model" value={formatCostUsd(null)} hint="No price for this model" />
        <StatTile label="Error rate" value={formatPercent(0.0125)} hint={<StatusBadge status="warning" label="Above 1%" />} />
      </section>

      <section aria-label="Charts" className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Tokens"
          description="Input and output, hourly"
          table={
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th className="py-1 pr-3 font-medium">Hour (UTC)</th>
                  <th className="py-1 pr-3 font-medium">Input</th>
                  <th className="py-1 font-medium">Output</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 6).map((r) => (
                  <tr key={r.t}>
                    <td className="py-0.5 pr-3">{new Date(r.t).toISOString().slice(0, 13)}h</td>
                    <td className="py-0.5 pr-3 tabular-nums">{r.input}</td>
                    <td className="py-0.5 tabular-nums">{r.output}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          <TimeSeriesChart data={rows} series={tokenSeries} kind="area" stacked formatValue={formatCompact} ariaLabel="Stacked area chart of input and output tokens per hour" />
        </ChartCard>

        <ChartCard
          title="Latency"
          description="p50 and p95 (approximate, from histogram buckets)"
          footnote="Percentiles are approximate: they come from 12 log-spaced latency buckets."
        >
          <TimeSeriesChart
            data={rows}
            series={[
              { key: "p50", label: "p50", color: "var(--chart-1)" },
              { key: "p95", label: "p95", color: "var(--chart-2)" },
            ]}
            kind="line"
            formatValue={formatDuration}
            ariaLabel="Line chart of p50 and p95 latency per hour"
          />
        </ChartCard>

        <ChartCard title="Cost" description="Gaps are unknown prices, never zero">
          <TimeSeriesChart
            data={rows}
            series={[{ key: "cost", label: "Cost", color: "var(--chart-3)" }]}
            kind="bar"
            formatValue={formatCostUsd}
            formatAxis={(v) => `$${v.toFixed(2)}`}
            ariaLabel="Bar chart of cost per hour; hours with an unpriced model are left blank"
          />
        </ChartCard>

        <ChartCard title="Loading state" state="loading" />
        <ChartCard
          title="Empty state"
          state="empty"
          emptyMessage="No events yet. Send your first trace with the three-line SDK setup."
        />
        <ChartCard title="Error state" state="error" />
      </section>

      <section aria-label="Status" className="flex flex-wrap gap-4 rounded-xl border p-4">
        <StatusBadge status="good" label="Healthy" />
        <StatusBadge status="warning" label="Approaching quota" />
        <StatusBadge status="serious" label="Conserve mode" />
        <StatusBadge status="critical" label="Quota reached" />
      </section>
    </main>
  );
}
