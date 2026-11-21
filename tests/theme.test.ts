import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AfterMount } from "@/components/clerk/after-mount";
import { ThemeScript } from "@/components/theme-script";
import { MEDIA_DARK, THEME_SCRIPT, THEME_STORAGE_KEY, THEMES, applyTheme, isDark, parseTheme, type Theme } from "@/lib/theme";

/** A tiny fake browser: just what the inline script and applyTheme touch. */
interface FakeOptions {
  stored?: string | null;
  storageThrows?: boolean;
  systemDark?: boolean;
  noMatchMedia?: boolean;
  matchMediaThrows?: boolean;
  classListThrows?: boolean;
}
function fakeBrowser(o: FakeOptions = {}) {
  const classes = new Set<string>();
  const html = {
    classList: {
      toggle(name: string, force?: boolean) {
        if (o.classListThrows) throw new Error("blocked");
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    style: { colorScheme: "" },
  };
  const asked: string[] = [];
  const sandbox: Record<string, unknown> = {
    document: { documentElement: html },
    localStorage: {
      getItem(k: string) {
        asked.push(k);
        if (o.storageThrows) throw new Error("SecurityError");
        return o.stored === undefined ? null : o.stored;
      },
    },
  };
  if (!o.noMatchMedia) {
    sandbox.window = {
      matchMedia: (q: string) => {
        asked.push(q);
        if (o.matchMediaThrows) throw new Error("nope");
        return { matches: q === MEDIA_DARK && !!o.systemDark };
      },
    };
  } else {
    sandbox.window = {};
  }
  return { html, classes, sandbox, asked };
}
const runScript = (o: FakeOptions) => {
  const b = fakeBrowser(o);
  runInNewContext(THEME_SCRIPT, b.sandbox);
  return { dark: b.classes.has("dark"), colorScheme: b.html.style.colorScheme, asked: b.asked };
};

describe("the inline pre-paint script", () => {
  it("a stored 'dark' wins over a light OS, a stored 'light' wins over a dark OS", () => {
    expect(runScript({ stored: "dark", systemDark: false })).toMatchObject({ dark: true, colorScheme: "dark" });
    expect(runScript({ stored: "light", systemDark: true })).toMatchObject({ dark: false, colorScheme: "light" });
  });
  it("with no stored choice it follows the OS", () => {
    expect(runScript({ stored: null, systemDark: true })).toMatchObject({ dark: true, colorScheme: "dark" });
    expect(runScript({ stored: null, systemDark: false })).toMatchObject({ dark: false, colorScheme: "light" });
    expect(runScript({ systemDark: true }).dark).toBe(true); // key absent altogether
  });
  it("anything that is not exactly 'light' or 'dark' means System (stale values, other casing, junk)", () => {
    for (const junk of ["system", "Dark", "LIGHT", " dark", "blue", "", "null", "undefined", "1", "{}", "dark;"]) {
      expect(runScript({ stored: junk, systemDark: true }).dark, JSON.stringify(junk)).toBe(true);
      expect(runScript({ stored: junk, systemDark: false }).dark, JSON.stringify(junk)).toBe(false);
    }
  });
  it("blocked localStorage still honours the OS setting (storage and matchMedia are read separately)", () => {
    expect(runScript({ storageThrows: true, systemDark: true })).toMatchObject({ dark: true, colorScheme: "dark" });
    expect(runScript({ storageThrows: true, systemDark: false })).toMatchObject({ dark: false, colorScheme: "light" });
  });
  it("a missing or throwing matchMedia falls back to light, but a stored choice still applies", () => {
    expect(runScript({ stored: null, noMatchMedia: true }).dark).toBe(false);
    expect(runScript({ stored: null, matchMediaThrows: true }).dark).toBe(false);
    expect(runScript({ stored: "dark", noMatchMedia: true }).dark).toBe(true);
    expect(runScript({ stored: "dark", matchMediaThrows: true }).dark).toBe(true);
  });
  it("never throws, whatever the browser does (even when it cannot touch <html>)", () => {
    for (const o of [{ storageThrows: true, matchMediaThrows: true }, { classListThrows: true }, { storageThrows: true, noMatchMedia: true, classListThrows: true }]) {
      expect(() => runScript(o)).not.toThrow();
    }
  });
  it("reads exactly the storage key and the media query the provider uses", () => {
    const { asked } = runScript({ stored: "light", systemDark: true });
    expect(asked).toEqual([THEME_STORAGE_KEY, MEDIA_DARK]);
    expect(THEME_STORAGE_KEY).toBe("theme");
    expect(MEDIA_DARK).toBe("(prefers-color-scheme: dark)");
  });
  it("is small, one statement, and cannot break out of its <script> element", () => {
    expect(THEME_SCRIPT.length).toBeLessThan(500);
    expect(THEME_SCRIPT).not.toMatch(/<\/script|<!--|\n/i);
    expect(THEME_SCRIPT.startsWith("(function(){")).toBe(true);
    expect(THEME_SCRIPT.endsWith("})()")).toBe(true);
  });
});

describe("the script and applyTheme/parseTheme/isDark are the same function", () => {
  it("agree on every combination of stored value and OS setting", () => {
    const stored: Array<string | null> = [null, "light", "dark", "system", "junk", ""];
    for (const s of stored) {
      for (const sys of [true, false]) {
        const scripted = runScript({ stored: s, systemDark: sys });
        const b = fakeBrowser();
        applyTheme(b.html, parseTheme(s), sys);
        expect(scripted.dark, `${JSON.stringify(s)} sys=${sys}`).toBe(b.classes.has("dark"));
        expect(scripted.colorScheme).toBe(b.html.style.colorScheme);
      }
    }
  });
});

describe("parseTheme / isDark / applyTheme", () => {
  it("parseTheme keeps only 'light' and 'dark'; everything else is system", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    for (const v of ["system", "", "Dark", null, undefined, 0, {}, [], true]) expect(parseTheme(v)).toBe("system");
  });
  it("the three choices, in the order the toggle cycles them", () => {
    expect([...THEMES]).toEqual(["system", "light", "dark"]);
  });
  it("isDark: explicit choices ignore the OS; system follows it", () => {
    const cases: Array<[Theme, boolean, boolean]> = [
      ["dark", false, true], ["dark", true, true], ["light", true, false], ["light", false, false], ["system", true, true], ["system", false, false],
    ];
    for (const [t, sys, want] of cases) expect(isDark(t, sys), `${t} ${sys}`).toBe(want);
  });
  it("applyTheme toggles the class idempotently and sets the native color-scheme", () => {
    const b = fakeBrowser();
    applyTheme(b.html, "dark", false);
    applyTheme(b.html, "dark", false);
    expect([...b.classes]).toEqual(["dark"]);
    expect(b.html.style.colorScheme).toBe("dark");
    applyTheme(b.html, "light", true);
    expect([...b.classes]).toEqual([]);
    expect(b.html.style.colorScheme).toBe("light");
  });
});

describe("ThemeScript (the Server Component the layout renders)", () => {
  it("emits the script verbatim with the nonce: React does not escape quotes or operators in script text", () => {
    const html = renderToStaticMarkup(createElement(ThemeScript, { nonce: "abc123" }));
    expect(html).toBe(`<script nonce="abc123">${THEME_SCRIPT}</script>`);
    expect(html).not.toMatch(/&amp;|&quot;|&lt;|&gt;|&#x27;/); // an escaped script would be broken JavaScript
  });
  it("the emitted text, executed, behaves like the script (what the browser would run)", () => {
    const html = renderToStaticMarkup(createElement(ThemeScript, { nonce: "n" }));
    const code = html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>"));
    const b = fakeBrowser({ stored: "dark", systemDark: false });
    runInNewContext(code, b.sandbox);
    expect(b.classes.has("dark")).toBe(true);
  });
  it("without a nonce it renders no nonce attribute", () => {
    expect(renderToStaticMarkup(createElement(ThemeScript, {}))).toBe(`<script>${THEME_SCRIPT}</script>`);
  });
});

const read = (f: string) => readFileSync(f, "utf8");

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p, ext) : ext.test(p) ? [p] : [];
  });
}

describe("the account menu mounts Clerk's UserButton only after hydration", () => {
  it("AppHeader uses the AccountMenu and never imports UserButton itself", () => {
    const header = read("components/dashboard/app-header.tsx");
    expect(header).toContain("<AccountMenu />");
    expect(header).not.toMatch(/UserButton/);
  });
  it("AccountMenu wraps UserButton in AfterMount with a same-size placeholder inside a fixed-size box", () => {
    const src = read("components/clerk/account-menu.tsx");
    expect(src.startsWith('"use client"')).toBe(true);
    expect(src).toMatch(/<AfterMount placeholder=\{<span[^>]*size-8[^>]*rounded-full/);
    expect(src).toContain("<UserButton");
    expect(src).toMatch(/className="flex size-11 [^"]*sm:size-9"/); // 44 px tap target on small screens: one box around placeholder and button
    expect(src).toMatch(/avatarBox: \{ width: "2rem", height: "2rem" \}/); // the real avatar is the placeholder's size
  });
  it("AfterMount is hydration-safe: server snapshot false, so the first client render shows the placeholder", () => {
    const src = read("components/clerk/after-mount.tsx");
    expect(src).toMatch(/useSyncExternalStore\(subscribeNothing, \(\) => true, \(\) => false\)/);
    expect(src).toContain("mounted ? children : placeholder");
  });
  it("renders the placeholder and never the children in the server HTML (a server render uses the server snapshot)", () => {
    // createElement's typings want `children` inside the props; the lint rule wants them as an argument: type the component by its props only
    const Gate = AfterMount as unknown as ComponentType<{ placeholder: ReactNode }>;
    const html = renderToStaticMarkup(createElement(Gate, { placeholder: createElement("i", { id: "ph" }) }, createElement("b", { id: "real" })));
    expect(html).toBe('<i id="ph"></i>');
  });
  it("only the known places render Clerk UI components directly", () => {
    // SignIn and SignUp use the same `clerk.loaded &&` pattern as UserButton but did NOT fail in 24 slow loads, so they are
    // left as they are (see docs/PHASES.md). A new Clerk component anywhere else must go through AfterMount: add it here
    // only together with that.
    const importers = [...walk("app", /\.tsx?$/), ...walk("components", /\.tsx?$/)].filter((p) =>
      /import \{[^}]*\b(UserButton|SignIn|SignUp|OrganizationSwitcher|UserProfile|CreateOrganization|OrganizationProfile)\b[^}]*\} from "@clerk\/nextjs"/.test(read(p)),
    );
    expect(importers.sort()).toEqual(["app/sign-in/[[...sign-in]]/page.tsx", "app/sign-up/[[...sign-up]]/page.tsx", "components/clerk/account-menu.tsx"]);
  });
});
