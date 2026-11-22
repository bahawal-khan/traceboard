import Link from "next/link";
import { cn } from "@/lib/utils";

const ITEMS = [
  { id: "overview", label: "Overview", href: "/demo" },
  { id: "traces", label: "Traces", href: "/demo/traces" },
] as const;

export type DemoTab = (typeof ITEMS)[number]["id"];

/**
 * Tabs of the public demo. A plain server component: the active tab is a prop (no hook, no session, no router state), so it
 * is as static as the page around it.
 */
export function DemoNav({ active }: { active: DemoTab }) {
  return (
    <nav aria-label="Demo" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b">
        {ITEMS.map((item) => (
          <li key={item.id}>
            <Link
              href={item.href}
              aria-current={item.id === active ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium transition-colors sm:min-h-9",
                item.id === active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
