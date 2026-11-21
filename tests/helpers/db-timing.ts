/**
 * Test-only, opt-in (DB_TEST_TIMING=1): counts and times every HTTP request the Neon driver makes, so a slow DB test run can be
 * explained with numbers (how many round trips, how long each takes, which statements are slowest) instead of guesses.
 * It only OBSERVES: the request, the response and any error pass through untouched, no SQL text beyond a 60-character head of the
 * statement is kept, and parameters are never read. Wrapped BELOW the retry layer, so every attempt counts.
 */
type FetchFn = (input: any, init?: any) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface SlowRequest {
  ms: number;
  head: string;
}
export interface FetchStats {
  roundTrips: number;
  failures: number;
  totalMs: number;
  maxMs: number;
  slowest: SlowRequest[];
}

/** First 60 characters of the first statement in a Neon HTTP body (`{"query":"..."}` or `{"queries":[{"query":"..."}]}`). */
export function statementHead(body: unknown): string {
  if (typeof body !== "string") return "";
  const m = /"query":"((?:[^"\\]|\\.){0,60})/.exec(body.slice(0, 400));
  return m ? m[1]!.replace(/\\n/g, " ").replace(/\s+/g, " ").trim() : "";
}

export function createFetchTimer(now: () => number = () => performance.now()) {
  const stats: FetchStats = { roundTrips: 0, failures: 0, totalMs: 0, maxMs: 0, slowest: [] };
  const record = (ms: number, head: string) => {
    stats.roundTrips += 1;
    stats.totalMs += ms;
    stats.maxMs = Math.max(stats.maxMs, ms);
    stats.slowest.push({ ms, head });
    stats.slowest.sort((a, b) => b.ms - a.ms);
    if (stats.slowest.length > 3) stats.slowest.length = 3;
  };
  return {
    wrap(fetchFn: FetchFn): FetchFn {
      return async (input, init) => {
        const t0 = now();
        const head = statementHead(init?.body);
        try {
          return await fetchFn(input, init);
        } catch (err) {
          stats.failures += 1;
          throw err;
        } finally {
          record(now() - t0, head);
        }
      };
    },
    snapshot(): FetchStats {
      return { ...stats, slowest: stats.slowest.map((s) => ({ ...s })) };
    },
  };
}
