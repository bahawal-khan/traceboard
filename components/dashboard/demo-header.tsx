import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";

/** Header of the public demo: no account menu (a visitor has no session), links to sign in or up instead. */
export function DemoHeader() {
  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-2 px-4">
        <Link href="/" className="inline-flex min-h-11 items-center font-semibold tracking-tight">
          TraceBoard
        </Link>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Link href="/sign-in" className={buttonVariants({ variant: "ghost", className: "h-11 px-3 sm:h-8" })}>
            Sign in
          </Link>
          <Link href="/sign-up" className={buttonVariants({ className: "h-11 px-3 sm:h-8" })}>
            Sign up
          </Link>
        </div>
      </div>
    </header>
  );
}
