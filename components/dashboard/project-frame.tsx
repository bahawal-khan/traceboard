import Link from "next/link";
import type { ReactNode } from "react";
import { LiveUpdates } from "@/components/dashboard/live-updates";
import { PageShell } from "@/components/dashboard/page-shell";
import { ProjectNav } from "@/components/dashboard/project-nav";
import { LIVE_BANNER_RESERVE_CLASS } from "@/lib/dashboard/live-banner";
import { PROJECT_NAV_ITEMS } from "@/lib/dashboard/nav";

/**
 * Heading and tabs shared by every page of a project. Used by each page (not by a layout) on purpose: a layout cannot
 * render the not-found page of its own segment, and the project is looked up in the page anyway.
 * Only the project's id and name are needed here; nothing else about it reaches the client.
 * It also mounts the quiet live-updates notice (a fixed overlay, nothing in the page flow); it skips the API keys page itself.
 */
export function ProjectFrame({ project, children }: { project: { id: string; name: string }; children: ReactNode }) {
  return (
    <PageShell width="wide">
      <Link href="/dashboard" className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline underline-offset-4 sm:min-h-0">
        All projects
      </Link>
      <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight" title={project.name}>
        {project.name}
      </h1>
      <div className="mt-4">
        <ProjectNav projectId={project.id} items={PROJECT_NAV_ITEMS} />
      </div>
      {/* Permanent room for the fixed live banner (shown or not), so the last content scrolls clear of it and nothing shifts. */}
      <div className={`mt-6 ${LIVE_BANNER_RESERVE_CLASS}`}>{children}</div>
      <LiveUpdates projectId={project.id} />
    </PageShell>
  );
}
