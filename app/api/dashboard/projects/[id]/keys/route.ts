import { json, readJson, sessionRoute } from "@/lib/http/api";
import { createApiKey, listApiKeys } from "@/lib/repo/api-keys";

type P = { id: string };

export const GET = sessionRoute<P>("keys.list", async ({ ctx, params, requestId }) =>
  json({ keys: await listApiKeys(ctx, params.id) }, 200, requestId),
);

/** The only response that ever contains a raw key. */
export const POST = sessionRoute<P>("keys.create", async ({ request, ctx, params, ip, requestId }) => {
  const body = await readJson(request, { optional: true });
  const created = await createApiKey(ctx, params.id, body, ip);
  return json({ key: created.key, secret: created.secret }, 201, requestId);
});
