import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ConnectionError } from "@/components/connection-error";
import { isConnectionError } from "@/lib/errors/connection";
import { ensureSignedInUserSlot } from "@/lib/repo/users";

/** First dashboard load registers the user and enforces the free-deployment user cap. */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // An error.tsx in this segment cannot catch errors thrown by this layout, so handle the transient case here.
  let status;
  try {
    status = await ensureSignedInUserSlot();
  } catch (err) {
    if (isConnectionError(err)) return <ConnectionError />;
    throw err;
  }
  if (status === "signed_out") redirect("/sign-in");

  if (status === "full" || status === "paused") {
    return (
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-4 py-3">
          <span className="font-semibold">TraceBoard</span>
          <UserButton />
        </header>
        <main className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">We are at capacity</h1>
          <p className="max-w-md text-muted-foreground">
            {status === "paused"
              ? "This free deployment is protecting its storage, so new accounts cannot be activated right now. Existing accounts are not affected. Please try again later."
              : "This free deployment has reached its user limit, so new accounts cannot be activated right now. Existing accounts are not affected."}
          </p>
          <Link className="rounded-md border px-4 py-2" href="/">
            Back to home
          </Link>
        </main>
      </div>
    );
  }

  return children;
}
