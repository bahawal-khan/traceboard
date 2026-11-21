"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * Class-based theme (`.dark` on <html>, matching the Tailwind `dark` variant in globals.css). The pre-paint script that
 * next-themes injects carries the per-request CSP nonce (passed from the root layout), so it runs under our strict CSP
 * and sets the class before the first paint: no flash on reload. Default is the OS setting; a click stores the choice
 * in localStorage (key `theme`).
 */
export function ThemeProvider(props: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props} />;
}
