const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

export const REQUEST_ID_HEADER = "x-request-id";

export function newRequestId(): string {
  return crypto.randomUUID();
}

/** Accept a caller-supplied id only if it is short and log-safe; otherwise mint one. */
export function requestIdFrom(headers: Pick<Headers, "get">): string {
  const incoming = headers.get(REQUEST_ID_HEADER);
  return incoming && SAFE_ID.test(incoming) ? incoming : newRequestId();
}
