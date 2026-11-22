import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { DemoHeader } from "@/components/dashboard/demo-header";
import { DemoNav, type DemoTab } from "@/components/dashboard/demo-nav";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Frame of every public demo page: header, the read-only banner, the tabs. Static data only; nothing here reads a session
 * or a database, so a visitor can never see another user's data through it.
 */
export function DemoShell({ active, children }: { active: DemoTab; children: ReactNode }) {
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
        <DemoNav active={active} />
        {children}
      </main>
    </div>
  );
}
