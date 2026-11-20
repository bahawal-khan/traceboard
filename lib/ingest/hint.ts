import { FLUSH_HINT_MS } from "@/lib/quotas";

export interface FlushSignals {
  lastViewedAt: Date | null;
  conserve: boolean;
}

/**
 * The SDK's next flush interval. Conserve mode wins (protects the free-tier compute); a project that is
 * being watched right now gets 1 s; everything else gets 10-15 s, jittered so many SDKs do not flush in
 * lockstep. `signals` is null when no database write happened (nothing to learn from), which is idle.
 */
export function flushHintMs(signals: FlushSignals | null, now: number, random: () => number = Math.random): number {
  if (signals?.conserve) return FLUSH_HINT_MS.conserve;
  if (signals?.lastViewedAt && now - signals.lastViewedAt.getTime() < FLUSH_HINT_MS.liveWindow) return FLUSH_HINT_MS.live;
  return Math.round(FLUSH_HINT_MS.idleMin + random() * (FLUSH_HINT_MS.idleMax - FLUSH_HINT_MS.idleMin));
}
