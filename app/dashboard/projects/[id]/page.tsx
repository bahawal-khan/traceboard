import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NotFoundError } from "@/lib/repo/errors";
import { listApiKeys } from "@/lib/repo/api-keys";
import { ctxFromSession } from "@/lib/repo/ctx";
import { getProject } from "@/lib/repo/projects";
import { QUOTAS } from "@/lib/quotas";
import { KeysPanel } from "./keys-panel";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await ctxFromSession();
  if (!ctx) redirect("/sign-in");
  let project, keys;
  try {
    [project, keys] = await Promise.all([getProject(ctx, id), listApiKeys(ctx, id)]);
  } catch (e) {
    // Not found, not yours, or not a uuid: the same 404 for all three.
    if (e instanceof NotFoundError || (e instanceof Error && e.name === "ZodError")) notFound();
    throw e;
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <Link href="/dashboard" className="font-semibold">
          TraceBoard
        </Link>
        <UserButton />
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <Link href="/dashboard" className="text-sm text-muted-foreground underline">
          All projects
        </Link>
        <h1 className="mt-2 truncate text-2xl font-semibold tracking-tight">{project.name}</h1>
        <h2 className="mt-8 text-lg font-medium">API keys</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Use a key in the SDK or an OTLP exporter. Up to {QUOTAS.keysPerProject} active keys per project. A key is shown once, when
          you create it.
        </p>
        <KeysPanel projectId={project.id} initial={keys} limit={QUOTAS.keysPerProject} />
      </main>
    </div>
  );
}
