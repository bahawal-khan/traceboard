import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ProjectFrame } from "@/components/dashboard/project-frame";
import { loadProjectNotices } from "@/lib/notices/load-notices";
import { QUOTAS } from "@/lib/quotas";
import { listApiKeys } from "@/lib/repo/api-keys";
import { ctxFromSession } from "@/lib/repo/ctx";
import { isNotFoundLike } from "@/lib/repo/errors";
import { getProject } from "@/lib/repo/projects";
import { KeysPanel } from "./keys-panel";

export const metadata: Metadata = { title: "API keys", robots: { index: false, follow: false } };
// Per-user data: rendered for every request, never prerendered or shared (the response is also private, no-store: next.config.ts).
export const dynamic = "force-dynamic";

export default async function ProjectKeysPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await ctxFromSession();
  if (!ctx) redirect("/sign-in");
  let project, keys, notices;
  try {
    [project, keys, notices] = await Promise.all([getProject(ctx, id), listApiKeys(ctx, id), loadProjectNotices(ctx, id)]);
  } catch (e) {
    // Not found, not yours, deleted or not a uuid: the same not-found page for all of them. Anything else (for example the
    // database being unreachable) is rethrown to the dashboard error boundary.
    if (isNotFoundLike(e)) notFound();
    throw e;
  }

  return (
    <ProjectFrame project={project} notices={notices}>
      <h2 className="text-xl font-semibold tracking-tight">API keys</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Use a key in the SDK or an OTLP exporter. Up to {QUOTAS.keysPerProject} active keys per project. A key is shown once, when you
        create it.
      </p>
      <KeysPanel projectId={project.id} initial={keys} limit={QUOTAS.keysPerProject} />
    </ProjectFrame>
  );
}
