import type { Metadata } from "next";
import { DemoShell } from "@/components/dashboard/demo-shell";
import { ThreadsView } from "@/components/dashboard/threads-view";
import { threadDetailHref } from "@/lib/dashboard/threads-view";
import { getDemoThreadList } from "@/lib/demo/threads";

export const metadata: Metadata = {
  title: "Demo threads · TraceBoard",
  description: "Sample conversations of a read-only demo project, each a list of traces. No sign-up needed.",
};

/**
 * The demo's Threads list: the same ThreadsView as the signed-in page, fed from the committed snapshot. No parameters are read
 * (the sample is fixed), so there is nothing to validate and nothing that varies per visitor.
 */
export default function DemoThreadsPage() {
  return (
    <DemoShell active="threads">
      <ThreadsView
        variant="demo"
        items={getDemoThreadList()}
        range="24h"
        hasCursor={false}
        nextCursor={null}
        truncated={false}
        basePath="/demo/threads"
        tracesHref="/demo/traces"
        rowHref={(threadId) => threadDetailHref("/demo/threads", threadId)}
      />
    </DemoShell>
  );
}
