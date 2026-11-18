import { json, readJson, sessionRoute } from "@/lib/http/api";
import { createProject, listProjects } from "@/lib/repo/projects";

export const GET = sessionRoute("projects.list", async ({ ctx, requestId }) =>
  json({ projects: await listProjects(ctx) }, 200, requestId),
);

export const POST = sessionRoute("projects.create", async ({ request, ctx, ip, requestId }) =>
  json({ project: await createProject(ctx, await readJson(request), ip) }, 201, requestId),
);
