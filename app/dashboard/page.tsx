import { UserButton } from "@clerk/nextjs";
import { redirect } from "next/navigation";
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
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <span className="font-semibold">TraceBoard</span>
        <UserButton />
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {projects.length} of {QUOTAS.projectsPerUser} projects used on the free plan.
        </p>
        <ProjectsPanel initial={projects} limit={QUOTAS.projectsPerUser} />
      </main>
    </div>
  );
}
