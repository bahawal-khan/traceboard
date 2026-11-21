import { redirect } from "next/navigation";
import { PageShell } from "@/components/dashboard/page-shell";
import { QUOTAS } from "@/lib/quotas";
import { ctxFromSession } from "@/lib/repo/ctx";
import { listProjects } from "@/lib/repo/projects";
import { ProjectsPanel } from "./projects-panel";

export default async function DashboardPage() {
  // Defence in depth: the proxy protects /dashboard and the layout claims the user slot.
  const ctx = await ctxFromSession();
  if (!ctx) redirect("/sign-in");
  const projects = await listProjects(ctx);

  return (
    <PageShell>
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {projects.length} of {QUOTAS.projectsPerUser} projects used on the free plan.
      </p>
      <ProjectsPanel initial={projects} limit={QUOTAS.projectsPerUser} />
    </PageShell>
  );
}
