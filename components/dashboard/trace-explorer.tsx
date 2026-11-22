"use client";

import { CheckCircle2, CircleAlert, Flag } from "lucide-react";
import { useState } from "react";
import { TraceWaterfall } from "@/components/dashboard/trace-waterfall";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TABLE_ROW_LIMIT, describeSpan, type SpanView } from "@/lib/dashboard/trace-detail-view";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

type Mode = "waterfall" | "table";

/**
 * The interactive part of the trace page: the virtualised waterfall, the bounded table fallback, and the panel of the
 * selected span. The spans arrive already built (plain data); the panel shows metadata only, never message content.
 */
export function TraceExplorer({ spans, totalLabel }: { spans: readonly SpanView[]; totalLabel: string }) {
  const [mode, setMode] = useState<Mode>("waterfall");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = selectedKey === null ? null : (spans.find((s) => s.key === selectedKey) ?? null);

  return (
    <section aria-label="Spans" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Spans</h3>
          <p className="text-sm text-muted-foreground">
            {formatInt(spans.length)} {spans.length === 1 ? "span" : "spans"} on a {totalLabel} scale. Bars show when each span ran.
          </p>
        </div>
        <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label="View">
          <ModeButton active={mode === "waterfall"} onClick={() => setMode("waterfall")}>
            Waterfall
          </ModeButton>
          <ModeButton active={mode === "table"} onClick={() => setMode("table")}>
            View as table
          </ModeButton>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          {mode === "waterfall" ? (
            <TraceWaterfall spans={spans} selectedKey={selectedKey} onSelect={setSelectedKey} />
          ) : (
            <SpanTable spans={spans} selectedKey={selectedKey} onSelect={setSelectedKey} />
          )}
        </div>
        <SpanPanel span={selected} />
      </div>
    </section>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "ghost"}
      aria-pressed={active}
      onClick={onClick}
      className="h-11 px-3 text-sm whitespace-nowrap sm:h-8"
    >
      {children}
    </Button>
  );
}

function StatusBadge({ error }: { error: boolean }) {
  return error ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <CircleAlert className="size-4 shrink-0 text-status-critical" aria-hidden />
      <span>Error</span>
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <CheckCircle2 className="size-4 shrink-0 text-status-good" aria-hidden />
      <span>OK</span>
    </span>
  );
}

/**
 * The same spans as a real table: the accessible fallback, and a way to read exact numbers. Bounded: only the first
 * TABLE_ROW_LIMIT spans are drawn, and the caption says how many were left out.
 */
export function SpanTable({ spans, selectedKey, onSelect }: { spans: readonly SpanView[]; selectedKey: string | null; onSelect: (key: string) => void }) {
  const shown = spans.slice(0, TABLE_ROW_LIMIT);
  const hidden = spans.length - shown.length;
  return (
    <div>
      <div role="region" aria-label="Spans table (scrolls sideways)" tabIndex={0} className="overflow-x-auto rounded-lg border">
        <Table className="min-w-[44rem]">
          <TableCaption className="sr-only">
            Spans in trace order{hidden > 0 ? `, the first ${formatInt(shown.length)} of ${formatInt(spans.length)}` : ""}
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Span</TableHead>
              <TableHead className="w-14 text-right">Level</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="w-24 text-right">Start</TableHead>
              <TableHead className="w-24 text-right">Duration</TableHead>
              <TableHead className="w-24 text-right">Tokens in/out</TableHead>
              <TableHead className="w-24 text-right">Cost</TableHead>
              <TableHead className="w-20">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((s) => {
              const d = describeSpan(s);
              return (
                <TableRow key={s.key} data-state={s.key === selectedKey ? "selected" : undefined}>
                  <TableCell className="max-w-64">
                    <button
                      type="button"
                      onClick={() => onSelect(s.key)}
                      aria-pressed={s.key === selectedKey}
                      className="block min-h-11 w-full truncate text-left font-medium underline-offset-4 hover:underline sm:min-h-8"
                      title={s.label}
                    >
                      {s.label}
                    </button>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{d.level}</TableCell>
                  <TableCell>{d.kind}</TableCell>
                  <TableCell className="max-w-40 truncate" title={d.model}>
                    {d.model}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{d.offset}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.duration}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.inputTokens} / {d.outputTokens}
                  </TableCell>
                  <TableCell className="text-right tabular-nums" title={d.costTitle ?? undefined}>
                    {d.cost}
                  </TableCell>
                  <TableCell>
                    <StatusBadge error={s.isError} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {hidden > 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Showing the first {formatInt(shown.length)} of {formatInt(spans.length)} spans. Switch to the waterfall to reach all of them.
        </p>
      ) : null}
    </div>
  );
}

export function SpanPanel({ span }: { span: SpanView | null }) {
  if (span === null) {
    return (
      <Card role="region" aria-label="Selected span" className="self-start">
        <CardHeader>
          <CardTitle className="text-base">Span details</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Select a span to see its details. With the keyboard: arrow keys, then Enter.</CardContent>
      </Card>
    );
  }
  const d = describeSpan(span);
  return (
    <Card role="region" aria-label="Selected span" aria-live="polite" className="self-start">
      <CardHeader>
        <CardTitle className="text-base break-words" title={span.label}>
          {d.title}
        </CardTitle>
        <StatusBadge error={span.isError} />
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Field label="Kind">{d.kind}</Field>
          <Field label="Model">{d.model}</Field>
          <Field label="Starts at">{d.offset}</Field>
          <Field label="Duration">{d.duration}</Field>
          <Field label="Input tokens">{d.inputTokens}</Field>
          <Field label="Output tokens">{d.outputTokens}</Field>
          <Field label="Cached tokens">{d.cachedTokens}</Field>
          <Field label="Cost">
            <span title={d.costTitle ?? undefined}>{d.cost}</span>
          </Field>
          <Field label="Level">{d.level}</Field>
          <Field label="Children">{d.children}</Field>
          <div className="col-span-2 min-w-0">
            <dt className="text-xs text-muted-foreground">Started (UTC)</dt>
            <dd className="tabular-nums">{d.started}</dd>
          </div>
          <div className="col-span-2 min-w-0">
            <dt className="text-xs text-muted-foreground">Span id</dt>
            <dd className="font-mono text-xs break-all">{span.key}</dd>
          </div>
        </dl>
        {d.flags.length > 0 ? (
          <ul aria-label="Notes about this span" className="space-y-1.5 text-sm">
            {d.flags.map((f) => (
              <li key={f} className={cn("flex items-start gap-2")}>
                <Flag className="mt-0.5 size-4 shrink-0 text-status-warning" aria-hidden />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular-nums break-words">{children}</dd>
    </div>
  );
}
