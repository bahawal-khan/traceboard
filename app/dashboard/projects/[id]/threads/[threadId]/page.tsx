import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ProjectFrame } from "@/components/dashboard/project-frame";
import { ThreadDetailPageView } from "@/components/dashboard/thread-detail-view";
import { buildThreadDetailView, parseThreadIdParam } from "@/lib/dashboard/thread-detail-view";
import { loadProjectNotices } from "@/lib/notices/load-notices";
import { ctxFromSession } from "@/lib/repo/ctx";
import { isNotFoundLike } from "@/lib/repo/errors";
import { getProject } from "@/lib/repo/projects";
import { getThread } from "@/lib/repo/thread-detail";

export const metadata: Metadata = { title: "Thread", robots: { index: false, follow: false } };
// Per-user data: rendered for every request, never prerendered or shared (the response is also private, no-store: next.config.ts).
export const dynamic = "force-dynamic";

/**
 * One thread: summary, notices and its turns (one per trace). Metadata only (ids, names, times, tokens, cost); no message
 * content is read. The thread id from the URL (percent-encoded by Next) is decoded and validated first. Every "cannot read it"
 * case (bad id, wrong or foreign project, no such thread, no events in the window) ends in the same not-found page; a database
 * outage is rethrown to app/dashboard/error.tsx.
 */
export default async function ThreadDetailPage({ params }: { params: Promise<{ id: string; threadId: string }> }) {
  const { id, threadId: rawThreadId } = await params;
  const threadId = parseThreadIdParam(rawThreadId);
  if (threadId === null) notFound();

  const ctx = await ctxFromSession();
  if (!ctx) redirect("/sign-in");

  let project, detail, notices;
  try {
    [project, detail, notices] = await Promise.all([getProject(ctx, id), getThread(ctx, id, threadId), loadProjectNotices(ctx, id)]);
  } catch (e) {
    if (isNotFoundLike(e)) notFound();
    throw e;
  }

  const base = `/dashboard/projects/${project.id}`;
  const view = buildThreadDetailView({
    threadId: detail.threadId,
    turns: detail.turns,
    untracedEvents: detail.untracedEvents,
    truncated: detail.truncated,
    tracesPath: `${base}/traces`,
  });
  return (
    <ProjectFrame project={project} notices={notices}>
      <ThreadDetailPageView view={view} backHref={`${base}/threads`} />
    </ProjectFrame>
  );
}
