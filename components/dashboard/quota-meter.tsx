import { StatusBadge } from "@/components/charts/status-badge";
import { Card } from "@/components/ui/card";
import { quotaLevel } from "@/lib/dashboard/quota-banner";
import { formatInt } from "@/lib/format";

/**
 * Today's events against the daily quota. Warns at 80% and says so at 100%, because a project over its quota gets 429s
 * and the SDK stops delivering until UTC midnight. Status is an icon plus words, never colour alone.
 */
export function QuotaMeter({ used, limit }: { used: number; limit: number }) {
  const ratio = limit > 0 ? used / limit : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
  const level = quotaLevel(used, limit); // same thresholds as the banner
  const status = level === "reached" ? ("critical" as const) : level === "near" ? ("warning" as const) : ("good" as const);
  const label = status === "critical" ? "Quota reached: new events are refused until 00:00 UTC" : status === "warning" ? "Approaching today's quota" : "Within today's quota";
  const bar = status === "critical" ? "bg-status-critical" : status === "warning" ? "bg-status-warning" : "bg-chart-1";

  return (
    <Card size="sm" className="min-w-0 gap-2">
      <div className="flex items-baseline justify-between gap-3 px-(--card-spacing)">
        <p className="text-xs text-muted-foreground">Events today (UTC)</p>
        <p className="text-sm font-medium tabular-nums">
          {formatInt(used)} <span className="text-muted-foreground">of {formatInt(limit)}</span>
        </p>
      </div>
      <div className="px-(--card-spacing)">
        <div
          role="progressbar"
          aria-label="Events used today"
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(used, limit)}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2">
          <StatusBadge status={status} label={label} />
        </div>
      </div>
    </Card>
  );
}
