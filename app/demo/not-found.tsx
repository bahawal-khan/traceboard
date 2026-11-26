import Link from "next/link";
import { DemoHeader } from "@/components/dashboard/demo-header";
import { buttonVariants } from "@/components/ui/button";

/** Plain not-found page of the public demo: the same text for every unknown address, nothing is echoed back. */
export default function DemoNotFound() {
  return (
    <div className="flex flex-1 flex-col">
      <DemoHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center gap-3 px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
        <p className="max-w-md text-muted-foreground">This demo page does not exist.</p>
        <Link href="/demo" className={buttonVariants({ variant: "outline", className: "h-11 px-4 sm:h-9" })}>
          Back to the demo
        </Link>
      </main>
    </div>
  );
}
