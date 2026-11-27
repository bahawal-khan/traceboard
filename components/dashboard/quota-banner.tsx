import { OctagonAlert, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { quotaBanner } from "@/lib/dashboard/quota-banner";

/**
 * Notice above the Overview numbers when today's events are near or at the daily limit. An icon AND words (never colour
 * alone); a polite status, not an alert that interrupts. Renders nothing when the numbers are fine or unknown.
 */
export function QuotaBanner({ used, limit }: { used: number | null | undefined; limit: number | null | undefined }) {
  const b = quotaBanner(used, limit);
  if (!b) return null;
  const Icon = b.level === "reached" ? OctagonAlert : TriangleAlert;
  return (
    <Alert role="status" data-quota-level={b.level}>
      <Icon className={b.level === "reached" ? "text-status-critical" : "text-status-warning"} aria-hidden />
      <AlertTitle>{b.title}</AlertTitle>
      <AlertDescription>{b.body}</AlertDescription>
    </Alert>
  );
}
