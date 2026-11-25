import type { NavItem } from "@/components/dashboard/project-nav";

/**
 * Tabs of a project. `segment` is the folder under app/dashboard/projects/[id]/ ("" = the project home). A test fails when
 * a tab has no page, so the nav can never link to a 404. Add a tab here in the step that adds its page.
 */
export const PROJECT_NAV_ITEMS: readonly NavItem[] = [
  { segment: "", label: "Overview" },
  { segment: "traces", label: "Traces" },
  { segment: "threads", label: "Threads" },
  { segment: "keys", label: "API keys" },
];
