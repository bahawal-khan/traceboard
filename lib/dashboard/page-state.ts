import { overviewRangeSchema, type OverviewData, type OverviewRange } from "./types";

/**
 * The pure decisions of the Overview pages (signed-in and demo), kept out of the pages so they are unit tested and
 * cannot drift between the two.
 */

export const DEFAULT_RANGE: OverviewRange = "24h";

/**
 * `?range=` is user input. Exactly "24h" or "7d" is accepted; anything else (wrong case, spaces, a list, an empty value,
 * a missing one) falls back to the default instead of failing or widening the window. A repeated parameter uses its
 * first value, like the rest of the platform.
 */
export function parseRangeParam(value: string | string[] | undefined): OverviewRange {
  const first = Array.isArray(value) ? value[0] : value;
  const parsed = overviewRangeSchema.safeParse(first);
  return parsed.success ? parsed.data : DEFAULT_RANGE;
}

export type OverviewState = "empty" | "ready";

/**
 * "empty" = no events at all in the selected window: the page shows the quickstart, not charts of zeros that would look
 * like data. (A window with events but, say, no priced model is "ready": its cost is flagged, not hidden.)
 */
export function overviewState(data: Pick<OverviewData, "totals">): OverviewState {
  return data.totals.calls === 0 ? "empty" : "ready";
}
