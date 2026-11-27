import { formatInt } from "@/lib/format";

/**
 * The daily event quota notice (pure; no I/O). One place for the thresholds so the meter and the banner always agree.
 * Input is today's (UTC) events and the daily limit. NULL OR NOT A NUMBER IS UNKNOWN, never zero: unknown shows no banner
 * (a banner built on a guess would be an invented number).
 */
export const QUOTA_WARN_RATIO = 0.8;

export type QuotaLevel = "ok" | "near" | "reached" | "unknown";

export function quotaLevel(used: number | null | undefined, limit: number | null | undefined): QuotaLevel {
  if (typeof used !== "number" || typeof limit !== "number") return "unknown";
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used < 0 || limit <= 0) return "unknown";
  const ratio = used / limit;
  return ratio >= 1 ? "reached" : ratio >= QUOTA_WARN_RATIO ? "near" : "ok";
}

export interface QuotaBannerText {
  level: "near" | "reached";
  title: string;
  body: string;
}

/** Text for the banner, or null when there is nothing to say (ok or unknown). Neutral wording, no internals. */
export function quotaBanner(used: number | null | undefined, limit: number | null | undefined): QuotaBannerText | null {
  const level = quotaLevel(used, limit);
  if (level !== "near" && level !== "reached") return null;
  const u = formatInt(used as number);
  const l = formatInt(limit as number);
  return level === "reached"
    ? { level, title: "Today's event limit is reached", body: `${u} of ${l} events used today (UTC). New events are refused until 00:00 UTC. Events already stored are not affected.` }
    : { level, title: "Close to today's event limit", body: `${u} of ${l} events used today (UTC). Once the limit is reached, new events are refused until 00:00 UTC.` };
}
