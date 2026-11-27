import Link from "next/link";
import { CircleAlert, CirclePause, RefreshCw } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { LIVE_BANNER_CARD_CLASS, LIVE_BANNER_OFFSET_CLASS, endedText, newEventsText, type BannerState } from "@/lib/dashboard/live-banner";

/**
 * The banner of live updates, presentation only (the behaviour is in components/dashboard/live-updates.tsx). It is a fixed overlay
 * at the bottom of the viewport, so showing or hiding it never moves the page the user is reading. The wrapper with aria-live is
 * always in the DOM (empty when there is nothing to say) because screen readers announce changes inside an existing live region.
 * It shows counts and fixed words only: no event content, ids or error text can reach it (its props cannot carry them).
 */
export function LiveBannerView({ state, onRefresh, onResume }: { state: BannerState; onRefresh?: () => void; onResume?: () => void }) {
  return (
    <div className={`pointer-events-none fixed inset-x-0 bottom-0 z-40 px-4 ${LIVE_BANNER_OFFSET_CLASS}`} role="status" aria-live="polite" data-live-banner={state.kind}>
      {state.kind === "none" ? null : (
        <div className={`pointer-events-auto mx-auto flex max-w-md min-w-0 items-center gap-3 rounded-lg border bg-card p-3 text-sm text-card-foreground shadow-lg ${LIVE_BANNER_CARD_CLASS}`}>
          {state.kind === "new" ? (
            <>
              <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 break-words line-clamp-3 font-medium">{newEventsText(state.events, state.errors, state.atLeast)}</span>
              <Button type="button" className="min-h-11 shrink-0 px-4 sm:min-h-9" onClick={onRefresh}>
                Refresh
              </Button>
            </>
          ) : state.kind === "paused" ? (
            <>
              <CirclePause aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 line-clamp-3 break-words text-muted-foreground">Live updates paused</span>
              <Button type="button" variant="outline" className="min-h-11 shrink-0 px-4 sm:min-h-9" onClick={onResume}>
                Resume
              </Button>
            </>
          ) : (
            <>
              <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 line-clamp-3 break-words text-muted-foreground">{endedText(state.reason)}</span>
              {state.reason === "session_ended" ? (
                <Link href="/sign-in" className={buttonVariants({ variant: "outline", className: "min-h-11 shrink-0 px-4 sm:min-h-9" })}>
                  Sign in
                </Link>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
