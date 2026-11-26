import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ProjectFrame } from "@/components/dashboard/project-frame";
import { TraceDetailPageView } from "@/components/dashboard/trace-detail-page-view";
import { decodeRouteIdParam } from "@/lib/dashboard/route-id";
import { buildTraceDetailView } from "@/lib/dashboard/trace-detail-view";
import { ctxFromSession } from "@/lib/repo/ctx";
import { isNotFoundLike } from "@/lib/repo/errors";
import { getProject } from "@/lib/repo/projects";
import { getTrace } from "@/lib/repo/trace-detail";

export const metadata: Metadata = { title: "Trace", robots: { index: false, follow: false } };
// Per-user data: rendered for every request, never prerendered or shared (the response is also private, no-store: next.config.ts).
export const dynamic = "force-dynamic";

/**
 * One trace: summary, notices and the span waterfall. Metadata only (names, times, tokens, cost); no message content is read.
 * The trace id from the URL is decoded once and validated first. Every "cannot read it" case (bad id, wrong or foreign project, no such
 * trace, expired trace) ends in the same not-found page; a database outage is rethrown to app/dashboard/error.tsx.
 */
export default async function TraceDetailPage({ params }: { params: Promise<{ id: string; traceId: string }> }) {
  const { id, traceId: rawTraceId } = await params;
  // Next hands the page the percent-encoded segment (traceDetailHref encoded it): decode once, then validate (no database call on failure).
  const traceId = decodeRouteIdParam(rawTraceId);
  if (traceId === null) notFound();

  const ctx = await ctxFromSession();
  if (!ctx) redirect("/sign-in");

  let project, detail;
  try {
    [project, detail] = await Promise.all([getProject(ctx, id), getTrace(ctx, id, traceId)]);
  } catch (e) {
    if (isNotFoundLike(e)) notFound();
    throw e;
  }

  const view = buildTraceDetailView({ traceId, spans: detail.spans, truncated: detail.truncated });
  return (
    <ProjectFrame project={project}>
      <TraceDetailPageView view={view} backHref={`/dashboard/projects/${project.id}/traces`} />
    </ProjectFrame>
  );
}
