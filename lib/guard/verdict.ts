import type { BudgetUsageRow } from "@/lib/events/store";

/**
 * Server-side verdict from the budgets a write touched (docs/ARCHITECTURE.md section 2). Phase 2 only
 * passes the facts through; the alerts, the kill switch and the SDK reaction arrive in Phase 4.
 * Note: a batch of pure duplicates touches no budget, so it returns "ok" even for a project that is over
 * budget. P4 must therefore keep the last non-ok verdict per project instead of trusting a single response.
 */
export interface GuardVerdict {
  status: "ok" | "alert" | "block";
  exceeded: Array<{
    budget_id: string;
    scope: string;
    period: string;
    period_key: string;
    action: string;
    limit_micro: number;
    spent_micro: number;
  }>;
}

/** "5", "0.25", "5.000000" -> integer micro-USD; null when it is not a usable positive number. */
export function usdTextToMicro(text: string): number | null {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : null;
}

export function budgetVerdict(rows: readonly BudgetUsageRow[]): GuardVerdict {
  const exceeded: GuardVerdict["exceeded"] = [];
  for (const r of rows) {
    const limit = usdTextToMicro(r.limitUsd);
    if (limit === null || r.spentMicro < limit) continue;
    exceeded.push({ budget_id: r.budgetId, scope: r.scope, period: r.period, period_key: r.periodKey, action: r.action, limit_micro: limit, spent_micro: r.spentMicro });
  }
  const status = exceeded.some((e) => e.action === "block") ? "block" : exceeded.length > 0 ? "alert" : "ok";
  return { status, exceeded };
}
