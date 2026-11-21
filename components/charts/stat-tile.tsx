import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface StatTileProps {
  label: string;
  /** Already formatted (use lib/format). Pass `null` when unknown: it renders a dash, never 0. */
  value: string | null;
  /** Small secondary line: unit, comparison, or "excludes unpriced models". */
  hint?: ReactNode;
  /** A sparkline or other small visual placed under the value. */
  visual?: ReactNode;
  loading?: boolean;
  className?: string;
}

/** A headline number. Not a chart: a single value reads faster as a tile. */
export function StatTile({ label, value, hint, visual, loading, className }: StatTileProps) {
  return (
    <Card size="sm" className={cn("min-w-0 gap-1", className)} aria-busy={loading || undefined}>
      <div className="px-(--card-spacing)">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        {loading ? (
          <Skeleton className="mt-1 h-8 w-24" />
        ) : (
          <p className="mt-0.5 truncate text-2xl font-semibold tabular-nums tracking-tight" title={value ?? "Unknown"}>
            {value ?? "—"}
          </p>
        )}
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {visual ? <div className="mt-1 h-10 min-w-0 px-(--card-spacing)">{visual}</div> : null}
    </Card>
  );
}
