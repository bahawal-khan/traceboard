import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default async function DashboardPage() {
  // Defence in depth: the proxy already protects /dashboard.
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <span className="font-semibold">TraceBoard</span>
        <UserButton />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="max-w-md text-muted-foreground">No projects yet. Projects arrive in a later step.</p>
      </main>
    </div>
  );
}
