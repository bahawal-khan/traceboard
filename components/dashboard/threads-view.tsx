import { CheckCircle2, CircleAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TRACE_RANGES, type TraceRange } from "@/lib/dashboard/traces-view";
import { buildThreadsHref, toThreadRowView, type ThreadItemInput, type ThreadRowView } from "@/lib/dashboard/threads-view";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

const RANGE_LABEL: Record<TraceRange, string> = { "24h": "24 hours", "7d": "7 days", "14d": "14 days" };
const RANGE_TEXT: Record<TraceRange, string> = { "24h": "the last 24 hours", "7d": "the last 7 days", "14d": "the last 14 days" };

export interface ThreadsViewProps {
  items: readonly ThreadItemInput[];
  range: TraceRange;
  /** True when this page was reached with a cursor (so a link back to the most recent threads makes sense). */
  hasCursor: boolean;
  /** From listThreads; null on the last page. */
  nextCursor: string | null;
  /** listThreads hit its scan cap: older threads may be missing or incomplete. */
  truncated: boolean;
  basePath: string;
  /** The Traces page, offered when there are no threads. */
  tracesHref?: string;
  /** Where a row leads: the thread detail page (the dev fixtures point at themselves). */
  rowHref: (threadId: string) => string;
  /** Fixed query parameters of the host page (dev fixtures only). */
  extraParams?: Record<string, string>;
}

/**
 * The Threads list body. Server component, no client JavaScript: range, paging and the rows are plain links. Shows
 * structure only: ids, counts, times and cost, never any message text. Thread ids come from the SDK, so they are only ever
 * rendered as text (React escapes them), shortened, with the full id in the tooltip and the link label.
 */
export function ThreadsView({ items, range, hasCursor, nextCursor, truncated, basePath, tracesHref, rowHref, extraParams }: ThreadsViewProps) {
  const href = (s: { range?: TraceRange; cursor?: string | null }) => buildThreadsHref(basePath, { range: s.range ?? range, cursor: s.cursor }, extraParams);
  const rows = items.map(toThreadRowView);
  const empty = rows.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Threads</h2>
          <p className="text-sm text-muted-foreground">Most recently active first, times in UTC. Showing {RANGE_TEXT[range]}.</p>
        </div>
        <nav aria-label="Time range" className="inline-flex rounded-lg border p-0.5">
          {TRACE_RANGES.map((r) => (
            <Pill key={r} href={href({ range: r, cursor: null })} active={r === range}>
              {RANGE_LABEL[r]}
            </Pill>
          ))}
        </nav>
      </div>

      {truncated ? (
        <Alert>
          <TriangleAlert className="text-status-warning" aria-hidden />
          <AlertTitle>Partial data</AlertTitle>
          <AlertDescription>
            This window holds more events than one page load reads. The most recently active threads are shown; older threads may be missing or
            incomplete. Pick a shorter range to see everything.
          </AlertDescription>
        </Alert>
      ) : null}

      {empty ? (
        <EmptyState range={range} hasCursor={hasCursor} tracesHref={tracesHref} />
      ) : (
        <>
          <div className="hidden md:block">
            <ThreadTable rows={rows} rowHref={rowHref} />
          </div>
          <ul aria-label="Threads" className="space-y-3 md:hidden">
            {rows.map((r) => (
              <li key={r.key}>
                <ThreadCard row={r} rowHref={rowHref} />
              </li>
            ))}
          </ul>
        </>
      )}

      {!empty || hasCursor ? (
        <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{empty ? "" : `${formatInt(rows.length)} threads on this page`}</p>
          <div className="flex gap-2">
            {hasCursor ? (
              <Link href={href({ cursor: null })} className={buttonVariants({ variant: "outline", className: "h-11 px-4 sm:h-9" })}>
                Most recent
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

function EmptyState({ range, hasCursor, tracesHref }: { range: TraceRange; hasCursor: boolean; tracesHref?: string }) {
  if (hasCursor) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No older threads</CardTitle>
          <CardDescription>There is nothing after this point in {RANGE_TEXT[range]}.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>No threads in {RANGE_TEXT[range]}</CardTitle>
        <CardDescription>
          A thread groups the traces of one conversation. Events show up here when they carry a thread id, for example{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">mon.trace(&quot;support-agent&quot;, thread_id=session_id)</code> in the Python SDK.
        </CardDescription>
      </CardHeader>
      {tracesHref ? (
        <CardContent>
          <Link href={tracesHref} className={buttonVariants({ variant: "outline", className: "h-11 px-4 sm:h-9" })}>
            See the traces
          </Link>
        </CardContent>
      ) : null}
    </Card>
  );
}

/** Icon plus words, never colour alone. A thread with no failed event says so instead of leaving a blank. */
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

/**
 * The link of a row: the shortened id, with the full id in the tooltip and the accessible name. `stretch` extends its click
 * area over the whole card (a pseudo-element covering the nearest positioned ancestor); in the table it fills its cell.
 */
function ThreadId({ row, href, stretch }: { row: ThreadRowView; href: string; stretch?: boolean }) {
  return (
    <Link
      href={href}
      aria-label={`Open thread ${row.idTitle}`}
      title={row.idTitle}
      className={cn(
        "block min-h-11 min-w-0 rounded-sm sm:min-h-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        stretch && "after:absolute after:inset-0 after:content-['']",
      )}
    >
      <span className="block truncate font-mono text-sm font-medium underline-offset-4 hover:underline">{row.idLabel}</span>
    </Link>
  );
}

function Cost({ row }: { row: ThreadRowView }) {
  return (
    <span title={row.costTitle ?? undefined} className="tabular-nums">
      {row.cost}
    </span>
  );
}

function ThreadTable({ rows, rowHref }: { rows: ThreadRowView[]; rowHref: (threadId: string) => string }) {
  return (
    <Card className="p-0">
      <Table className="table-fixed">
        <TableCaption className="sr-only">Threads, most recently active first</TableCaption>
        <TableHeader>
          <TableRow>
            {/* Column widths fit the header text (measured at 1280 px: "Last active (UTC)" is 111 px) plus room; headers do not wrap. */}
            <TableHead className="w-36">Last active (UTC)</TableHead>
            <TableHead>Thread</TableHead>
            <TableHead className="w-16 text-right">Turns</TableHead>
            <TableHead className="w-20 text-right">Events</TableHead>
            <TableHead className="w-24">Status</TableHead>
            <TableHead className="w-20 text-right">Tokens</TableHead>
            <TableHead className="w-24 text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key}>
              <TableCell className="tabular-nums whitespace-nowrap">
                <span className="block text-xs text-muted-foreground">{r.lastActive.slice(0, 10)}</span>
                <span className="block">{r.lastActive.slice(11)}</span>
              </TableCell>
              <TableCell>
                <ThreadId row={r} href={rowHref(r.threadId)} />
              </TableCell>
              <TableCell className="text-right tabular-nums" title={r.turnsTitle ?? undefined}>
                {r.turns}
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.events}</TableCell>
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

function ThreadCard({ row, rowHref }: { row: ThreadRowView; rowHref: (threadId: string) => string }) {
  return (
    <Card className="relative gap-3 p-4 hover:bg-muted/40">
      <div className="flex items-start justify-between gap-3">
        <ThreadId row={row} href={rowHref(row.threadId)} stretch />
        <div className="shrink-0">
          <ErrorBadge label={row.errorLabel} />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Field label="Last active (UTC)">{row.lastActive}</Field>
        <Field label="Started (UTC)">{row.started}</Field>
        <Field label="Turns">
          <span title={row.turnsTitle ?? undefined}>{row.turns}</span>
        </Field>
        <Field label="Events">{row.events}</Field>
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
