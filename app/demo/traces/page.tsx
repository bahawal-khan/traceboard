import type { Metadata } from "next";
import { DemoShell } from "@/components/dashboard/demo-shell";
import { TracesView } from "@/components/dashboard/traces-view";
import { traceDetailHref } from "@/lib/dashboard/trace-detail-view";
import { getDemoTraceList } from "@/lib/demo/traces";

export const metadata: Metadata = {
  title: "Demo traces · TraceBoard",
  description: "Sample traces of a read-only demo project: a loop, an orphan, a failed run and an unpriced call. No sign-up needed.",
};

/**
 * The demo's Traces list: the same TracesView as the signed-in page, fed from the committed snapshot. No parameters are read
 * (the sample is fixed), so there is nothing to validate and nothing that varies per visitor.
 */
export default function DemoTracesPage() {
  return (
    <DemoShell active="traces">
      <TracesView
        variant="demo"
        items={getDemoTraceList()}
        range="24h"
        status="all"
        hasCursor={false}
        nextCursor={null}
        truncated={false}
        basePath="/demo/traces"
        rowHref={(traceId) => traceDetailHref("/demo/traces", traceId)}
      />
    </DemoShell>
  );
}
