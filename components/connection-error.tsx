"use client";

import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/dashboard/app-header";
import { Button } from "@/components/ui/button";

/** Friendly failure state. Never shows error details; the digest is an opaque id for support. */
export function ConnectionError({ onRetry, reference }: { onRetry?: () => void; reference?: string }) {
  const router = useRouter();
  return (
    <div className="flex flex-1 flex-col">
      <AppHeader />
      <main role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Could not reach the database</h1>
        <p className="max-w-md text-muted-foreground">
          Please try again in a moment. If it keeps happening, wait a few seconds: the database may be waking up.
        </p>
        <Button className="h-11 px-4 sm:h-9" onClick={() => (onRetry ? onRetry() : router.refresh())}>
          Retry
        </Button>
        {reference && <p className="text-xs text-muted-foreground">Reference: {reference}</p>}
      </main>
    </div>
  );
}
