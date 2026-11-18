import { describe, expect, it, vi } from "vitest";
import { isConnectionError, withConnectionRetry } from "@/tests/helpers/retry-fetch";

const fetchFailed = () => new TypeError("fetch failed");
const noSleep = vi.fn(async () => {});

describe("withConnectionRetry (db test helper)", () => {
  it("retries a connection failure and returns the eventual response", async () => {
    const ok = { status: 200 };
    const f = vi.fn().mockRejectedValueOnce(fetchFailed()).mockRejectedValueOnce(fetchFailed()).mockResolvedValueOnce(ok);
    const res = await withConnectionRetry(f, { sleep: noSleep })("u");
    expect(res).toBe(ok);
    expect(f).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 attempts and rethrows the connection error", async () => {
    const f = vi.fn().mockRejectedValue(fetchFailed());
    await expect(withConnectionRetry(f, { sleep: noSleep })("u")).rejects.toThrow("fetch failed");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("never retries a response that arrived, even a SQL error status", async () => {
    const sqlError = { status: 400, ok: false };
    const f = vi.fn().mockResolvedValue(sqlError);
    expect(await withConnectionRetry(f, { sleep: noSleep })("u")).toBe(sqlError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("never retries non-connection errors", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    for (const err of [abort, new Error("boom"), new TypeError("Invalid URL")]) {
      const f = vi.fn().mockRejectedValue(err);
      await expect(withConnectionRetry(f, { sleep: noSleep })("u")).rejects.toBe(err);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("recognises socket-level causes", () => {
    const e = new TypeError("something", { cause: { code: "ECONNRESET" } });
    expect(isConnectionError(e)).toBe(true);
    expect(isConnectionError(new TypeError("x", { cause: { code: "EACCES" } }))).toBe(false);
    expect(isConnectionError("fetch failed")).toBe(false);
  });
});
