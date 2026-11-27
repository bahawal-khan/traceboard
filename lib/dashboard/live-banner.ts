import { formatInt } from "@/lib/format";
import type { LiveEndReason, LiveSnapshot } from "@/lib/dashboard/live-poller";

/**
 * What the live banner shows. Built only from the poller's snapshot, which holds counts and a status and nothing else, so the
 * banner can never show event content, ids or error text. Pure: tested without React.
 */
export type BannerState =
  | { kind: "none" }
  | { kind: "new"; events: number; errors: number; atLeast: boolean }
  | { kind: "paused" }
  | { kind: "ended"; reason: LiveEndReason };

export function bannerState(s: LiveSnapshot): BannerState {
  if (s.status === "ended") return { kind: "ended", reason: s.endReason ?? "not_found" };
  if (s.newEvents > 0) return { kind: "new", events: s.newEvents, errors: s.newErrors, atLeast: s.atLeast };
  if (s.status === "paused") return { kind: "paused" };
  return { kind: "none" };
}

/** "12 new events (2 errors)", "1 new event", "At least 1,000 new events (at least 3 errors)". Counts only. */
export function newEventsText(events: number, errors: number, atLeast: boolean): string {
  const ev = `${formatInt(events)} new ${events === 1 ? "event" : "events"}`;
  const err = errors > 0 ? ` (${atLeast ? "at least " : ""}${formatInt(errors)} ${errors === 1 ? "error" : "errors"})` : "";
  return atLeast ? `At least ${ev}${err}` : `${ev}${err}`;
}

export function endedText(reason: LiveEndReason): string {
  return reason === "session_ended" ? "Live updates stopped: your session ended." : "Live updates stopped: this project is no longer available.";
}

/**
 * ONE place for the banner's footprint, so the overlay and the room reserved for it cannot drift apart.
 * The banner is a fixed card at the bottom: its offset from the viewport edge is LIVE_BANNER_INSET (a home bar on phones counts),
 * the card is at most LIVE_BANNER_CARD_MAX_REM tall (max-h-24 below = 6rem, text clamped to 3 lines), and the page content keeps
 * LIVE_BANNER_GAP_REM of air above it. The project frame reserves inset + card + gap PERMANENTLY (banner shown or not), so the
 * last content can always scroll clear of the banner and nothing moves when the banner appears.
 * The class strings are literals on purpose (Tailwind only sees complete class names); tests/live-banner.test.ts ties them to the numbers.
 */
export const LIVE_BANNER_INSET = "max(1rem,env(safe-area-inset-bottom))";
export const LIVE_BANNER_CARD_MAX_REM = 6;
export const LIVE_BANNER_GAP_REM = 1;
/** Bottom padding of the banner's own fixed wrapper (its offset from the viewport edge). */
export const LIVE_BANNER_OFFSET_CLASS = "pb-[max(1rem,env(safe-area-inset-bottom))]";
/** Max height of the banner card (6rem). */
export const LIVE_BANNER_CARD_CLASS = "max-h-24 overflow-hidden";
/** Permanent bottom padding of the project frame content: inset + card (6rem) + gap (1rem). */
export const LIVE_BANNER_RESERVE_CLASS = "pb-[calc(max(1rem,env(safe-area-inset-bottom))+7rem)]";

/** Live updates run on every project page except the API keys page (nothing to refresh there). */
export function liveEnabledForPath(pathname: string | null): boolean {
  if (!pathname) return false;
  const seg = pathname.split("/");
  // ["", "dashboard", "projects", "<id>", ...rest]
  return seg[1] === "dashboard" && seg[2] === "projects" && seg.length >= 4 && seg[4] !== "keys";
}
