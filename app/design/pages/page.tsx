import { notFound } from "next/navigation";
import { CapacityNotice } from "@/components/dashboard/capacity-notice";
import { PageShell } from "@/components/dashboard/page-shell";
import { ConnectionError } from "@/components/connection-error";
import { OverviewView } from "@/components/dashboard/overview-view";
import { LiveBannerView } from "@/components/dashboard/live-banner-view";
import type { BannerState } from "@/lib/dashboard/live-banner";
import { ProjectFrame } from "@/components/dashboard/project-frame";
import { TraceDetailPageView } from "@/components/dashboard/trace-detail-page-view";
import { ThreadsView } from "@/components/dashboard/threads-view";
import { TracesView } from "@/components/dashboard/traces-view";
import { ThreadDetailPageView } from "@/components/dashboard/thread-detail-view";
import { buildThreadDetailView } from "@/lib/dashboard/thread-detail-view";
import { HOSTILE_THREAD_FIXTURES, THREAD_DETAIL_NAMES, THREAD_FIXTURES, threadDetailFixture } from "@/lib/dashboard/thread-fixtures";
import { buildTraceDetailView } from "@/lib/dashboard/trace-detail-view";
import { TRACE_FIXTURE_NAMES, traceFixture } from "@/lib/dashboard/trace-fixtures";
import type { TraceListItem } from "@/lib/repo/traces";
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

const TRACE_FIXTURES: TraceListItem[] = [
  { traceId: "9f2c41d8e0a74b6c8d3e5f7a1b2c3d4e", startedAtMs: FIXTURE_NOW - 40_000, durationMs: 4_820, spanCount: 7, errorCount: 0, totalTokens: 12_450, costMicro: 18_200, costLowerBound: false, unpricedEvents: 0, rootName: "agent.run", hasRoot: true },
  { traceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90", startedAtMs: FIXTURE_NOW - 95_000, durationMs: 31_400, spanCount: 12, errorCount: 2, totalTokens: 48_900, costMicro: 91_500, costLowerBound: false, unpricedEvents: 0, rootName: "agent.run", hasRoot: true },
  { traceId: "b7c8d9e0f1a2b3c4d5e6f708192a3b4c", startedAtMs: FIXTURE_NOW - 180_000, durationMs: 1_150, spanCount: 3, errorCount: 1, totalTokens: 2_300, costMicro: 3_100, costLowerBound: true, unpricedEvents: 1, rootName: "support.answer", hasRoot: true },
  { traceId: "c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5", startedAtMs: FIXTURE_NOW - 260_000, durationMs: 2_400, spanCount: 4, errorCount: 0, totalTokens: 3_100, costMicro: null, costLowerBound: true, unpricedEvents: 2, rootName: "summarize", hasRoot: true },
  { traceId: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f809", startedAtMs: FIXTURE_NOW - 330_000, durationMs: 640, spanCount: 2, errorCount: 0, totalTokens: 800, costMicro: 0, costLowerBound: false, unpricedEvents: 0, rootName: "free-model call", hasRoot: true },
  { traceId: "e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3", startedAtMs: FIXTURE_NOW - 420_000, durationMs: 5_900, spanCount: 3, errorCount: 0, totalTokens: 5_200, costMicro: 7_400, costLowerBound: false, unpricedEvents: 0, rootName: null, hasRoot: false },
  { traceId: "f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5", startedAtMs: FIXTURE_NOW - 500_000, durationMs: 90, spanCount: 1, errorCount: 0, totalTokens: 0, costMicro: 0, costLowerBound: false, unpricedEvents: 0, rootName: null, hasRoot: true },
  { traceId: "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d", startedAtMs: FIXTURE_NOW - 3_600_000, durationMs: 125_000, spanCount: 9, errorCount: 0, totalTokens: 220_000, costMicro: 1_240_000, costLowerBound: false, unpricedEvents: 0, rootName: "A very long root span name that has to be cut off instead of pushing the other columns out of the screen", hasRoot: true },
  { traceId: "tr-" + "x".repeat(100), startedAtMs: FIXTURE_NOW - 7_200_000, durationMs: 700, spanCount: 2, errorCount: 0, totalTokens: 1_000, costMicro: 1_500, costLowerBound: false, unpricedEvents: 0, rootName: "agent.run", hasRoot: true },
];

const KEYS = [
  { id: "k1", name: "production", prefix: "lm_live_a1b2c3", scopes: ["ingest"], lastUsedAt: "2026-11-20T08:00:00Z", revokedAt: null, createdAt: "2026-11-03T09:00:00Z" },
  { id: "k2", name: "", prefix: "lm_live_d4e5f6", scopes: ["ingest", "eval"], lastUsedAt: null, revokedAt: null, createdAt: "2026-11-10T09:00:00Z" },
  { id: "k3", name: "old CI key with a rather long descriptive name", prefix: "lm_live_g7h8i9", scopes: ["eval"], lastUsedAt: "2026-11-05T08:00:00Z", revokedAt: "2026-11-06T08:00:00Z", createdAt: "2026-11-04T09:00:00Z" },
];

/**
 * Development-only: renders the REAL Phase 1 components with fixture data, because the signed-in pages cannot be opened
 * headlessly without a session. `?view=projects|projects-empty|keys|keys-empty|threads|threads-older|threads-partial|threads-empty|threads-7d-empty|threads-hostile|thread-<normal|partial-cost|truncated|untraced|no-traces|hostile|many>|live-<none|new|one|errors|truncated|long|paused|ended-session|ended-gone>|capacity-full|capacity-paused|error|trace-<ok|failed|orphan|cycle|deep|unpriced|partial|instant|large>`.
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
    case "traces":
    case "traces-older":
    case "traces-partial":
    case "traces-errors":
    case "traces-empty":
    case "traces-errors-empty":
    case "traces-7d-empty": {
      const items = view === "traces-empty" || view === "traces-errors-empty" || view === "traces-7d-empty" ? [] : view === "traces-errors" ? TRACE_FIXTURES.filter((t) => t.errorCount > 0) : TRACE_FIXTURES;
      return (
        <ProjectFrame project={PROJECTS[0]}>
          <TracesView
            items={items}
            range={view === "traces-7d-empty" ? "7d" : "24h"}
            status={view === "traces-errors" || view === "traces-errors-empty" ? "errors" : "all"}
            hasCursor={view === "traces-older"}
            nextCursor={view === "traces-older" || view === "traces-errors" || items.length === 0 ? null : "ZmFrZS1jdXJzb3I"}
            truncated={view === "traces-partial"}
            basePath="/design/pages"
            keysHref="/design/pages?view=keys"
            rowHref={() => "/design/pages?view=trace-ok"}
            extraParams={{ view }}
          />
        </ProjectFrame>
      );
    }
    case "threads":
    case "threads-older":
    case "threads-partial":
    case "threads-empty":
    case "threads-7d-empty":
    case "threads-hostile": {
      const items = view === "threads-empty" || view === "threads-7d-empty" ? [] : view === "threads-hostile" ? HOSTILE_THREAD_FIXTURES : THREAD_FIXTURES;
      return (
        <ProjectFrame project={PROJECTS[0]}>
          <ThreadsView
            items={items}
            range={view === "threads-7d-empty" ? "7d" : "24h"}
            hasCursor={view === "threads-older"}
            nextCursor={view === "threads-older" || items.length === 0 ? null : "ZmFrZS1jdXJzb3I"}
            truncated={view === "threads-partial"}
            basePath="/design/pages"
            tracesHref="/design/pages?view=traces"
            rowHref={() => `/design/pages?view=${view}`}
            extraParams={{ view }}
          />
        </ProjectFrame>
      );
    }
    case "live-none":
    case "live-new":
    case "live-one":
    case "live-errors":
    case "live-truncated":
    case "live-long":
    case "live-paused":
    case "live-ended-session":
    case "live-ended-gone": {
      // The REAL banner view over a real table, to show it floats above the page and never moves it. Buttons are inert here.
      const state: BannerState =
        view === "live-new" ? { kind: "new", events: 12, errors: 0, atLeast: false }
        : view === "live-one" ? { kind: "new", events: 1, errors: 1, atLeast: false }
        : view === "live-errors" ? { kind: "new", events: 12, errors: 2, atLeast: false }
        : view === "live-truncated" ? { kind: "new", events: 1000, errors: 14, atLeast: true }
        : view === "live-long" ? { kind: "new", events: 987_654, errors: 123_456, atLeast: true }
        : view === "live-paused" ? { kind: "paused" }
        : view === "live-ended-session" ? { kind: "ended", reason: "session_ended" }
        : view === "live-ended-gone" ? { kind: "ended", reason: "not_found" }
        : { kind: "none" };
      return (
        <ProjectFrame project={PROJECTS[0]}>
          <TracesView
            items={TRACE_FIXTURES}
            range="24h"
            status="all"
            hasCursor={false}
            nextCursor={null}
            truncated={false}
            basePath="/design/pages"
            keysHref="/design/pages?view=keys"
            rowHref={() => "/design/pages?view=trace-ok"}
            extraParams={{ view }}
          />
          <LiveBannerView state={state} />
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
    default: {
      const tm = /^thread-(.+)$/.exec(view);
      const threadName = THREAD_DETAIL_NAMES.find((n) => n === tm?.[1]);
      if (threadName) {
        const fx = threadDetailFixture(threadName);
        return (
          <ProjectFrame project={PROJECTS[0]}>
            <ThreadDetailPageView
              view={buildThreadDetailView({ ...fx, tracesPath: "/design/pages?view=trace-ok#" })}
              backHref="/design/pages?view=threads"
            />
          </ProjectFrame>
        );
      }
      const m = /^trace-(.+)$/.exec(view);
      const name = TRACE_FIXTURE_NAMES.find((n) => n === m?.[1]);
      if (!name) notFound();
      const fx = traceFixture(name);
      return (
        <ProjectFrame project={PROJECTS[0]}>
          <TraceDetailPageView view={buildTraceDetailView(fx)} backHref="/design/pages?view=traces" />
        </ProjectFrame>
      );
    }
  }
}
