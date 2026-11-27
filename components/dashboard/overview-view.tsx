import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { ChartCard } from "@/components/charts/chart-card";
import { StatTile } from "@/components/charts/stat-tile";
import { StatusBadge } from "@/components/charts/status-badge";
import { TimeSeriesChart } from "@/components/charts/time-series-chart";
import { EmptyOverview } from "@/components/dashboard/empty-overview";
import { QuotaBanner } from "@/components/dashboard/quota-banner";
import { QuotaMeter } from "@/components/dashboard/quota-meter";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { overviewState } from "@/lib/dashboard/page-state";
import { OVERVIEW_RANGES, type OverviewData, type OverviewRange } from "@/lib/dashboard/types";
import {
  UNKNOWN,
  UNKNOWN_COST_TITLE,
  formatCompact,
  formatCostMicro,
  formatCostUsd,
  formatDuration,
  formatInt,
  formatPercent,
  formatUtc,
} from "@/lib/format";
import { cn } from "@/lib/utils";

const RANGE_LABEL: Record<OverviewRange, string> = { "24h": "24 hours", "7d": "7 days" };

/**
 * The Overview page body. It knows nothing about where the data came from (database or static demo): it renders an
 * `OverviewData`. Server component; only the chart plots are client components, and they receive plain data.
 */
export function OverviewView({ data, basePath, keysHref }: { data: OverviewData; basePath: string; keysHref?: string }) {
  const t = data.totals;
  const errorRate = t.calls > 0 ? t.errors / t.calls : null;
  const errorStatus = errorRate === null ? null : errorRate >= 0.05 ? ("critical" as const) : errorRate >= 0.01 ? ("warning" as const) : ("good" as const);
  const costKnown = !(t.costMicro === 0 && data.unpricedCalls > 0); // never show 0 when the only calls were unpriced
  const unpriced = data.unpricedModels.join(", ");

  const rows = data.series.map((p) => ({
    t: p.t,
    calls: p.calls,
    input: p.inputTokens,
    output: p.outputTokens,
    // An hour whose only events were on an unpriced model has an UNKNOWN cost, not a zero one: null draws a gap and reads "—".
    cost: p.costLowerBound && p.costMicro === 0 ? null : p.costMicro / 1_000_000,
    costLb: p.costLowerBound ? 1 : 0, // 1 = this hour has events on an unpriced model: the cost is a lower bound
    p50: p.p50,
    p95: p.p95,
  }));
  const empty = overviewState(data) === "empty";
  const state = empty ? ("empty" as const) : ("ready" as const);

  if (empty) {
    // No events in this window: show how to send some, NOT charts of zeros that would look like data.
    return (
      <div className="space-y-6">
        <OverviewHeader data={data} basePath={basePath} />
        <EmptyOverview range={data.range} basePath={basePath} keysHref={keysHref} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <OverviewHeader data={data} basePath={basePath} />

      <QuotaBanner used={data.quota.eventsToday} limit={data.quota.eventsLimit} />

      {data.truncated ? (
        <Alert>
          <TriangleAlert className="text-status-warning" aria-hidden />
          <AlertTitle>Partial data</AlertTitle>
          <AlertDescription>
            This project reports an unusually large number of distinct model names, so older hours are incomplete and every total below
            is partial. Use consistent model ids to fix this.
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-label="Headline numbers" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Events" value={empty ? null : formatInt(t.calls)} hint="All spans, every kind" />
        <StatTile
          label="Cost"
          value={empty || !costKnown ? null : formatCostMicro(t.costMicro)}
          hint={
            data.unpricedCalls > 0
              ? `Lower bound: ${formatInt(data.unpricedCalls)} events on ${unpriced} have no price`
              : "Priced models only"
          }
        />
        <StatTile
          label="Tokens"
          value={empty ? null : formatCompact(t.inputTokens + t.outputTokens)}
          hint={empty ? undefined : `${formatCompact(t.inputTokens)} in, ${formatCompact(t.outputTokens)} out`}
        />
        <StatTile
          label="Error rate"
          value={errorRate === null ? null : formatPercent(errorRate)}
          hint={
            errorStatus === null ? undefined : (
              <StatusBadge
                status={errorStatus}
                label={errorStatus === "good" ? "Healthy" : errorStatus === "warning" ? "Above 1%" : "Above 5%"}
              />
            )
          }
        />
        <StatTile label="p95 latency (approx)" value={empty ? null : formatDuration(t.p95)} hint={empty ? undefined : `p50 ${formatDuration(t.p50)}`} />
      </section>

      <QuotaMeter used={data.quota.eventsToday} limit={data.quota.eventsLimit} />

      <section aria-label="Charts" className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Events"
          description="Per hour, all kinds"
          state={state}
          emptyMessage="No events in this range. Send a trace with the three-line SDK setup."
          table={<SeriesTable rows={rows} columns={[{ key: "calls", label: "Events", fmt: formatInt }]} />}
        >
          <TimeSeriesChart data={rows} series={[{ key: "calls", label: "Events", color: "var(--chart-1)" }]} kind="bar" valueFormat="int" ariaLabel={`Bar chart of events per hour over the last ${RANGE_LABEL[data.range]}`} />
        </ChartCard>

        <ChartCard
          title="Tokens"
          description="Input and output, per hour"
          state={state}
          table={
            <SeriesTable
              rows={rows}
              columns={[
                { key: "input", label: "Input", fmt: formatInt },
                { key: "output", label: "Output", fmt: formatInt },
              ]}
            />
          }
        >
          <TimeSeriesChart
            data={rows}
            series={[
              { key: "input", label: "Input tokens", color: "var(--chart-1)" },
              { key: "output", label: "Output tokens", color: "var(--chart-2)" },
            ]}
            kind="area"
            stacked
            valueFormat="compact"
            ariaLabel={`Stacked area chart of input and output tokens per hour over the last ${RANGE_LABEL[data.range]}`}
          />
        </ChartCard>

        <ChartCard
          title="Cost"
          description="Per hour, priced models only"
          // Nothing priced to draw: say the cost is UNKNOWN instead of an empty axis that looks like "no cost".
          state={costKnown ? state : "empty"}
          emptyMessage={`Cost is unknown for this range: its events are on models without a price (${unpriced}).`}
          footnote={data.unpricedCalls > 0 ? `Excludes ${formatInt(data.unpricedCalls)} events on ${unpriced} (no price). Their cost is unknown, not zero.` : undefined}
          table={<SeriesTable rows={rows} columns={[{ key: "cost", label: "Cost", fmt: formatCostUsd, lowerBoundKey: "costLb" }]} />}
        >
          <TimeSeriesChart data={rows} series={[{ key: "cost", label: "Cost", color: "var(--chart-3)" }]} kind="bar" valueFormat="cost" ariaLabel={`Bar chart of cost per hour over the last ${RANGE_LABEL[data.range]}`} />
        </ChartCard>

        <ChartCard
          title="Latency"
          description="p50 and p95, per hour (approximate)"
          state={state}
          footnote="Approximate: derived from 12 log-spaced latency buckets. Hours without latency data are gaps."
          table={
            <SeriesTable
              rows={rows}
              columns={[
                { key: "p50", label: "p50", fmt: formatDuration },
                { key: "p95", label: "p95", fmt: formatDuration },
              ]}
            />
          }
        >
          <TimeSeriesChart
            data={rows}
            series={[
              { key: "p50", label: "p50", color: "var(--chart-1)" },
              { key: "p95", label: "p95", color: "var(--chart-2)" },
            ]}
            kind="line"
            valueFormat="duration"
            ariaLabel={`Line chart of p50 and p95 latency per hour over the last ${RANGE_LABEL[data.range]}`}
          />
        </ChartCard>
      </section>

      <Card className="min-w-0">
        <div className="px-(--card-spacing)">
          <h2 className="font-heading text-base font-medium">Models</h2>
          <p className="text-sm text-muted-foreground">Events, tokens and cost per model in this range.</p>
        </div>
        {data.models.length === 0 ? (
          <p className="px-(--card-spacing) text-sm text-muted-foreground">No events in this range.</p>
        ) : (
          <Table>
            <TableCaption className="sr-only">Events, tokens and cost per model</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Events</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.models.map((m) => (
                <TableRow key={m.model ?? "(none)"}>
                  <TableCell className="max-w-32 truncate font-medium sm:max-w-none" title={m.model ?? undefined}>
                    {m.model ?? <span className="font-normal text-muted-foreground">Other spans (no model)</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(m.calls)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">{formatCompact(m.inputTokens + m.outputTokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.costMicro === null ? (
                      <span className="inline-flex items-center justify-end gap-1.5" title={UNKNOWN_COST_TITLE}>
                        <span aria-label="Unknown cost">{UNKNOWN}</span>
                        <Badge variant="secondary">no price</Badge>
                      </span>
                    ) : m.model === null ? (
                      <span className="text-muted-foreground">{UNKNOWN}</span>
                    ) : (
                      formatCostMicro(m.costMicro)
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

/** Title, window and range switch. The page's own <h1> is the project (or demo) name, so this is an <h2>. */
function OverviewHeader({ data, basePath }: { data: OverviewData; basePath: string }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Overview</h2>
        <p className="text-sm text-muted-foreground">
          {formatUtc(data.from)} to {formatUtc(data.to)}
        </p>
      </div>
      <nav aria-label="Time range" className="inline-flex rounded-lg border p-0.5">
        {OVERVIEW_RANGES.map((r) => (
          <Link
            key={r}
            href={`${basePath}?range=${r}`}
            aria-current={r === data.range ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium sm:min-h-8",
              r === data.range ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {RANGE_LABEL[r]}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** Compact table twin of a chart: same numbers, readable by screen readers and for copying. */
function SeriesTable({
  rows,
  columns,
}: {
  rows: Array<{ t: number } & Record<string, number | null>>;
  /** `lowerBoundKey`: a row field that is 1 when the value is only a lower bound; the cell then reads "≥ value". */
  columns: Array<{ key: string; label: string; fmt: (v: number) => string; lowerBoundKey?: string }>;
}) {
  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr>
          <th className="py-1 pr-3 font-medium">Hour (UTC)</th>
          {columns.map((c) => (
            <th key={c.key} className="py-1 pr-3 text-right font-medium">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.t}>
            <td className="py-0.5 pr-3 whitespace-nowrap">{formatUtc(r.t)}</td>
            {columns.map((c) => (
              <td
                key={c.key}
                className="py-0.5 pr-3 text-right tabular-nums"
                title={c.lowerBoundKey && r[c.lowerBoundKey] === 1 ? "Lower bound: some events this hour have no price" : undefined}
              >
                {r[c.key] === null ? UNKNOWN : `${c.lowerBoundKey && r[c.lowerBoundKey] === 1 ? "≥ " : ""}${c.fmt(r[c.key] as number)}`}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
