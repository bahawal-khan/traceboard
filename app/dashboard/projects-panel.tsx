"use client";

import { AlertCircle, FolderPlus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatUtcDate } from "@/lib/format";

interface Project {
  id: string;
  name: string;
  createdAt: string;
}

const MESSAGES: Record<string, string> = {
  limit_reached: "Project limit reached. Delete a project to create a new one.",
  invalid_request: "Please enter a name between 1 and 60 characters.",
  unauthorized: "Your session expired. Please sign in again.",
  forbidden: "Request blocked. Reload the page and try again.",
  not_found: "That project no longer exists.",
};

/** 44 px tap targets on small screens, compact from the sm breakpoint up. */
const TAP = "h-11 sm:h-9";

async function call(url: string, method: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return MESSAGES[data.error ?? ""] ?? "Something went wrong. Please try again.";
  } catch {
    return "Network error. Please try again.";
  }
}

export function ProjectsPanel({ initial, limit }: { initial: Project[]; limit: number }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  async function run(fn: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    const err = await fn();
    setBusy(false);
    if (err) setError(err);
    else router.refresh();
    return err;
  }

  const atLimit = initial.length >= limit;

  return (
    <div className="mt-6 space-y-6">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if ((await run(() => call("/api/dashboard/projects", "POST", { name }))) === null) setName("");
        }}
      >
        <label className="sr-only" htmlFor="new-project">
          New project name
        </label>
        <Input
          id="new-project"
          className={`${TAP} sm:flex-1`}
          placeholder={atLimit ? "Project limit reached" : "New project name"}
          value={name}
          maxLength={60}
          disabled={atLimit || busy}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" className={TAP} disabled={atLimit || busy || name.trim() === ""}>
          <FolderPlus aria-hidden />
          Create project
        </Button>
      </form>

      {error && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertDescription className="text-destructive">{error}</AlertDescription>
        </Alert>
      )}

      {initial.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No projects yet. Create one to get your API key and start sending traces.
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {initial.map((p) => (
            <li key={p.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
              {editing?.id === p.id ? (
                <form
                  className="flex flex-col gap-2 sm:flex-1 sm:flex-row"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if ((await run(() => call(`/api/dashboard/projects/${p.id}`, "PATCH", { name: editing.name }))) === null) setEditing(null);
                  }}
                >
                  <Input
                    aria-label="Project name"
                    className={`${TAP} sm:flex-1`}
                    value={editing.name}
                    maxLength={60}
                    onChange={(e) => setEditing({ id: p.id, name: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <Button type="submit" className={TAP} disabled={busy || editing.name.trim() === ""}>
                      Save
                    </Button>
                    <Button type="button" variant="outline" className={TAP} onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="min-w-0">
                    <Link
                      href={`/dashboard/projects/${p.id}`}
                      className="-my-3 block truncate py-3 font-medium underline-offset-4 hover:underline sm:my-0 sm:py-0"
                      title={p.name}
                    >
                      {p.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">Created {formatUtcDate(p.createdAt)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link href={`/dashboard/projects/${p.id}`} className={buttonVariants({ variant: "outline", className: TAP })}>
                      Overview
                    </Link>
                    <Link href={`/dashboard/projects/${p.id}/keys`} className={buttonVariants({ variant: "outline", className: TAP })}>
                      API keys
                    </Link>
                    <Button variant="outline" className={TAP} disabled={busy} onClick={() => setEditing({ id: p.id, name: p.name })}>
                      Rename
                    </Button>
                    {confirmId === p.id ? (
                      <Button
                        variant="destructive"
                        className={TAP}
                        disabled={busy}
                        onClick={async () => {
                          await run(() => call(`/api/dashboard/projects/${p.id}`, "DELETE"));
                          setConfirmId(null);
                        }}
                      >
                        Confirm delete everything
                      </Button>
                    ) : (
                      <Button variant="outline" className={TAP} disabled={busy} onClick={() => setConfirmId(p.id)}>
                        Delete
                      </Button>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
