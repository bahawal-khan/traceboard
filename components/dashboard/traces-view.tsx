import { CheckCircle2, CircleAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { EmptyOverview } from "@/components/dashboard/empty-overview";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  TRACE_RANGES,
  TRACE_STATUS_FILTERS,
  buildTracesHref,
  toTraceRowView,
  type TraceRange,
  type TraceRowView,
  type TraceStatusFilter,
} from "@/lib/dashboard/traces-view";
import { formatInt } from "@/lib/format";
import type { TraceListItem } from "@/lib/repo/traces";
import { cn } from "@/lib/utils";

const RANGE_LABEL: Record<TraceRange, string> = { "24h": "24 hours", "7d": "7 days", "14d": "14 days" };
const RANGE_TEXT: Record<TraceRange, string> = { "24h": "the last 24 hours", "7d": "the last 7 days", "14d": "the last 14 days" };
const STATUS_LABEL: Record<TraceStatusFilter, string> = { all: "All traces", errors: "Errors only" };

export interface TracesViewProps {
  items: readonly TraceListItem[];
  range: TraceRange;
  status: TraceStatusFilter;
  /** True when this page was reached with a cursor (so a link back to the newest traces makes sense). */
  hasCursor: boolean;
  /** From listTraces; null on the last page. */
  nextCursor: string | null;
  /** listTraces hit its scan cap: older traces may be missing or incomplete. */
  truncated: boolean;
  basePath: string;
  keysHref?: string;
  /** Fixed query parameters of the host page (dev fixtures only). */
  extraParams?: Record<string, string>;
}

/**
 * The Traces list body. Server component, no client JavaScript: filters and paging are plain links. Rows are NOT links yet
 * (trace detail is P3.6). Shows structure only: names, counts, times and cost, never any message text.
 */
export function TracesView({ items, range, status, hasCursor, nextCursor, truncated, basePath, keysHref, extraParams }: TracesViewProps) {
  const href = (s: { range?: TraceRange; status?: TraceStatusFilter; cursor?: string | null }) =>
    buildTracesHref(basePath, { range: s.range ?? range, status: s.status ?? status, cursor: s.cursor }, extraParams);
  const rows = items.map(toTraceRowView);
  const empty = rows.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Traces</h2>
          <p className="text-sm text-muted-foreground">Newest first, times in UTC. Showing {RANGE_TEXT[range]}.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <nav aria-label="Time range" className="inline-flex rounded-lg border p-0.5">
            {TRACE_RANGES.map((r) => (
              <Pill key={r} href={href({ range: r, cursor: null })} active={r === range}>
                {RANGE_LABEL[r]}
              </Pill>
            ))}
          </nav>
          <nav aria-label="Status" className="inline-flex rounded-lg border p-0.5">
            {TRACE_STATUS_FILTERS.map((s) => (
              <Pill key={s} href={href({ status: s, cursor: null })} active={s === status}>
                {STATUS_LABEL[s]}
              </Pill>
            ))}
          </nav>
        </div>
      </div>

      {truncated ? (
        <Alert>
          <TriangleAlert className="text-status-warning" aria-hidden />
          <AlertTitle>Partial data</AlertTitle>
          <AlertDescription>
            This window holds more events than one page load reads. The newest traces are shown; older traces may be missing or incomplete.
            Pick a shorter range to see everything.
          </AlertDescription>
        </Alert>
      ) : null}

      {empty ? (
        <EmptyState range={range} status={status} hasCursor={hasCursor} basePath={basePath} keysHref={keysHref} href={href} />
      ) : (
        <>
          <div className="hidden md:block">
            <TraceTable rows={rows} />
          </div>
          <ul aria-label="Traces" className="space-y-3 md:hidden">
            {rows.map((r) => (
              <li key={r.key}>
                <TraceCard row={r} />
              </li>
            ))}
          </ul>
        </>
      )}

      {!empty || hasCursor ? (
        <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{empty ? "" : `${formatInt(rows.length)} traces on this page`}</p>
          <div className="flex gap-2">
            {hasCursor ? (
              <Link href={href({ cursor: null })} className={buttonVariants({ variant: "outline", className: "h-11 px-4 sm:h-9" })}>
                Newest
              </Link>
            ) : null}
            {nextCursor ? (
              <Link href={href({ cursor: nextCursor })} rel="next" className={buttonVariants({ variant: "outline", className: "h-11 px-4 sm:h-9" })}>
                Older
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function Pill({ href, active, children }: { href: string; active: boolean; children: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap sm:min-h-8",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

function EmptyState({
  range,
  status,
  hasCursor,
  basePath,
  keysHref,
  href,
}: {
  range: TraceRange;
  status: TraceStatusFilter;
  hasCursor: boolean;
  basePath: string;
  keysHref?: string;
  href: (s: { status?: TraceStatusFilter; cursor?: string | null }) => string;
}) {
  if (hasCursor) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No older traces</CardTitle>
          <CardDescription>There is nothing after this point in {RANGE_TEXT[range]}.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (status === "errors") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No traces with errors in {RANGE_TEXT[range]}</CardTitle>
          <CardDescription>Every trace in this window finished without a failed step.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={href({ status: "all", cursor: null })} className={buttonVariants({ variant: "outline", className: "h-11 px-4 sm:h-9" })}>
            Show all traces
          </Link>
        </CardContent>
      </Card>
    );
  }
  return <EmptyOverview range={range} basePath={basePath} keysHref={keysHref} noun="traces" />;
}

/** Icon plus words, never colour alone. A trace with no failed step says so instead of leaving a blank. */
function ErrorBadge({ label }: { label: string | null }) {
  return label ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <CircleAlert className="size-4 shrink-0 text-status-critical" aria-hidden />
      <span>{label}</span>
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <CheckCircle2 className="size-4 shrink-0 text-status-good" aria-hidden />
      <span>OK</span>
    </span>
  );
}

function RootName({ row }: { row: TraceRowView }) {
  return (
    <div className="min-w-0">
      <div className={cn("truncate font-medium", row.orphan && "italic text-muted-foreground")} title={row.rootTitle}>
        {row.rootLabel}
      </div>
      <div className="truncate font-mono text-xs text-muted-foreground" title={row.traceId}>
        {row.traceId}
      </div>
    </div>
  );
}

function Cost({ row }: { row: TraceRowView }) {
  return (
    <span title={row.costTitle ?? undefined} className="tabular-nums">
      {row.cost}
    </span>
  );
}

function TraceTable({ rows }: { rows: TraceRowView[] }) {
  return (
    <Card className="p-0">
      <Table className="table-fixed">
        <TableCaption className="sr-only">Traces, newest first</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-24">Started (UTC)</TableHead>
            <TableHead>Trace</TableHead>
            <TableHead className="w-20 text-right">Duration</TableHead>
            <TableHead className="w-14 text-right">Spans</TableHead>
            <TableHead className="w-24">Status</TableHead>
            <TableHead className="w-16 text-right">Tokens</TableHead>
            <TableHead className="w-24 text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key}>
              <TableCell className="tabular-nums whitespace-nowrap">
                <span className="block text-xs text-muted-foreground">{r.started.slice(0, 10)}</span>
                <span className="block">{r.started.slice(11)}</span>
              </TableCell>
              <TableCell>
                <RootName row={r} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.duration}</TableCell>
              <TableCell className="text-right tabular-nums">{r.spans}</TableCell>
              <TableCell>
                <ErrorBadge label={r.errorLabel} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.tokens}</TableCell>
              <TableCell className="text-right">
                <Cost row={r} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function TraceCard({ row }: { row: TraceRowView }) {
  return (
    <Card className="gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <RootName row={row} />
        <div className="shrink-0">
          <ErrorBadge label={row.errorLabel} />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Field label="Started (UTC)">{row.started}</Field>
        <Field label="Duration">{row.duration}</Field>
        <Field label="Spans">{row.spans}</Field>
        <Field label="Tokens">{row.tokens}</Field>
        <Field label="Cost">
          <Cost row={row} />
        </Field>
      </dl>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate tabular-nums">{children}</dd>
    </div>
  );
}
