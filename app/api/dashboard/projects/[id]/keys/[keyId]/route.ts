import { json, sessionRoute } from "@/lib/http/api";
import { revokeApiKey } from "@/lib/repo/api-keys";

type P = { id: string; keyId: string };

export const DELETE = sessionRoute<P>("keys.revoke", async ({ ctx, params, ip, requestId }) => {
  await revokeApiKey(ctx, params.id, params.keyId, ip);
  return json({ ok: true }, 200, requestId);
});
