"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Copies a short value (a trace id) to the clipboard. Clipboard access can be refused (permissions, insecure context), so a
 * failure says so in words instead of failing silently; the value is also shown in full elsewhere on the page.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-11 gap-2 px-3 sm:h-9"
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
        <span>{state === "copied" ? "Copied" : "Copy"}</span>
      </Button>
      <span role="status" className="sr-only">
        {state === "copied" ? "Copied to the clipboard" : state === "failed" ? "Could not copy. Select the id and copy it manually." : ""}
      </span>
      {state === "failed" ? <span className="text-xs text-muted-foreground">Could not copy. Select the id and copy it manually.</span> : null}
    </>
  );
}
