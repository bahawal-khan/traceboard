import { NeonDbError } from "@neondatabase/serverless";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isConnectionError, retryOnConnectionError } from "@/lib/errors/connection";

/** What the driver throws when the HTTP request itself fails. */
function connectionFailure() {
  const e = new NeonDbError("Error connecting to database: TypeError: fetch failed");
  e.sourceError = new TypeError("fetch failed");
  return e;
}
/** What the driver throws for a SQL error returned by the server. */
function sqlFailure(code = "42501") {
  const e = new NeonDbError("permission denied for table x");
  e.code = code;
  return e;
}

describe("isConnectionError", () => {
  it("is true for fetch failed, wrapped or bare, and socket errors", () => {
    expect(isConnectionError(connectionFailure())).toBe(true);
    expect(isConnectionError(new TypeError("fetch failed"))).toBe(true);
    expect(isConnectionError(new TypeError("x", { cause: { code: "ECONNRESET" } }))).toBe(true);
  });
  it("is false for SQL errors, other errors and non-errors", () => {
    for (const code of ["42501", "23505", "42P01", "57014"]) expect(isConnectionError(sqlFailure(code))).toBe(false);
    for (const v of [new Error("fetch failed"), new TypeError("Invalid URL"), new NeonDbError("Neon internal error: unexpected result format"), null, undefined, "fetch failed", 5]) {
      expect(isConnectionError(v)).toBe(false);
    }
    const bad = new NeonDbError("x");
    bad.sourceError = new Error("boom");
    expect(isConnectionError(bad)).toBe(false);
  });
  it("a SQL error that also carries a source error is still a SQL error", () => {
    const e = sqlFailure();
    e.sourceError = new TypeError("fetch failed");
    expect(isConnectionError(e)).toBe(false);
  });
});

describe("retryOnConnectionError", () => {
  const sleep = vi.fn(async () => {});
  beforeEach(() => {
    sleep.mockClear();
  });

  it("retries a connection failure exactly once, after about 300 ms, and returns the second result", async () => {
    const fn = vi.fn().mockRejectedValueOnce(connectionFailure()).mockResolvedValueOnce("ok");
    expect(await retryOnConnectionError(fn, { sleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(300);
  });

  it("does not retry a SQL error", async () => {
    const err = sqlFailure();
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryOnConnectionError(fn, { sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("surfaces the second failure and never retries a third time", async () => {
    const second = connectionFailure();
    const fn = vi.fn().mockRejectedValueOnce(connectionFailure()).mockRejectedValueOnce(second);
    await expect(retryOnConnectionError(fn, { sleep })).rejects.toBe(second);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-connection errors, and a SQL error on the retry is surfaced", async () => {
    const boom = new Error("boom");
    const f1 = vi.fn().mockRejectedValue(boom);
    await expect(retryOnConnectionError(f1, { sleep })).rejects.toBe(boom);
    expect(f1).toHaveBeenCalledTimes(1);
    const sqlErr = sqlFailure();
    const f2 = vi.fn().mockRejectedValueOnce(connectionFailure()).mockRejectedValueOnce(sqlErr);
    await expect(retryOnConnectionError(f2, { sleep })).rejects.toBe(sqlErr);
    expect(f2).toHaveBeenCalledTimes(2);
  });

  it("does not sleep or retry on success", async () => {
    const fn = vi.fn().mockResolvedValue(1);
    expect(await retryOnConnectionError(fn, { sleep })).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

// The same behaviour where it is wired in: runScoped and ensureSignedInUserSlot, with the driver mocked.
const m = vi.hoisted(() => ({ transaction: vi.fn(), tag: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  getSql: () => Object.assign((...args: unknown[]) => m.tag(...args), { transaction: m.transaction }),
}));
vi.mock("@clerk/nextjs/server", () => ({ auth: m.auth }));

import { runScoped } from "@/lib/repo/tenant";
import { ensureSignedInUserSlot } from "@/lib/repo/users";

describe("runScoped retry (mocked driver)", () => {
  beforeEach(() => {
    m.transaction.mockReset(); // braces: a returned function would be run by Vitest as a teardown
  });
  const scope = { ownerId: "user_a", projectIds: [] as string[], readOnly: false };

  it("retries a connection failure once and returns the results without the set_config row", async () => {
    m.transaction.mockRejectedValueOnce(connectionFailure()).mockResolvedValueOnce([[{ x: 1 }], [{ ok: true }]]);
    expect(await runScoped(scope, () => [])).toEqual([[{ ok: true }]]);
    expect(m.transaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry a SQL error", async () => {
    const err = sqlFailure("42501");
    m.transaction.mockRejectedValue(err);
    await expect(runScoped(scope, () => [])).rejects.toBe(err);
    expect(m.transaction).toHaveBeenCalledTimes(1);
  });

  it("surfaces a second connection failure after exactly two attempts", async () => {
    const second = connectionFailure();
    m.transaction.mockRejectedValueOnce(connectionFailure()).mockRejectedValueOnce(second);
    await expect(runScoped(scope, () => [])).rejects.toBe(second);
    expect(m.transaction).toHaveBeenCalledTimes(2);
  });
});

describe("ensureSignedInUserSlot retry (mocked driver)", () => {
  beforeEach(() => {
    m.tag.mockReset();
    m.auth.mockResolvedValue({ userId: "user_a" });
  });

  it("retries a connection failure once", async () => {
    m.tag.mockRejectedValueOnce(connectionFailure()).mockResolvedValueOnce([{ status: "created" }]);
    expect(await ensureSignedInUserSlot()).toBe("created");
    expect(m.tag).toHaveBeenCalledTimes(2);
  });

  it("does not retry a SQL error, and surfaces a second connection failure", async () => {
    const sqlErr = sqlFailure("P0001");
    m.tag.mockRejectedValueOnce(sqlErr);
    await expect(ensureSignedInUserSlot()).rejects.toBe(sqlErr);
    expect(m.tag).toHaveBeenCalledTimes(1);

    m.tag.mockReset();
    const second = connectionFailure();
    m.tag.mockRejectedValueOnce(connectionFailure()).mockRejectedValueOnce(second);
    await expect(ensureSignedInUserSlot()).rejects.toBe(second);
    expect(m.tag).toHaveBeenCalledTimes(2);
  });

  it("returns signed_out without touching the database", async () => {
    m.auth.mockResolvedValue({ userId: null });
    expect(await ensureSignedInUserSlot()).toBe("signed_out");
    expect(m.tag).not.toHaveBeenCalled();
  });
});
