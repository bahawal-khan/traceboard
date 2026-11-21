import Link from "next/link";
import { AccountMenu } from "@/components/clerk/account-menu";
import { ThemeToggle } from "@/components/theme-toggle";

/** Top bar for every signed-in page: brand, theme switch, account menu. Tap targets are 44 px on small screens. */
export function AppHeader() {
  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-2 px-4">
        <Link href="/dashboard" className="inline-flex min-h-11 items-center font-semibold tracking-tight">
          TraceBoard
        </Link>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}
