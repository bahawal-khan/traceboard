import { CheckCircle2, CircleAlert, Files, Layers, Repeat, TriangleAlert, Unlink } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { CopyButton } from "@/components/dashboard/copy-button";
import { TraceExplorer } from "@/components/dashboard/trace-explorer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import type { NoticeId, TraceDetailView } from "@/lib/dashboard/trace-detail-view";

const NOTICE_ICON: Record<NoticeId, LucideIcon> = {
  truncated: TriangleAlert,
  orphan: Unlink,
  cycle: Repeat,
  depth: Layers,
  duplicate: Files,
};

/**
 * The trace detail body: summary, notices, then the spans (waterfall or table). A server component; only the explorer and
 * the copy button are client code. Structure only: names, times, counts and cost, never any message text.
 */
export function TraceDetailPageView({ view, backHref }: { view: TraceDetailView; backHref: string }) {
  const s = view.summary;
  return (
    <div className="space-y-5">
      <Link href={backHref} className={buttonVariants({ variant: "outline", className: "h-11 px-4 sm:h-9" })}>
        Back to traces
      </Link>

      <div>
        <h2 className="text-xl font-semibold tracking-tight">Trace</h2>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="font-mono text-sm" title={s.traceId}>
            {s.shortId}
          </code>
          <span className="sr-only">Full trace id: {s.traceId}</span>
          <CopyButton value={s.traceId} label="Copy the full trace id" />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Times in UTC.</p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Started (UTC)">{s.started}</Stat>
        <Stat label="Duration">{s.duration}</Stat>
        <Stat label="Spans">{s.spans}</Stat>
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
      </dl>

      {view.notices.length > 0 ? (
        <div className="space-y-3" role="region" aria-label="Notices about this trace">
          {view.notices.map((n) => {
            const Icon = NOTICE_ICON[n.id];
            return (
              <Alert key={n.id}>
                <Icon className="text-status-warning" aria-hidden />
                <AlertTitle>{n.label}</AlertTitle>
                <AlertDescription>{n.detail}</AlertDescription>
              </Alert>
            );
          })}
        </div>
      ) : null}

      <TraceExplorer spans={view.spans} totalMs={view.totalMs} />
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
