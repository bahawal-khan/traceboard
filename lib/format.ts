/**
 * Display formatters for the dashboard. Pure and locale-independent, so the server and the browser render the same
 * text (no hydration drift).
 *
 * RULE: an unknown cost (model without a price) is `null` and renders as an em dash, NEVER as "$0.00".
 * A genuine zero cost renders as $0.00. The two must never be confused.
 */

export const UNKNOWN = "—"; // em dash
export const UNKNOWN_COST_TITLE = "Unknown: no price for this model";

function isNum(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Dollars. null/NaN -> em dash. Small non-zero amounts keep their significant digits instead of rounding to $0.00. */
export function formatCostUsd(usd: number | null | undefined): string {
  if (!isNum(usd)) return UNKNOWN;
  if (usd === 0) return "$0.00";
  const abs = Math.abs(usd);
  const sign = usd < 0 ? "-" : "";
  if (abs >= 1000) return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs >= 0.01) return `${sign}$${abs.toFixed(3)}`;
  if (abs >= 0.000001) return `${sign}$${abs.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `${sign}<$0.000001`;
}

/** Rollups store integer micro-USD. null (unknown) stays unknown. */
export function formatCostMicro(micro: number | null | undefined): string {
  return isNum(micro) ? formatCostUsd(micro / 1_000_000) : UNKNOWN;
}

/** 1,234 -> "1.2k", 1,500,000 -> "1.5M". Exact below 1,000. */
export function formatCompact(n: number | null | undefined): string {
  if (!isNum(n)) return UNKNOWN;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const v = abs / size;
      const txt = v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "");
      return `${sign}${txt}${suffix}`;
    }
  }
  return `${sign}${Math.round(abs)}`;
}

export function formatInt(n: number | null | undefined): string {
  return isNum(n) ? Math.round(n).toLocaleString("en-US") : UNKNOWN;
}

export function formatTokens(n: number | null | undefined): string {
  return formatCompact(n);
}

/** Milliseconds -> "850 ms", "1.2 s", "2m 05s". */
export function formatDuration(ms: number | null | undefined): string {
  if (!isNum(ms) || ms < 0) return UNKNOWN;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) {
    const s = (ms / 1000).toFixed(ms < 10_000 ? 2 : 1);
    return `${s.replace(/\.?0+$/, "")} s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Fraction (0..1) -> "12.5%". */
export function formatPercent(fraction: number | null | undefined, digits = 1): string {
  if (!isNum(fraction)) return UNKNOWN;
  const txt = (fraction * 100).toFixed(digits);
  return `${digits > 0 ? txt.replace(/\.?0+$/, "") : txt}%`;
}

/** UTC text for tooltips ("2026-11-21 14:05 UTC"). Deterministic, so it is safe to render on the server. */
export function formatUtc(date: Date | string | number | null | undefined): string {
  if (date === null || date === undefined) return UNKNOWN;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** UTC calendar date ("2026-11-21"): the same text on server and browser, unlike toLocaleDateString (hydration drift). */
export function formatUtcDate(date: Date | string | number | null | undefined): string {
  if (date === null || date === undefined) return UNKNOWN;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return d.toISOString().slice(0, 10);
}
