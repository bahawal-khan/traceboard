import Link from "next/link";
import { PageShell } from "@/components/dashboard/page-shell";
import { buttonVariants } from "@/components/ui/button";

/**
 * The ONE page for every "cannot show this": a wrong, foreign, deleted or malformed project id, and a missing, foreign or
 * expired trace. Identical, neutral text for all of them ("Not found", not "Not found"), so nothing reveals what exists
 * and a missing trace is not reported as a missing project.
 */
export default function ProjectNotFound() {
  return (
    <PageShell>
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
        <p className="max-w-md text-muted-foreground">This page does not exist, or you do not have access to it.</p>
        <Link href="/dashboard" className={buttonVariants({ variant: "outline", className: "h-11 px-4 sm:h-9" })}>
          Back to your projects
        </Link>
      </div>
    </PageShell>
  );
}
