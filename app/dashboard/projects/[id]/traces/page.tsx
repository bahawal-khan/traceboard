import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ProjectFrame } from "@/components/dashboard/project-frame";
import { TracesView } from "@/components/dashboard/traces-view";
import { traceDetailHref } from "@/lib/dashboard/trace-detail-view";
import {
  TRACES_PAGE_SIZE,
  parseCursorParam,
  parseTraceRange,
  parseTraceStatus,
  repoStatus,
  traceRangeWindow,
} from "@/lib/dashboard/traces-view";
import { ctxFromSession } from "@/lib/repo/ctx";
import { isNotFoundLike } from "@/lib/repo/errors";
import { getProject } from "@/lib/repo/projects";
import { listTracesTolerant } from "@/lib/repo/traces";

export const metadata: Metadata = { title: "Traces", robots: { index: false, follow: false } };
// Per-user data: rendered for every request, never prerendered or shared (the response is also private, no-store: next.config.ts).
export const dynamic = "force-dynamic";

/**
 * The Traces list. All data comes through lib/repo (session context + RLS). URL parameters are validated by pure functions:
 * a bad range or status falls back to the default, a bad cursor shows the first page.
 */
export default async function ProjectTracesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string | string[]; status?: string | string[]; cursor?: string | string[] }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const range = parseTraceRange(query.range);
  const status = parseTraceStatus(query.status);
  const cursor = parseCursorParam(query.cursor);

  const ctx = await ctxFromSession();
  if (!ctx) redirect("/sign-in");

  const win = traceRangeWindow(range);
  let project, listed;
  try {
    // Two independent reads in parallel; either proves the project is the caller's. "Not found" of any kind ends in the one
    // not-found page; a database outage is rethrown to app/dashboard/error.tsx (retry, no details).
    [project, listed] = await Promise.all([
      getProject(ctx, id),
      listTracesTolerant(ctx, id, { range: win, status: repoStatus(status), cursor, limit: TRACES_PAGE_SIZE }),
    ]);
  } catch (e) {
    if (isNotFoundLike(e)) notFound();
    throw e;
  }

  const { result: page, usedCursor } = listed;
  const base = `/dashboard/projects/${project.id}`;
  return (
    <ProjectFrame project={project}>
      <TracesView
        items={page.items}
        range={range}
        status={status}
        hasCursor={usedCursor}
        nextCursor={page.nextCursor}
        truncated={page.truncated}
        basePath={`${base}/traces`}
        keysHref={`${base}/keys`}
        rowHref={(traceId) => traceDetailHref(`${base}/traces`, traceId)}
      />
    </ProjectFrame>
  );
}
