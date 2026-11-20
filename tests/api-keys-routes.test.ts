import { beforeEach, describe, expect, it, vi } from "vitest";
import { LimitReachedError, NotFoundError } from "@/lib/repo/errors";

const m = vi.hoisted(() => ({ ctxFromSession: vi.fn(), createApiKey: vi.fn(), listApiKeys: vi.fn(), revokeApiKey: vi.fn() }));
vi.mock("@/lib/repo/ctx", () => ({ ctxFromSession: m.ctxFromSession }));
vi.mock("@/lib/repo/api-keys", () => ({ createApiKey: m.createApiKey, listApiKeys: m.listApiKeys, revokeApiKey: m.revokeApiKey }));

import { GET as list, POST as create } from "@/app/api/dashboard/projects/[id]/keys/route";
import { DELETE as revoke } from "@/app/api/dashboard/projects/[id]/keys/[keyId]/route";

const ORIGIN = "https://app.example.com";
const PID = "11111111-1111-4111-8111-111111111111";
const KID = "22222222-2222-4222-8222-222222222222";
const SECRET = `lm_${"A".repeat(43)}`;
const meta = { id: KID, name: "production", prefix: "lm_AAAAA", scopes: ["ingest"], lastUsedAt: null, revokedAt: null, createdAt: "2026-11-20T00:00:00.000Z" };
const ctx = { kind: "session", ownerId: "user_a", projectIds: [], readOnly: false };
const p = (id = PID, keyId = KID) => ({ params: Promise.resolve({ id, keyId }) });
const req = (method: string, path: string, opts: { origin?: string | null; body?: unknown } = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: { ...(opts.origin === null ? {} : { origin: opts.origin ?? ORIGIN }), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
const base = `/api/dashboard/projects/${PID}/keys`;

beforeEach(() => {
  vi.clearAllMocks();
  m.ctxFromSession.mockResolvedValue(ctx);
});

describe("api key routes (mocked repo)", () => {
  it("401 without a session and the repo is never called", async () => {
    m.ctxFromSession.mockResolvedValue(null);
    const rs = await Promise.all([list(req("GET", base), p()), create(req("POST", base, { body: {} }), p()), revoke(req("DELETE", `${base}/${KID}`), p())]);
    for (const r of rs) expect(r.status).toBe(401);
    expect(m.createApiKey).not.toHaveBeenCalled();
    expect(m.revokeApiKey).not.toHaveBeenCalled();
  });

  it("403 for mutations without a same-origin Origin", async () => {
    for (const origin of [null, "https://evil.example.com"]) {
      expect((await create(req("POST", base, { origin, body: {} }), p())).status).toBe(403);
      expect((await revoke(req("DELETE", `${base}/${KID}`, { origin }), p())).status).toBe(403);
    }
    expect(m.createApiKey).not.toHaveBeenCalled();
    expect(m.revokeApiKey).not.toHaveBeenCalled();
  });

  it("create returns the secret exactly once, with no-store, and the list never does", async () => {
    m.createApiKey.mockResolvedValue({ key: meta, secret: SECRET });
    const c = await create(req("POST", base, { body: { scopes: ["ingest"] } }), p());
    expect(c.status).toBe(201);
    expect(c.headers.get("cache-control")).toBe("private, no-store");
    expect(await c.json()).toEqual({ key: meta, secret: SECRET });

    m.listApiKeys.mockResolvedValue([meta]);
    const l = await list(req("GET", base), p());
    const text = await l.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/secret|hash/i);
  });

  it("create passes the name through to the repo and returns it, secret unchanged", async () => {
    m.createApiKey.mockResolvedValue({ key: meta, secret: SECRET });
    const r = await create(req("POST", base, { body: { name: "production", scopes: ["ingest"] } }), p());
    expect(r.status).toBe(201);
    expect(m.createApiKey.mock.calls[0][2]).toEqual({ name: "production", scopes: ["ingest"] });
    const body = (await r.json()) as { key: { name: string }; secret: string };
    expect(body.key.name).toBe("production");
    expect(body.secret).toBe(SECRET);
  });

  it("a key name that looks like a secret is never echoed in an error response", async () => {
    m.createApiKey.mockRejectedValue(new Error(`insert failed for name ${SECRET}`));
    const r = await create(req("POST", base, { body: { name: SECRET } }), p());
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain(SECRET);
  });

  it("create accepts an empty body (default scope) and rejects malformed JSON", async () => {
    m.createApiKey.mockResolvedValue({ key: meta, secret: SECRET });
    expect((await create(new Request(`${ORIGIN}${base}`, { method: "POST", headers: { origin: ORIGIN } }), p())).status).toBe(201);
    expect(m.createApiKey.mock.calls[0][2]).toEqual({});
    const bad = new Request(`${ORIGIN}${base}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{oops" });
    expect((await create(bad, p())).status).toBe(400);
  });

  it("maps domain errors to generic responses", async () => {
    m.createApiKey.mockRejectedValue(new LimitReachedError("keys_per_project"));
    const lim = await create(req("POST", base, { body: {} }), p());
    expect(lim.status).toBe(403);
    expect(await lim.json()).toEqual({ error: "limit_reached", limit: "keys_per_project" });
    m.revokeApiKey.mockRejectedValue(new NotFoundError());
    const nf = await revoke(req("DELETE", `${base}/${KID}`), p());
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: "not_found" });
  });

  it("revoke passes both ids and the client ip, and reports ok", async () => {
    m.revokeApiKey.mockResolvedValue(undefined);
    const r = await revoke(
      new Request(`${ORIGIN}${base}/${KID}`, { method: "DELETE", headers: { origin: ORIGIN, "x-forwarded-for": "198.51.100.7" } }),
      p(),
    );
    expect(r.status).toBe(200);
    expect(m.revokeApiKey).toHaveBeenCalledWith(ctx, PID, KID, "198.51.100.7");
  });

  it("an unexpected failure never echoes the key", async () => {
    m.createApiKey.mockRejectedValue(new Error(`insert failed for ${SECRET}`));
    const r = await create(req("POST", base, { body: {} }), p());
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain(SECRET);
  });
});
