import type { Metadata } from "next";
import { DemoShell } from "@/components/dashboard/demo-shell";
import { OverviewView } from "@/components/dashboard/overview-view";
import { parseRangeParam } from "@/lib/dashboard/page-state";
import { getDemoOverview } from "@/lib/demo";

export const metadata: Metadata = {
  title: "Demo project · TraceBoard",
  description: "A read-only demo project with synthetic data. No sign-up needed.",
};

/**
 * Public, read-only demo. Static data only (lib/demo): no session, no database, no tenant context. A visitor can never
 * see another user's data here because nothing on this page reads any.
 */
export default async function DemoPage({ searchParams }: { searchParams: Promise<{ range?: string | string[] }> }) {
  const { range } = await searchParams;
  const data = getDemoOverview(parseRangeParam(range)); // the same validation as the signed-in Overview

  return (
    <DemoShell active="overview">
      <OverviewView data={data} basePath="/demo" />
    </DemoShell>
  );
}
