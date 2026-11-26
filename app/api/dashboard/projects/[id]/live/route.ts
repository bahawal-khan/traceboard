import { sessionRoute } from "@/lib/http/api";
import { liveHandler } from "@/lib/http/live-route";

/** GET only. Never cached: every answer is per signed-in user and per cursor. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = sessionRoute<{ id: string }>("live.get", liveHandler);
