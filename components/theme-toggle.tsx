"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

const ORDER = ["system", "light", "dark"] as const;
type Choice = (typeof ORDER)[number];
const LABEL: Record<Choice, string> = { system: "System", light: "Light", dark: "Dark" };

const noopSubscribe = () => () => {};

/** Cycles System -> Light -> Dark. The real choice is only known in the browser, so the server renders a neutral button. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const current: Choice = mounted && (theme === "light" || theme === "dark") ? theme : "system";
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  const Icon = current === "dark" ? Moon : current === "light" ? Sun : Monitor;

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-11 sm:size-8"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${LABEL[current]}. Switch to ${LABEL[next]}.`}
      title={`Theme: ${LABEL[current]}`}
    >
      <Icon aria-hidden />
    </Button>
  );
}
