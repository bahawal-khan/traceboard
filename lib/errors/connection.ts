/**
 * Connection-level database failures versus SQL errors.
 *
 * The Neon HTTP driver throws a NeonDbError for BOTH. A connection failure (the HTTP request itself
 * failed, e.g. undici "fetch failed") carries `sourceError` and no SQLSTATE `code`; a SQL error
 * (permission denied, constraint, RLS) comes from a response and carries `code`. Only the former is
 * transient and safe to retry; never retry the latter.
 */
const SOCKET_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

export function isConnectionError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; message?: string; code?: unknown; sourceError?: unknown; cause?: { code?: string } };
  if (e.name === "NeonDbError") {
    if (typeof e.code === "string" && e.code !== "") return false; // SQLSTATE present: a real SQL error
    return e.sourceError !== undefined ? isConnectionError(e.sourceError) : false;
  }
  if (err instanceof TypeError) {
    const code = e.cause?.code;
    return e.message === "fetch failed" || (code !== undefined && SOCKET_CODES.has(code));
  }
  return false;
}

export interface RetryOptions {
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs `fn`; if it fails with a connection-level error, waits briefly and runs it ONCE more. A second
 * failure, and any SQL or other error, is surfaced unchanged. `fn` must be safe to call twice: if the
 * first request reached the server but the response was lost, the second repeats it.
 */
export async function retryOnConnectionError<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    await (opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(opts.delayMs ?? 300);
    return fn();
  }
}
