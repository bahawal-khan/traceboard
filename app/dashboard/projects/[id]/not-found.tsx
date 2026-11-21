import Link from "next/link";
import { PageShell } from "@/components/dashboard/page-shell";
import { buttonVariants } from "@/components/ui/button";

/**
 * The ONE page for every kind of "no such project": a wrong id, someone else's project, a deleted one, a malformed one.
 * Identical text for all of them, so nothing reveals which projects exist.
 */
export default function ProjectNotFound() {
  return (
    <PageShell>
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Project not found</h1>
        <p className="max-w-md text-muted-foreground">This project does not exist, or you do not have access to it.</p>
        <Link href="/dashboard" className={buttonVariants({ variant: "outline", className: "h-11 px-4 sm:h-9" })}>
          Back to your projects
        </Link>
      </div>
    </PageShell>
  );
}
