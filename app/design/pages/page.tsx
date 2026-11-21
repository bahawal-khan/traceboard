import { notFound } from "next/navigation";
import { CapacityNotice } from "@/components/dashboard/capacity-notice";
import { PageShell } from "@/components/dashboard/page-shell";
import { ConnectionError } from "@/components/connection-error";
import { OverviewView } from "@/components/dashboard/overview-view";
import { ProjectFrame } from "@/components/dashboard/project-frame";
import ProjectNotFound from "@/app/dashboard/projects/[id]/not-found";
import { buildOverview } from "@/lib/dashboard/overview";
import { getDemoOverview } from "@/lib/demo";
import { QUOTAS } from "@/lib/quotas";
import { ProjectsPanel } from "@/app/dashboard/projects-panel";
import { KeysPanel } from "@/app/dashboard/projects/[id]/keys/keys-panel";

export const metadata = { title: "Signed-in pages (fixtures)", robots: { index: false, follow: false } };

const PROJECTS = [
  { id: "00000000-0000-4000-8000-000000000001", name: "support-agent", createdAt: "2026-11-02T10:00:00Z" },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "A project with a very long name that must truncate instead of pushing the buttons off the screen",
    createdAt: "2026-11-18T23:59:00Z",
  },
];

const FIXTURE_NOW = Date.UTC(2026, 10, 21, 12, 30, 0);

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
        <ProjectFrame project={PROJECTS[0]}>
          <h2 className="text-xl font-semibold tracking-tight">API keys</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Use a key in the SDK or an OTLP exporter. Up to {QUOTAS.keysPerProject} active keys per project. A key is shown once, when you
            create it.
          </p>
          <KeysPanel projectId={PROJECTS[0].id} initial={view === "keys" ? KEYS : []} limit={QUOTAS.keysPerProject} />
        </ProjectFrame>
      );
    case "overview":
    case "overview-7d":
    case "overview-partial":
      // The demo's numbers inside the REAL project frame: what a project with data looks like.
      return (
        <ProjectFrame project={PROJECTS[0]}>
          <OverviewView
            data={{ ...getDemoOverview(view === "overview-7d" ? "7d" : "24h"), truncated: view === "overview-partial" }}
            basePath="/design/pages"
            keysHref="/design/pages?view=keys"
          />
        </ProjectFrame>
      );
    case "overview-empty":
      return (
        <ProjectFrame project={PROJECTS[0]}>
          <OverviewView data={buildOverview({ range: "24h", nowMs: FIXTURE_NOW, rows: [], pricedModels: new Set(), eventsToday: 0, eventsLimit: QUOTAS.eventsPerDayPerProject })} basePath="/design/pages" keysHref="/design/pages?view=keys" />
        </ProjectFrame>
      );
    case "overview-unpriced": {
      // Only an unpriced model in the last hours: its cost must read as unknown ("—", "no price"), never as $0.00.
      const hour = Math.floor(FIXTURE_NOW / 3_600_000) * 3_600_000;
      const lat = [0, 0, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0];
      const rows = [0, 1, 2].map((i) => ({ bucket: hour - i * 3_600_000, model: "acme-local-7b", calls: 5, errors: 0, inputTokens: 900, outputTokens: 300, costMicro: 0, latSumMs: 1500, lat }));
      return (
        <ProjectFrame project={PROJECTS[0]}>
          <OverviewView data={buildOverview({ range: "24h", nowMs: FIXTURE_NOW, rows, pricedModels: new Set(), eventsToday: 15, eventsLimit: QUOTAS.eventsPerDayPerProject })} basePath="/design/pages" keysHref="/design/pages?view=keys" />
        </ProjectFrame>
      );
    }
    case "not-found":
      return <ProjectNotFound />;
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
