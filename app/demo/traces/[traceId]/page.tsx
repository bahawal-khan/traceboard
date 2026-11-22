import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DemoShell } from "@/components/dashboard/demo-shell";
import { TraceDetailPageView } from "@/components/dashboard/trace-detail-page-view";
import { getDemoTraceIds, getDemoTraceView } from "@/lib/demo/traces";

export const metadata: Metadata = { title: "Demo trace · TraceBoard" };

// Only the sample's trace ids exist; every other id is a 404 without running this page.
export const dynamicParams = false;
export function generateStaticParams() {
  return getDemoTraceIds().map((traceId) => ({ traceId }));
}

/**
 * One demo trace, through the same view as the signed-in page (summary, notices, waterfall, table, span panel). The id is
 * only looked up in the committed sample; an unknown or malformed id gets the plain not-found page.
 */
export default async function DemoTracePage({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await params;
  const view = getDemoTraceView(traceId);
  if (view === null) notFound();
  return (
    <DemoShell active="traces">
      <TraceDetailPageView view={view} backHref="/demo/traces" />
    </DemoShell>
  );
}
