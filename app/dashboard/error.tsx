"use client";

import { ConnectionError } from "@/components/connection-error";

// Error boundary for dashboard pages. Next hides server error messages from the client in production;
// only the digest is shown, and nothing else about the error is rendered.
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ConnectionError onRetry={reset} reference={error.digest} />;
}
