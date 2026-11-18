import { NextResponse, type NextRequest } from "next/server";
import { buildCsp } from "@/lib/security/csp";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/lib/request-id";

/**
 * Per-request CSP nonce + request id. Pages are rendered dynamically so Next
 * can apply the nonce. P1.2 composes Clerk's middleware into this file.
 */
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const requestId = requestIdFrom(request.headers);
  const csp = buildCsp({ nonce, isDev: process.env.NODE_ENV === "development" });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
