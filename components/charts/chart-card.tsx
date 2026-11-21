import type { ReactNode } from "react";
import { AlertTriangle, BarChart3 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type ChartCardState = "ready" | "loading" | "empty" | "error";

export interface ChartCardProps {
  title: string;
  description?: string;
  /** Rendered in the header's right corner (range picker, legend toggle, ...). */
  action?: ReactNode;
  state?: ChartCardState;
  /** Text under the icon in the empty state. Say what to do, not just "no data". */
  emptyMessage?: string;
  /** Extra content under the empty message, for example the SDK snippet link. */
  emptyAction?: ReactNode;
  errorMessage?: string;
  /** Height of the plot area; the same box is used for every state so the page does not jump. */
  heightClass?: string;
  /** Accessible table view of the same numbers (collapsed by default). Required by the chart accessibility rules. */
  table?: ReactNode;
  /** Small print under the plot, for example "p50/p95 are approximate". */
  footnote?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/**
 * The one frame every chart lives in: title, loading skeleton, empty state, error state, table fallback.
 * Server-component safe (no hooks). The plot itself is a client component passed as `children`.
 */
export function ChartCard({
  title,
  description,
  action,
  state = "ready",
  emptyMessage = "No data in this time range yet.",
  emptyAction,
  errorMessage = "This chart could not be loaded. Try again in a moment.",
  heightClass = "h-56 sm:h-64",
  table,
  footnote,
  className,
  children,
}: ChartCardProps) {
  return (
    <Card className={cn("min-w-0", className)} aria-busy={state === "loading"}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate">{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      </CardHeader>
      <CardContent className="min-w-0">
        <div className={cn("w-full min-w-0", heightClass)}>
          {state === "loading" ? (
            <div role="status" aria-label={`Loading ${title}`} className="flex h-full flex-col justify-end gap-2">
              <Skeleton className="h-full w-full" />
              <span className="sr-only">Loading</span>
            </div>
          ) : state === "empty" ? (
            <Placeholder icon={<BarChart3 className="size-6" aria-hidden />} message={emptyMessage}>
              {emptyAction}
            </Placeholder>
          ) : state === "error" ? (
            <Placeholder icon={<AlertTriangle className="size-6 text-status-critical" aria-hidden />} message={errorMessage} role="alert" />
          ) : (
            children
          )}
        </div>
        {state === "ready" && table ? (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">View as table</summary>
            <div className="mt-2 max-h-64 overflow-auto">{table}</div>
          </details>
        ) : null}
        {state === "ready" && footnote ? <p className="mt-2 text-xs text-muted-foreground">{footnote}</p> : null}
      </CardContent>
    </Card>
  );
}

function Placeholder({
  icon,
  message,
  children,
  role,
}: {
  icon: ReactNode;
  message: string;
  children?: ReactNode;
  role?: "alert";
}) {
  return (
    <div
      role={role}
      className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 text-center text-muted-foreground"
    >
      {icon}
      <p className="max-w-xs text-sm">{message}</p>
      {children}
    </div>
  );
}
