import { beforeEach, describe, expect, it, vi } from "vitest";
import { LimitReachedError, NotFoundError } from "@/lib/repo/errors";

const m = vi.hoisted(() => ({
  ctxFromSession: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  createProject: vi.fn(),
  renameProject: vi.fn(),
  deleteProject: vi.fn(),
}));
vi.mock("@/lib/repo/ctx", () => ({ ctxFromSession: m.ctxFromSession }));
vi.mock("@/lib/repo/projects", () => ({
  listProjects: m.listProjects,
  getProject: m.getProject,
  createProject: m.createProject,
  renameProject: m.renameProject,
  deleteProject: m.deleteProject,
}));

import { GET as list, POST as create } from "@/app/api/dashboard/projects/route";
import { DELETE as del, GET as get, PATCH as rename } from "@/app/api/dashboard/projects/[id]/route";

const ORIGIN = "https://app.example.com";
const PID = "11111111-1111-4111-8111-111111111111";
const ctx = { kind: "session", ownerId: "user_a", projectIds: [], readOnly: false };
const params = (id = PID) => ({ params: Promise.resolve({ id }) });
const req = (method: string, path: string, opts: { origin?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(opts.origin === null ? {} : { origin: opts.origin ?? ORIGIN }),
      ...(opts.body !== undefined || opts.raw !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.ctxFromSession.mockResolvedValue(ctx);
});

describe("dashboard project routes (mocked repo)", () => {
  it("401 without a session, for every method, and never calls the repo", async () => {
    m.ctxFromSession.mockResolvedValue(null);
    const rs = await Promise.all([
      list(req("GET", "/api/dashboard/projects")),
      create(req("POST", "/api/dashboard/projects", { body: { name: "x" } })),
      get(req("GET", `/api/dashboard/projects/${PID}`), params()),
      rename(req("PATCH", `/api/dashboard/projects/${PID}`, { body: { name: "x" } }), params()),
      del(req("DELETE", `/api/dashboard/projects/${PID}`), params()),
    ]);
    for (const r of rs) expect(r.status).toBe(401);
    for (const fn of [m.listProjects, m.getProject, m.createProject, m.renameProject, m.deleteProject]) expect(fn).not.toHaveBeenCalled();
  });

  it("403 for mutations with a missing, foreign or malformed Origin; GET needs none", async () => {
    for (const origin of [null, "https://evil.example.com", "null", "not a url"]) {
      const rs = await Promise.all([
        create(req("POST", "/api/dashboard/projects", { origin, body: { name: "x" } })),
        rename(req("PATCH", `/api/dashboard/projects/${PID}`, { origin, body: { name: "x" } }), params()),
        del(req("DELETE", `/api/dashboard/projects/${PID}`, { origin }), params()),
      ]);
      for (const r of rs) expect(r.status, String(origin)).toBe(403);
    }
    expect(m.createProject).not.toHaveBeenCalled();
    expect(m.deleteProject).not.toHaveBeenCalled();
    m.listProjects.mockResolvedValue([]);
    expect((await list(req("GET", "/api/dashboard/projects", { origin: null }))).status).toBe(200);
  });

  it("returns private no-store responses with a request id", async () => {
    m.listProjects.mockResolvedValue([]);
    const r = await list(req("GET", "/api/dashboard/projects", { headers: { "x-request-id": "req-12345678" } }));
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("x-request-id")).toBe("req-12345678");
  });

  it("create: 201 with the project, passes the parsed body and a valid client ip", async () => {
    m.createProject.mockResolvedValue({ id: PID, name: "My app" });
    const r = await create(req("POST", "/api/dashboard/projects", { body: { name: "My app" }, headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } }));
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ project: { id: PID, name: "My app" } });
    expect(m.createProject).toHaveBeenCalledWith(ctx, { name: "My app" }, "203.0.113.9");
  });

  it("ignores an invalid x-forwarded-for value", async () => {
    m.createProject.mockResolvedValue({});
    await create(req("POST", "/api/dashboard/projects", { body: { name: "a" }, headers: { "x-forwarded-for": "<script>" } }));
    expect(m.createProject.mock.calls[0][2]).toBeNull();
  });

  it("400 for malformed or oversized JSON, 422 for schema errors (generic body)", async () => {
    m.createProject.mockImplementation(async (_c: unknown, input: unknown) => {
      const { createProjectInput } = await import("@/lib/validation/projects");
      return createProjectInput.parse(input);
    });
    expect((await create(req("POST", "/api/dashboard/projects", { raw: "{not json" }))).status).toBe(400);
    expect((await create(req("POST", "/api/dashboard/projects", { raw: JSON.stringify({ name: "x".repeat(9000) }) }))).status).toBe(400);
    for (const body of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(61) }, { name: "a\u0000b" }, { name: "ok", extra: 1 }, { name: 5 }]) {
      const r = await create(req("POST", "/api/dashboard/projects", { body }));
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(await r.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("maps NotFoundError to 404 and LimitReachedError to 403 without leaking details", async () => {
    m.getProject.mockRejectedValue(new NotFoundError());
    const nf = await get(req("GET", `/api/dashboard/projects/${PID}`), params());
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: "not_found" });
    m.createProject.mockRejectedValue(new LimitReachedError("projects_per_user"));
    const lim = await create(req("POST", "/api/dashboard/projects", { body: { name: "x" } }));
    expect(lim.status).toBe(403);
    expect(await lim.json()).toEqual({ error: "limit_reached", limit: "projects_per_user" });
  });

  it("unexpected errors give a generic 500 that never echoes the cause", async () => {
    m.listProjects.mockRejectedValue(new Error("connect postgres://user:secretpw@host/db failed"));
    const r = await list(req("GET", "/api/dashboard/projects"));
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).not.toContain("secretpw");
    expect(text).not.toContain("postgres");
    expect(JSON.parse(text).error).toBe("internal");
  });

  it("422 for a non-uuid project id", async () => {
    const { projectId } = await import("@/lib/validation/projects");
    m.getProject.mockImplementation(async (_c: unknown, id: string) => projectId.parse(id));
    const r = await get(req("GET", "/api/dashboard/projects/not-a-uuid"), params("not-a-uuid"));
    expect(r.status).toBe(422);
  });
});
