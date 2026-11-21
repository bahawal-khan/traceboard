/**
 * Theme logic shared by the inline pre-paint script (server-rendered in the root layout) and the client provider.
 * Pure: no React, no DOM globals, so it is unit tested.
 *
 * The choice is "system" (follow prefers-color-scheme), "light" or "dark". "system" is stored as NO value; anything that
 * is not exactly "light" or "dark" (a missing key, a stale value, garbage) means "system".
 */

export const THEME_STORAGE_KEY = "theme";
export const MEDIA_DARK = "(prefers-color-scheme: dark)";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function parseTheme(raw: unknown): Theme {
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function isDark(theme: Theme, systemDark: boolean): boolean {
  return theme === "dark" || (theme === "system" && systemDark);
}

/** The bits of <html> the theme touches (structural, so tests can pass a fake). */
export interface ThemeTarget {
  classList: { toggle(name: string, force?: boolean): boolean };
  style: { colorScheme: string };
}

/** Sets the `dark` class (what Tailwind's `dark:` variant and our CSS variables key on) and the native `color-scheme`. */
export function applyTheme(target: ThemeTarget, theme: Theme, systemDark: boolean): void {
  const dark = isDark(theme, systemDark);
  target.classList.toggle("dark", dark);
  target.style.colorScheme = dark ? "dark" : "light";
}

/**
 * The inline script that runs while the browser parses <head>, before the first paint, so a reload never flashes the wrong
 * theme. It must do exactly what `parseTheme` + `applyTheme` do (a test runs both against the same inputs).
 *
 * It is rendered as the TEXT CHILD of a <script nonce> in a Server Component (components/theme-script.tsx): React emits
 * script text verbatim (checked on React 19.3), so quotes and operators are safe here and no `dangerouslySetInnerHTML`
 * is needed. Storage and matchMedia are read in separate try blocks: a blocked localStorage must still honour the OS setting.
 */
export const THEME_SCRIPT =
  `(function(){var d=document.documentElement,t=null,m=false;` +
  `try{t=localStorage.getItem("${THEME_STORAGE_KEY}")}catch(e){}` +
  `try{m=window.matchMedia("${MEDIA_DARK}").matches}catch(e){}` +
  `var k=t==="dark"||(t!=="light"&&m);` +
  `try{d.classList.toggle("dark",k);d.style.colorScheme=k?"dark":"light"}catch(e){}})()`;
