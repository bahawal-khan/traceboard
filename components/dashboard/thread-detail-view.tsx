import { CheckCircle2, CircleAlert, Info, TriangleAlert, Unlink } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ThreadDetailView, ThreadNoticeId, TurnRowView } from "@/lib/dashboard/thread-detail-view";
import { cn } from "@/lib/utils";

const NOTICE_ICON: Record<ThreadNoticeId, LucideIcon> = {
  truncated: TriangleAlert,
  untraced: Unlink,
  "no-traces": Unlink,
  scope: Info,
};

/**
 * The thread detail body: summary, notices, then the turns (one per trace), oldest first. Server component, no client
 * JavaScript. Structure only: ids, names, times, counts and cost, never any message text. Every id and name comes from the
 * SDK, so it is only ever rendered as text (React escapes it), with invisible and reordering characters made visible.
 */
export function ThreadDetailPageView({ view, backHref }: { view: ThreadDetailView; backHref: string }) {
  const s = view.summary;
  return (
    <div className="space-y-5">
      <Link href={backHref} className={buttonVariants({ variant: "outline", className: "h-11 px-4 sm:h-9" })}>
        Back to threads
      </Link>

      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight">Thread</h2>
        <code className="mt-1 block truncate font-mono text-sm" title={s.fullId}>
          {s.shortId}
        </code>
        {s.idShortened ? <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{s.fullId}</p> : null}
        <span className="sr-only">Full thread id: {s.fullId}</span>
        <p className="mt-1 text-sm text-muted-foreground">Oldest turn first, times in UTC.</p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border p-4 sm:grid-cols-3 lg:grid-cols-7">
        <Stat label="Turns">{s.turns}</Stat>
        <Stat label="Events">{s.events}</Stat>
        <Stat label="Errors">
          {s.errorLabel ? (
            <span className="inline-flex items-center gap-1.5">
              <CircleAlert className="size-4 shrink-0 text-status-critical" aria-hidden />
              <span>{s.errorLabel}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="size-4 shrink-0 text-status-good" aria-hidden />
              <span>None</span>
            </span>
          )}
        </Stat>
        <Stat label="Tokens">{s.tokens}</Stat>
        <Stat label="Cost">
          <span title={s.costTitle ?? undefined}>{s.cost}</span>
        </Stat>
        <Stat label="First activity (UTC)">{s.firstActivity}</Stat>
        <Stat label="Last activity (UTC)">{s.lastActivity}</Stat>
      </dl>

      <div className="space-y-3" role="region" aria-label="Notices about this thread">
        {view.notices.map((n) => {
          const Icon = NOTICE_ICON[n.id];
          return (
            <Alert key={n.id}>
              <Icon className={n.id === "scope" ? "text-muted-foreground" : "text-status-warning"} aria-hidden />
              <AlertTitle>{n.label}</AlertTitle>
              <AlertDescription>{n.detail}</AlertDescription>
            </Alert>
          );
        })}
      </div>

      {view.turns.length > 0 ? (
        <>
          <div className="hidden md:block">
            <TurnTable rows={view.turns} />
          </div>
          <ol aria-label="Turns" className="space-y-3 md:hidden">
            {view.turns.map((r) => (
              <li key={r.key}>
                <TurnCard row={r} />
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/** Icon plus words, never colour alone. */
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

/** The link of a turn: its root span name over its trace id, to the trace detail page. `stretch` makes a whole card one tap target. */
function TurnLink({ row, stretch }: { row: TurnRowView; stretch?: boolean }) {
  return (
    <Link
      href={row.href}
      aria-label={`Open turn ${row.n}, ${row.rootLabel}, trace ${row.traceIdTitle}`}
      className={cn(
        "block min-h-11 min-w-0 rounded-sm sm:min-h-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        stretch && "after:absolute after:inset-0 after:content-['']",
      )}
    >
      <span className={cn("block truncate font-medium underline-offset-4 hover:underline", row.orphan && "italic text-muted-foreground")} title={row.rootLabel}>
        {row.n}. {row.rootLabel}
      </span>
      <span className="block truncate font-mono text-xs text-muted-foreground" title={row.traceIdTitle}>
        {row.traceIdTitle}
      </span>
    </Link>
  );
}

function Cost({ row }: { row: TurnRowView }) {
  return (
    <span title={row.costTitle ?? undefined} className="tabular-nums">
      {row.cost}
    </span>
  );
}

function TurnTable({ rows }: { rows: TurnRowView[] }) {
  return (
    <Card className="p-0">
      <Table className="table-fixed">
        <TableCaption className="sr-only">Turns of this thread, oldest first</TableCaption>
        <TableHeader>
          <TableRow>
            {/* Column widths fit the header text (measured in a browser, see the Traces table) plus room; headers do not wrap. */}
            <TableHead className="w-32">Started (UTC)</TableHead>
            <TableHead>Turn</TableHead>
            <TableHead className="w-20 text-right">Duration</TableHead>
            <TableHead className="w-20 text-right">Spans</TableHead>
            <TableHead className="w-24">Status</TableHead>
            <TableHead className="w-20 text-right">Tokens</TableHead>
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
                <TurnLink row={r} />
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

function TurnCard({ row }: { row: TurnRowView }) {
  return (
    <Card className="relative gap-3 p-4 hover:bg-muted/40">
      <div className="flex items-start justify-between gap-3">
        <TurnLink row={row} stretch />
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
