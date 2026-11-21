import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { OverviewView } from "@/components/dashboard/overview-view";
import { ProjectFrame } from "@/components/dashboard/project-frame";
import { parseRangeParam } from "@/lib/dashboard/page-state";
import { ctxFromSession } from "@/lib/repo/ctx";
import { isNotFoundLike } from "@/lib/repo/errors";
import { readOverview } from "@/lib/repo/metrics";
import { getProject } from "@/lib/repo/projects";

export const metadata: Metadata = { title: "Overview", robots: { index: false, follow: false } };
// Per-user data: rendered for every request, never prerendered or shared (the response is also private, no-store: next.config.ts).
export const dynamic = "force-dynamic";

/**
 * The project home: the Overview. Same OverviewView as the public /demo, fed by the database reader instead of the static
 * snapshot. All data comes through lib/repo (session context + RLS); the page holds no SQL and no tenant context of its own.
 */
export default async function ProjectOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const range = parseRangeParam(query.range); // validated; a bad value falls back to 24h

  const ctx = await ctxFromSession();
  if (!ctx) redirect("/sign-in");

  let project, data;
  try {
    // Two independent reads in parallel. Each one proves the project is the caller's; either failing as "not found" ends in
    // the same page. A database outage is not "not found": it is rethrown to app/dashboard/error.tsx (retry, no details).
    [project, data] = await Promise.all([getProject(ctx, id), readOverview(ctx, id, range)]);
  } catch (e) {
    if (isNotFoundLike(e)) notFound();
    throw e;
  }

  const base = `/dashboard/projects/${project.id}`;
  return (
    <ProjectFrame project={project}>
      <OverviewView data={data} basePath={base} keysHref={`${base}/keys`} />
    </ProjectFrame>
  );
}
