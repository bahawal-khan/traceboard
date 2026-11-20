"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";

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
        <input
          id="new-project"
          className="h-11 flex-1 rounded-md border bg-background px-3 text-base"
          placeholder={atLimit ? "Project limit reached" : "New project name"}
          value={name}
          maxLength={60}
          disabled={atLimit || busy}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" className="h-11" disabled={atLimit || busy || name.trim() === ""}>
          Create project
        </Button>
      </form>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {initial.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No projects yet. Create one to get your API key and start sending traces.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {initial.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
              {editing?.id === p.id ? (
                <form
                  className="flex flex-1 flex-col gap-2 sm:flex-row"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if ((await run(() => call(`/api/dashboard/projects/${p.id}`, "PATCH", { name: editing.name }))) === null) setEditing(null);
                  }}
                >
                  <input
                    aria-label="Project name"
                    className="h-11 flex-1 rounded-md border bg-background px-3 text-base"
                    value={editing.name}
                    maxLength={60}
                    onChange={(e) => setEditing({ id: p.id, name: e.target.value })}
                  />
                  <Button type="submit" className="h-11" disabled={busy || editing.name.trim() === ""}>
                    Save
                  </Button>
                  <Button type="button" variant="outline" className="h-11" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <div className="min-w-0">
                    <Link href={`/dashboard/projects/${p.id}`} className="block truncate font-medium underline-offset-4 hover:underline">
                      {p.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">Created {new Date(p.createdAt).toLocaleDateString()}</p>
                  </div>
                  <div className="flex gap-2">
                    <Link href={`/dashboard/projects/${p.id}`} className={buttonVariants({ variant: "outline", className: "h-11" })}>
                      API keys
                    </Link>
                    <Button variant="outline" className="h-11" disabled={busy} onClick={() => setEditing({ id: p.id, name: p.name })}>
                      Rename
                    </Button>
                    {confirmId === p.id ? (
                      <Button
                        variant="destructive"
                        className="h-11"
                        disabled={busy}
                        onClick={async () => {
                          await run(() => call(`/api/dashboard/projects/${p.id}`, "DELETE"));
                          setConfirmId(null);
                        }}
                      >
                        Confirm delete everything
                      </Button>
                    ) : (
                      <Button variant="outline" className="h-11" disabled={busy} onClick={() => setConfirmId(p.id)}>
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
