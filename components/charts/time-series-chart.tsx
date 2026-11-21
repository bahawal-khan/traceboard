"use client";

import { useSyncExternalStore } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatCompact, formatCostUsd, formatDuration, formatInt, formatPercent, formatUtc } from "@/lib/format";

export type ValueFormat = "compact" | "int" | "cost" | "duration" | "percent";

const FORMATTERS: Record<ValueFormat, (v: number) => string> = {
  compact: formatCompact,
  int: formatInt,
  cost: formatCostUsd,
  duration: formatDuration,
  percent: (v) => formatPercent(v),
};

/** Axis ticks of one chart share their decimals ("$0.25 $0.50", never "$0.25 $0.500"). Tooltips keep full precision. */
function axisFormatter(format: ValueFormat, max: number): (v: number) => string {
  if (format !== "cost") return FORMATTERS[format];
  const decimals = max >= 10 ? 0 : max >= 1 ? 2 : max >= 0.1 ? 3 : 4;
  return (v) => `$${v.toFixed(decimals)}`;
}

export interface TimeSeriesSeries {
  /** Data key. Must be a plain identifier (it becomes a CSS variable name). */
  key: string;
  label: string;
  /** Normally a theme token, `var(--chart-1)`. Colour follows the entity, never its rank. */
  color: string;
}

export interface TimeSeriesChartProps {
  /** One row per bucket: `t` is epoch milliseconds, the other keys are the series values (null = no data). */
  data: Array<{ t: number } & Record<string, number | null>>;
  series: TimeSeriesSeries[];
  kind?: "area" | "line" | "bar";
  /** Stack series (area and bar only). */
  stacked?: boolean;
  /**
   * How values are written on the axis and in the tooltip. A NAME, not a function, so server components can render
   * this chart: functions cannot cross the server/client boundary. X ticks are HH:MM for ranges up to 2 days, else MM-DD.
   */
  valueFormat: ValueFormat;
  ariaLabel: string;
  className?: string;
}

const subscribeNothing = () => () => {};

const defaultTick =(t: number, spanMs: number) => {
  const iso = new Date(t).toISOString();
  return spanMs <= 2 * 86_400_000 ? iso.slice(11, 16) : iso.slice(5, 10);
};

/**
 * One time-series chart for every dashboard page. Mark specs follow the dataviz rules: 2 px lines, no point markers,
 * recessive horizontal grid only, a legend whenever there are two or more series, crosshair tooltip with a UTC time,
 * a single y axis. Gaps stay gaps (null is never drawn as 0).
 */
export function TimeSeriesChart({
  data,
  series,
  kind = "area",
  stacked = false,
  valueFormat,
  ariaLabel,
  className,
}: TimeSeriesChartProps) {
  // The plot needs the browser (it measures its box). Until it mounts, the server HTML and the first client render show
  // a skeleton of the same size, so the page neither looks broken nor jumps when the chart code arrives.
  const mounted = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]));
  const spanMs = data.length > 1 ? data[data.length - 1].t - data[0].t : 0;
  const tick = (t: number) => defaultTick(t, spanMs);
  const formatValue = FORMATTERS[valueFormat];
  let max = 0;
  for (const row of data) for (const s of series) max = Math.max(max, row[s.key] ?? 0);
  const formatAxis = axisFormatter(valueFormat, max);

  const common = {
    data,
    margin: { top: 8, right: 8, bottom: 0, left: 0 },
    accessibilityLayer: true,
  } as const;

  const axes = (
    <>
      <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
      <XAxis
        dataKey="t"
        type="number"
        scale="time"
        domain={["dataMin", "dataMax"]}
        tickFormatter={tick}
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        minTickGap={32}
      />
      <YAxis tickFormatter={formatAxis} tickLine={false} axisLine={false} width="auto" tickMargin={4} />
      <ChartTooltip
        cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
        content={
          <ChartTooltipContent
            labelFormatter={(_, payload) => formatUtc(payload?.[0]?.payload?.t)}
            formatter={(value, name) => (
              <div className="flex w-full items-center justify-between gap-4">
                <span className="text-muted-foreground">{config[String(name)]?.label ?? name}</span>
                <span className="font-mono font-medium tabular-nums text-foreground">
                  {typeof value === "number" ? formatValue(value) : "—"}
                </span>
              </div>
            )}
          />
        }
      />
      {series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
    </>
  );

  if (!mounted) return <Skeleton aria-hidden className={className ?? "h-full w-full"} />;

  return (
    <div role="img" aria-label={ariaLabel} className={className ?? "h-full w-full"}>
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        {kind === "bar" ? (
          <BarChart {...common}>
            {axes}
            {series.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                fill={`var(--color-${s.key})`}
                stackId={stacked ? "stack" : undefined}
                radius={stacked ? 0 : [4, 4, 0, 0]}
                stroke="var(--card)"
                strokeWidth={stacked ? 2 : 0}
                maxBarSize={28}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        ) : kind === "line" ? (
          <LineChart {...common}>
            {axes}
            {series.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                type="monotone"
                stroke={`var(--color-${s.key})`}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        ) : (
          <AreaChart {...common}>
            {axes}
            {series.map((s) => (
              <Area
                key={s.key}
                dataKey={s.key}
                type="monotone"
                stackId={stacked ? "stack" : undefined}
                stroke={`var(--color-${s.key})`}
                strokeWidth={2}
                fill={`var(--color-${s.key})`}
                fillOpacity={0.18}
                dot={false}
                activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        )}
      </ChartContainer>
    </div>
  );
}
