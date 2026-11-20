import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { buildCsp } from "@/lib/security/csp";
import { isApiKeyRoute } from "@/lib/security/api-key-routes";
import { clerkCspSources } from "@/lib/security/clerk";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/lib/request-id";

/** Dashboard pages and dashboard APIs need a Clerk session. Ingest/OTLP use API keys and bypass Clerk (see `proxy`). */
const isProtectedPage = createRouteMatcher(["/dashboard(.*)"]);
const isProtectedApi = createRouteMatcher(["/api/dashboard(.*)"]);

function withSecurity(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const requestId = requestIdFrom(request.headers);
  const csp = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    ...clerkCspSources(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY),
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

const clerk = clerkMiddleware(async (auth, request) => {
  if (isProtectedApi(request)) {
    // APIs answer 401 JSON (never a redirect to an HTML page); generic body.
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { error: "unauthorized" },
        { status: 401, headers: { [REQUEST_ID_HEADER]: requestIdFrom(request.headers) } },
      );
    }
  } else if (isProtectedPage(request)) {
    await auth.protect();
  }
  return withSecurity(request);
});

/**
 * API-key routes (/api/ingest, /api/otlp/*) skip Clerk entirely: they authenticate themselves, and Clerk
 * must not look at their Authorization header. They still get the security headers and a request id.
 * Everything else goes through Clerk exactly as before.
 */
export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (isApiKeyRoute(request.nextUrl.pathname)) return withSecurity(request);
  return clerk(request, event);
}

export const config = {
  matcher: [
    // Skip Next internals and static files; always run for API and Clerk routes.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
