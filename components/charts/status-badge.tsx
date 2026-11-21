import { AlertOctagon, AlertTriangle, CheckCircle2, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export type Status = "good" | "warning" | "serious" | "critical";

const META = {
  good: { Icon: CheckCircle2, color: "text-status-good" },
  warning: { Icon: AlertTriangle, color: "text-status-warning" },
  serious: { Icon: CircleAlert, color: "text-status-serious" },
  critical: { Icon: AlertOctagon, color: "text-status-critical" },
} as const;

/** Status is never colour alone: icon + visible label. Text stays in the foreground colour. */
export function StatusBadge({ status, label, className }: { status: Status; label: string; className?: string }) {
  const { Icon, color } = META[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", className)}>
      <Icon className={cn("size-4 shrink-0", color)} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
