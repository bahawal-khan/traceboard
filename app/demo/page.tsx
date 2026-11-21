import { Info } from "lucide-react";
import type { Metadata } from "next";
import { DemoHeader } from "@/components/dashboard/demo-header";
import { OverviewView } from "@/components/dashboard/overview-view";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
    <div className="flex flex-1 flex-col">
      <DemoHeader />
      <main className="mx-auto w-full min-w-0 max-w-5xl flex-1 space-y-6 px-4 py-6 sm:py-8">
        <h1 className="sr-only">Demo project</h1>
        <Alert>
          <Info aria-hidden />
          <AlertTitle>Demo project: sample data</AlertTitle>
          <AlertDescription>
            Everything here is synthetic and read-only: a week of simulated traffic from a support agent, frozen at one moment.
            Prices are those of the listed models; one model is deliberately unpriced to show how unknown costs are handled.
          </AlertDescription>
        </Alert>
        <OverviewView data={data} basePath="/demo" />
      </main>
    </div>
  );
}
