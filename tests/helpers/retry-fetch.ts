/**
 * Test-only: retry a fetch that THROWS because the connection failed (undici
 * "fetch failed", ECONNRESET, ...). A response that arrives, including a SQL
 * error returned by the Neon HTTP endpoint (a 4xx/5xx with a JSON body), is
 * returned untouched and never retried. Use only for DB tests whose data is
 * keyed by unique ids; a lost response could in theory repeat a write.
 */
type FetchFn = (input: any, init?: any) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const CONNECTION_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false; // abort errors, programming errors: never retried
  const code = (err.cause as { code?: string } | undefined)?.code;
  return err.message === "fetch failed" || (code !== undefined && CONNECTION_CODES.has(code));
}

export interface RetryOptions {
  attempts?: number;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export function withConnectionRetry(fetchFn: FetchFn, opts: RetryOptions = {}): FetchFn {
  const attempts = opts.attempts ?? 3;
  const delays = opts.delaysMs ?? [250, 750];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (input, init) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetchFn(input, init);
      } catch (err) {
        if (attempt >= attempts || !isConnectionError(err)) throw err;
        await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);
      }
    }
  };
}
