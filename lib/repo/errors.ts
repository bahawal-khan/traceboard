/** Domain errors thrown by repo functions; routes map them to generic HTTP responses. */
export class NotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "NotFoundError";
  }
}

export class LimitReachedError extends Error {
  constructor(public readonly limit: string) {
    super(`limit reached: ${limit}`);
    this.name = "LimitReachedError";
  }
}
