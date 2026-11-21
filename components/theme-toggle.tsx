"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme-provider";
import { THEMES, type Theme } from "@/lib/theme";

const LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

/**
 * Cycles System -> Light -> Dark. The choice lives in the browser, so the server (and the first client render) shows
 * "System"; the real one appears right after hydration. A 44 px tap target on small screens.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-11 sm:size-8"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[next]}.`}
      title={`Theme: ${LABEL[theme]}`}
    >
      <Icon aria-hidden />
    </Button>
  );
}
