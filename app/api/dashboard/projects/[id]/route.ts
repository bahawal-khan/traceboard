import { json, readJson, sessionRoute } from "@/lib/http/api";
import { deleteProject, getProject, renameProject } from "@/lib/repo/projects";

type P = { id: string };

export const GET = sessionRoute<P>("projects.get", async ({ ctx, params, requestId }) =>
  json({ project: await getProject(ctx, params.id) }, 200, requestId),
);

export const PATCH = sessionRoute<P>("projects.rename", async ({ request, ctx, params, requestId }) =>
  json({ project: await renameProject(ctx, params.id, await readJson(request)) }, 200, requestId),
);

export const DELETE = sessionRoute<P>("projects.delete", async ({ ctx, params, ip, requestId }) => {
  await deleteProject(ctx, params.id, ip);
  return json({ ok: true }, 200, requestId);
});
