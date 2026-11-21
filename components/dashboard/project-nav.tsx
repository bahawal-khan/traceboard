"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface NavItem {
  /** Path segment after /dashboard/projects/<id>, "" for the project home. */
  segment: string;
  label: string;
}

/**
 * Project-scoped tab navigation. The project id is part of every URL (no hidden "selected project" state), so a link
 * always means the same project and IDOR checks happen per request. Horizontally scrollable on narrow screens.
 */
export function ProjectNav({ projectId, items, basePath }: { projectId: string; items: readonly NavItem[]; basePath?: string }) {
  const pathname = usePathname() ?? "";
  const base = basePath ?? `/dashboard/projects/${projectId}`;
  return (
    <nav aria-label="Project" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b">
        {items.map((item) => {
          const href = item.segment ? `${base}/${item.segment}` : base;
          const active = item.segment ? pathname === href || pathname.startsWith(`${href}/`) : pathname === base;
          return (
            <li key={item.segment || "home"}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium transition-colors sm:min-h-9",
                  active
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
