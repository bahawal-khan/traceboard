import { REQUEST_ID_HEADER } from "@/lib/request-id";

/** JSON response that is never cached by a shared cache (tenant data / per-caller answers). */
export function json(body: unknown, status: number, requestId?: string, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders, ...(requestId ? { [REQUEST_ID_HEADER]: requestId } : {}) },
  });
}
