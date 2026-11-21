import Link from "next/link";
import { AppHeader } from "@/components/dashboard/app-header";
import { buttonVariants } from "@/components/ui/button";

export type CapacityStatus = "full" | "paused";

/** The "we are at capacity" page. `full` = user limit reached, `paused` = storage guard is protecting the database. */
export function CapacityNotice({ status }: { status: CapacityStatus }) {
  return (
    <div className="flex flex-1 flex-col">
      <AppHeader />
      <main className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">We are at capacity</h1>
        <p className="max-w-md text-muted-foreground">
          {status === "paused"
            ? "This free deployment is protecting its storage, so new accounts cannot be activated right now. Existing accounts are not affected. Please try again later."
            : "This free deployment has reached its user limit, so new accounts cannot be activated right now. Existing accounts are not affected."}
        </p>
        <Link className={buttonVariants({ variant: "outline", className: "h-11 px-4 sm:h-9" })} href="/">
          Back to home
        </Link>
      </main>
    </div>
  );
}
