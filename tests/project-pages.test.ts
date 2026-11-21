import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_NAV_ITEMS } from "@/lib/dashboard/nav";
import { isApiKeyRoute } from "@/lib/security/api-key-routes";
import { isCronRoute } from "@/lib/security/cron-routes";
import { API_CACHE_HEADER } from "@/lib/security/csp";
import nextConfig from "@/next.config";

/**
 * Static guarantees about the signed-in project pages. They read the SOURCE, because the pages need a session and a
 * database to run; what they do at run time is covered by the unit tests of their pure parts (dashboard-page-state,
 * overview-view, metrics-repo) and by the owner's database tests.
 */
const PROJECT_DIR = "app/dashboard/projects/[id]";
const read = (f: string) => readFileSync(f, "utf8");

const PAGES = [`${PROJECT_DIR}/page.tsx`, `${PROJECT_DIR}/keys/page.tsx`];
const PROJECT_FILES = [
  ...PAGES,
  `${PROJECT_DIR}/not-found.tsx`,
  "components/dashboard/project-frame.tsx",
  "components/dashboard/empty-overview.tsx",
  "components/dashboard/overview-view.tsx",
];

describe("the project pages reach data only through lib/repo", () => {
  const FORBIDDEN: Array<[string, RegExp]> = [
    ["the db client", /@\/lib\/db|getSql|getJobSql/],
    ["a database driver", /@neondatabase|drizzle-orm|from ["']pg["']/],
    ["tenant internals (withTenant belongs inside lib/repo)", /\bwithTenant\b|\brunScoped\b|\bissueCtx\b|@\/lib\/repo\/tenant/],
    ["inline SQL", /`\s*(select|insert|update|delete|with)\s/i],
    ["a table name in a query", /\bfrom\s+(events|event_content|metrics_\w+|usage_daily|projects|api_keys)\b/i],
    ["the network", /\bfetch\(/],
    ["the environment", /process\.env\b/],
  ];

  for (const f of PROJECT_FILES) {
    it(`${f}: no database, SQL, tenant internals, network or env access`, () => {
      const src = read(f);
      for (const [what, re] of FORBIDDEN) expect(src, `${f} must not use ${what}`).not.toMatch(re);
    });
  }

  it("only repo modules that exist for the dashboard are imported (ctx, errors, projects, api-keys, metrics)", () => {
    for (const f of PROJECT_FILES) {
      for (const m of read(f).matchAll(/from ["']@\/lib\/repo\/([\w-]+)["']/g)) {
        expect(["ctx", "errors", "projects", "api-keys", "metrics"], `${f} imports lib/repo/${m[1]}`).toContain(m[1]);
      }
    }
  });

  it("the Overview page gets its data from readOverview and getProject, with a session context, never from the demo snapshot", () => {
    const src = read(PAGES[0]!);
    expect(src).toContain('import { readOverview } from "@/lib/repo/metrics"');
    expect(src).toContain('import { getProject } from "@/lib/repo/projects"');
    expect(src).toContain("const ctx = await ctxFromSession()");
    expect(src).toMatch(/readOverview\(ctx, id, range\)/);
    expect(src).not.toMatch(/@\/lib\/demo/);
  });

  it("the public demo page never touches lib/repo, and the project pages never use the demo data", () => {
    expect(read("app/demo/page.tsx")).not.toMatch(/@\/lib\/repo|ctxFrom|@clerk/);
    for (const f of PAGES) expect(read(f)).not.toMatch(/@\/lib\/demo/);
  });

  it("the signed-in and demo pages validate ?range= with the same function", () => {
    expect(read(PAGES[0]!)).toContain("parseRangeParam(query.range)");
    expect(read("app/demo/page.tsx")).toContain("parseRangeParam(range)");
  });

  it("both pages render the SAME OverviewView component only through its props (demo and real cannot drift)", () => {
    expect(read(PAGES[0]!)).toContain("<OverviewView");
    expect(read("app/demo/page.tsx")).toContain("<OverviewView");
  });
});

describe("the project pages are per-user and never cached", () => {
  it("every project page is force-dynamic, re-checks the session and redirects when there is none", () => {
    for (const f of PAGES) {
      const src = read(f);
      expect(src, f).toContain('export const dynamic = "force-dynamic"');
      expect(src, f).toContain("const ctx = await ctxFromSession()");
      expect(src, f).toContain('if (!ctx) redirect("/sign-in")');
    }
  });
  it("next.config marks everything under /dashboard private, no-store", async () => {
    const rules = await nextConfig("phase-development-server").headers!();
    const rule = rules.find((r) => r.source === "/dashboard/:path*");
    expect(rule, "a /dashboard/:path* rule").toBeDefined();
    expect(rule!.headers).toEqual([API_CACHE_HEADER]);
    expect(API_CACHE_HEADER.value).toBe("private, no-store");
  });
  it("the project pages live under /dashboard, which the proxy protects with Clerk", () => {
    expect(PAGES.every((f) => f.startsWith("app/dashboard/"))).toBe(true);
    expect(read("proxy.ts")).toContain('createRouteMatcher(["/dashboard(.*)"])');
    // ... and the bypass lists (API-key and cron routes skip Clerk) do not match any project page path
    for (const path of ["/dashboard/projects/abc", "/dashboard/projects/abc/keys", "/dashboard/projects/abc?range=7d"]) {
      expect(isApiKeyRoute(path), path).toBe(false);
      expect(isCronRoute(path), path).toBe(false);
    }
  });
  it("private pages ask search engines not to index them", () => {
    for (const f of PAGES) expect(read(f), f).toMatch(/robots: \{ index: false/);
  });
});

describe("not found is one page", () => {
  it("both pages send every not-found-like failure to notFound() and rethrow everything else", () => {
    for (const f of PAGES) {
      expect(read(f), f).toMatch(/if \(isNotFoundLike\(e\)\) notFound\(\);\s*throw e;/);
    }
  });
  it("the not-found page sits in the [id] segment (so it covers the Overview and the keys page) and reflects nothing", () => {
    const f = `${PROJECT_DIR}/not-found.tsx`;
    expect(existsSync(f)).toBe(true);
    const src = read(f);
    expect(src).not.toMatch(/params|useParams|\$\{|\{id\}|\{project|searchParams|headers\(|cookies\(/);
    expect(src).toContain("Project not found");
    expect(src).toContain("does not exist, or you do not have access to it");
  });
  it("a layout does not do the lookup (a layout cannot render its own segment's not-found page)", () => {
    expect(existsSync(`${PROJECT_DIR}/layout.tsx`)).toBe(false);
  });
});

describe("a database outage shows the connection error with retry and no details", () => {
  it("the dashboard error boundary renders ConnectionError with the reset handler and never prints the error", () => {
    const src = read("app/dashboard/error.tsx");
    expect(src).toContain("<ConnectionError onRetry={reset}");
    expect(src).not.toMatch(/error\.message|error\.stack|JSON\.stringify\(error/);
    const ce = read("components/connection-error.tsx");
    expect(ce).toContain("Retry");
    expect(ce).not.toMatch(/\.message|\.stack/);
  });
  it("the project pages do not catch outages themselves (they would hide the retry)", () => {
    for (const f of PAGES) expect(read(f), f).not.toMatch(/isConnectionError|ConnectionError/);
  });
});

describe("navigation", () => {
  const dirs = readdirSync(PROJECT_DIR).filter((n) => statSync(join(PROJECT_DIR, n)).isDirectory());

  it("every tab has a page", () => {
    for (const item of PROJECT_NAV_ITEMS) {
      const page = item.segment === "" ? `${PROJECT_DIR}/page.tsx` : `${PROJECT_DIR}/${item.segment}/page.tsx`;
      expect(existsSync(page), `tab "${item.label}" -> ${page}`).toBe(true);
    }
  });
  it("every page folder under a project has a tab (no hidden pages, no dead links)", () => {
    const withPage = dirs.filter((d) => existsSync(`${PROJECT_DIR}/${d}/page.tsx`));
    expect(withPage.sort()).toEqual(PROJECT_NAV_ITEMS.filter((i) => i.segment !== "").map((i) => i.segment).sort());
  });
  it("the project home is the first tab and is the Overview", () => {
    expect(PROJECT_NAV_ITEMS[0]).toEqual({ segment: "", label: "Overview" });
  });
  it("the projects list links to the Overview and to the API keys page of each project", () => {
    const src = read("app/dashboard/projects-panel.tsx");
    expect(src).toContain("href={`/dashboard/projects/${p.id}`}");
    expect(src).toContain("href={`/dashboard/projects/${p.id}/keys`}");
  });
  it("both pages wear the shared frame (heading, 'All projects' link, tabs)", () => {
    for (const f of PAGES) expect(read(f), f).toContain("<ProjectFrame project={project}>");
    const frame = read("components/dashboard/project-frame.tsx");
    expect(frame).toContain('href="/dashboard"');
    expect(frame).toContain("<ProjectNav");
  });
});

describe("no prompt or response text anywhere on the project pages", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(ts|tsx)$/.test(p) ? [p] : [];
    });
  }
  it("their sources never mention content columns, prompts or completions", () => {
    for (const f of [...PROJECT_FILES, ...walk(PROJECT_DIR)]) {
      expect(read(f), f).not.toMatch(/event_content|input_text|output_text|\bprompt\b|completion|redaction_report/i);
    }
  });
  it("the view-model types have no free-text field except the already-redacted error and names", () => {
    const types = read("lib/dashboard/types.ts");
    expect(types).not.toMatch(/\b(input|output|prompt|completion|content|text|messages)\s*:\s*z\.string/i);
  });
});
