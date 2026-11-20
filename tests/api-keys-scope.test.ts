import { describe, expect, it } from "vitest";
import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/repo/api-keys";
import { NotFoundError } from "@/lib/repo/errors";
import { issueCtx, type SessionCtx } from "@/lib/repo/tenant";

const PID = "11111111-1111-4111-8111-111111111111";
const KID = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

/** No database: the scope guard runs before any query. */
describe("project-scoped key functions require the project to be in the context's scope", () => {
  const empty = issueCtx<SessionCtx>({ kind: "session", ownerId: "user_a", projectIds: [], readOnly: false });
  const other = issueCtx<SessionCtx>({ kind: "session", ownerId: "user_a", projectIds: [OTHER], readOnly: false });

  it("a context built before the project existed (or for someone else's project) gets not found", async () => {
    for (const ctx of [empty, other]) {
      await expect(createApiKey(ctx, PID, {})).rejects.toBeInstanceOf(NotFoundError);
      await expect(listApiKeys(ctx, PID)).rejects.toBeInstanceOf(NotFoundError);
      await expect(revokeApiKey(ctx, PID, KID)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("still validates input before the scope check", async () => {
    await expect(createApiKey(empty, "not-a-uuid", {})).rejects.not.toBeInstanceOf(NotFoundError);
    await expect(createApiKey(empty, PID, { scopes: ["admin"] })).rejects.not.toBeInstanceOf(NotFoundError);
  });
});
