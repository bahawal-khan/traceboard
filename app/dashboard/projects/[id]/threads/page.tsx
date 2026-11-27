import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ProjectFrame } from "@/components/dashboard/project-frame";
import { ThreadsView } from "@/components/dashboard/threads-view";
import { THREADS_PAGE_SIZE, parseCursorParam, parseTraceRange, threadDetailHref, traceRangeWindow } from "@/lib/dashboard/threads-view";
import { loadProjectNotices } from "@/lib/notices/load-notices";
import { ctxFromSession } from "@/lib/repo/ctx";
import { isNotFoundLike } from "@/lib/repo/errors";
import { getProject } from "@/lib/repo/projects";
import { listThreadsTolerant } from "@/lib/repo/threads";

export const metadata: Metadata = { title: "Threads", robots: { index: false, follow: false } };
// Per-user data: rendered for every request, never prerendered or shared (the response is also private, no-store: next.config.ts).
export const dynamic = "force-dynamic";

/**
 * The Threads list. All data comes through lib/repo (session context + RLS). URL parameters are validated by pure functions:
 * a bad range falls back to the default, a bad cursor shows the first page. Thread detail pages come in the next step.
 */
export default async function ProjectThreadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string | string[]; cursor?: string | string[] }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const range = parseTraceRange(query.range);
  const cursor = parseCursorParam(query.cursor);

  const ctx = await ctxFromSession();
  if (!ctx) redirect("/sign-in");

  const win = traceRangeWindow(range);
  let project, listed, notices;
  try {
    // Two independent reads in parallel; either proves the project is the caller's. "Not found" of any kind ends in the one
    // not-found page; a database outage is rethrown to app/dashboard/error.tsx (retry, no details).
    [project, listed, notices] = await Promise.all([
      getProject(ctx, id),
      listThreadsTolerant(ctx, id, { range: win, cursor, limit: THREADS_PAGE_SIZE }),
      loadProjectNotices(ctx, id), // never throws; null = no banner
    ]);
  } catch (e) {
    if (isNotFoundLike(e)) notFound();
    throw e;
  }

  const { result: page, usedCursor } = listed;
  const base = `/dashboard/projects/${project.id}`;
  return (
    <ProjectFrame project={project} notices={notices}>
      <ThreadsView
        items={page.items}
        range={range}
        hasCursor={usedCursor}
        nextCursor={page.nextCursor}
        truncated={page.truncated}
        basePath={`${base}/threads`}
        tracesHref={`${base}/traces`}
        rowHref={(threadId) => threadDetailHref(`${base}/threads`, threadId)}
      />
    </ProjectFrame>
  );
}
