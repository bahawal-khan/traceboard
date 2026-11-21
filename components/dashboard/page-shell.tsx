import type { ReactNode } from "react";
import { AppHeader } from "@/components/dashboard/app-header";
import { cn } from "@/lib/utils";

/** Header plus a centred, padded main column. `narrow` (default) suits forms and lists; `wide` suits chart pages. */
export function PageShell({ children, width = "narrow", className }: { children: ReactNode; width?: "narrow" | "wide"; className?: string }) {
  return (
    <div className="flex flex-1 flex-col">
      <AppHeader />
      <main className={cn("mx-auto w-full min-w-0 flex-1 px-4 py-6 sm:py-8", width === "wide" ? "max-w-5xl" : "max-w-3xl", className)}>{children}</main>
    </div>
  );
}
