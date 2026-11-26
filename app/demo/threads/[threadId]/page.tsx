import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DemoShell } from "@/components/dashboard/demo-shell";
import { ThreadDetailPageView } from "@/components/dashboard/thread-detail-view";
import { getDemoThreadIds, getDemoThreadView } from "@/lib/demo/threads";

export const metadata: Metadata = { title: "Demo thread · TraceBoard" };

// Only the sample's thread ids exist; every other id is a 404 without running this page.
export const dynamicParams = false;
export function generateStaticParams() {
  return getDemoThreadIds().map((threadId) => ({ threadId }));
}

/**
 * One demo thread, through the same view as the signed-in page (summary, turns linking to the demo traces). The id is only
 * looked up in the committed sample; an unknown or malformed id gets the plain not-found page. The sample's thread ids are
 * URL-safe (letters, digits, underscore, such as `th_demo_01`), so the segment Next passes equals the id and needs no decoding
 * here; tests/demo-threads.test.ts fails if a snapshot id ever changes under encodeURIComponent.
 */
export default async function DemoThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  const view = getDemoThreadView(threadId);
  if (view === null) notFound();
  return (
    <DemoShell active="threads">
      <ThreadDetailPageView view={view} backHref="/demo/threads" />
    </DemoShell>
  );
}
