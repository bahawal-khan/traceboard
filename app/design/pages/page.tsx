import { notFound } from "next/navigation";
import { CapacityNotice } from "@/components/dashboard/capacity-notice";
import { PageShell } from "@/components/dashboard/page-shell";
import { ConnectionError } from "@/components/connection-error";
import { QUOTAS } from "@/lib/quotas";
import { ProjectsPanel } from "@/app/dashboard/projects-panel";
import { KeysPanel } from "@/app/dashboard/projects/[id]/keys-panel";

export const metadata = { title: "Signed-in pages (fixtures)", robots: { index: false, follow: false } };

const PROJECTS = [
  { id: "00000000-0000-4000-8000-000000000001", name: "support-agent", createdAt: "2026-11-02T10:00:00Z" },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "A project with a very long name that must truncate instead of pushing the buttons off the screen",
    createdAt: "2026-11-18T23:59:00Z",
  },
];

const KEYS = [
  { id: "k1", name: "production", prefix: "lm_live_a1b2c3", scopes: ["ingest"], lastUsedAt: "2026-11-20T08:00:00Z", revokedAt: null, createdAt: "2026-11-03T09:00:00Z" },
  { id: "k2", name: "", prefix: "lm_live_d4e5f6", scopes: ["ingest", "eval"], lastUsedAt: null, revokedAt: null, createdAt: "2026-11-10T09:00:00Z" },
  { id: "k3", name: "old CI key with a rather long descriptive name", prefix: "lm_live_g7h8i9", scopes: ["eval"], lastUsedAt: "2026-11-05T08:00:00Z", revokedAt: "2026-11-06T08:00:00Z", createdAt: "2026-11-04T09:00:00Z" },
];

/**
 * Development-only: renders the REAL Phase 1 components with fixture data, because the signed-in pages cannot be opened
 * headlessly without a session. `?view=projects|projects-empty|keys|keys-empty|capacity-full|capacity-paused|error`.
 * A production build answers 404.
 */
export default async function PagesFixtures({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { view = "projects" } = await searchParams;

  switch (view) {
    case "projects-empty":
    case "projects":
      return (
        <PageShell>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {view === "projects" ? PROJECTS.length : 0} of {QUOTAS.projectsPerUser} projects used on the free plan.
          </p>
          <ProjectsPanel initial={view === "projects" ? PROJECTS : []} limit={QUOTAS.projectsPerUser} />
        </PageShell>
      );
    case "keys":
    case "keys-empty":
      return (
        <PageShell>
          <span className="text-sm text-muted-foreground underline underline-offset-4">All projects</span>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">support-agent</h1>
          <h2 className="mt-8 text-lg font-medium">API keys</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Use a key in the SDK or an OTLP exporter. Up to {QUOTAS.keysPerProject} active keys per project. A key is shown once, when you
            create it.
          </p>
          <KeysPanel projectId={PROJECTS[0].id} initial={view === "keys" ? KEYS : []} limit={QUOTAS.keysPerProject} />
        </PageShell>
      );
    case "capacity-full":
      return <CapacityNotice status="full" />;
    case "capacity-paused":
      return <CapacityNotice status="paused" />;
    case "error":
      return <ConnectionError reference="1234567890" />;
    default:
      notFound();
  }
}
