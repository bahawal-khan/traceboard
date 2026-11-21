"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { MEDIA_DARK, THEME_STORAGE_KEY, applyTheme, parseTheme, type Theme } from "@/lib/theme";

/**
 * Client half of the theme: it holds the user's choice, writes it, and keeps the `dark` class in step. It renders NO script
 * (the pre-paint script comes from the server, see components/theme-script.tsx) and no markup of its own.
 *
 * Hydration-safe: the server snapshot is "system", so the first client render equals the server render; the real choice
 * arrives in the re-render right after hydration (useSyncExternalStore). The `dark` class itself was already set by the
 * inline script before React ran, and this provider never changes it during hydration.
 */

// An in-memory copy keeps the choice working when localStorage is blocked (private mode, disabled storage).
let current: Theme | null = null;
const listeners = new Set<() => void>();

function readTheme(): Theme {
  if (current === null) {
    try {
      current = parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      current = "system";
    }
  }
  return current;
}

function writeTheme(theme: Theme): void {
  current = theme;
  try {
    if (theme === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // storage blocked: the in-memory value still applies for this page
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(MEDIA_DARK).matches;
  } catch {
    return false;
  }
}

function applyCurrent(): void {
  applyTheme(document.documentElement, readTheme(), systemPrefersDark());
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab changed the choice: forget the cached value, re-read it, and follow.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== THEME_STORAGE_KEY) return;
    current = null;
    applyCurrent();
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as Theme);

  const setTheme = useCallback((next: Theme) => {
    writeTheme(next);
    applyCurrent();
    listeners.forEach((l) => l());
  }, []);

  useLayoutEffect(() => {
    // React's Strict Mode remount in development resets <html> to the attributes JSX manages, which drops the `dark` class the
    // inline script set (Next.js guide, "Re-applying attributes in development"). Re-apply it before paint. In production
    // this changes nothing: the class is already right.
    applyCurrent();
    // "System" must follow the OS while the page is open.
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia(MEDIA_DARK);
    } catch {
      mq = null;
    }
    const onChange = () => applyCurrent();
    mq?.addEventListener("change", onChange);
    return () => mq?.removeEventListener("change", onChange);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
