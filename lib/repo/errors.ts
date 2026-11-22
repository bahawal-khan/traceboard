/** Domain errors thrown by repo functions; routes map them to generic HTTP responses. */
export class NotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "NotFoundError";
  }
}

/**
 * True for every way a project page can be "not found": the repo's NotFoundError (foreign, missing, deleted) and the
 * validation error of a malformed id. All of them must render the SAME page, so a visitor cannot tell them apart.
 * Connection failures and every other error are NOT not-found: they propagate to the error boundary
 * ("could not reach the database", with retry, no details).
 */
export function isNotFoundLike(err: unknown): boolean {
  if (err instanceof NotFoundError) return true;
  return err instanceof Error && err.name === "ZodError";
}

export class LimitReachedError extends Error {
  constructor(public readonly limit: string) {
    super(`limit reached: ${limit}`);
    this.name = "LimitReachedError";
  }
}

/**
 * A pagination cursor that is not one this server issued (malformed, truncated, edited). Carries no detail on purpose:
 * routes answer a generic 400 and pages fall back to the first page. Never contains database text.
 */
export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "InvalidCursorError";
  }
}
