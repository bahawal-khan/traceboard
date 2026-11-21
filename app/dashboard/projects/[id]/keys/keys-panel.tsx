"use client";

import { AlertCircle, Check, Copy, KeyRound, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { formatUtcDate } from "@/lib/format";

interface Key {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const SCOPES = [
  { id: "ingest", label: "ingest", help: "send traces (SDK, OTLP)" },
  { id: "eval", label: "eval", help: "CLI and CI gate" },
] as const;

const MESSAGES: Record<string, string> = {
  limit_reached: "Key limit reached. Revoke a key to create a new one.",
  invalid_request: "Choose at least one scope and keep the name under 60 characters.",
  unauthorized: "Your session expired. Please sign in again.",
  forbidden: "Request blocked. Reload the page and try again.",
  not_found: "That key or project no longer exists.",
};

/** 44 px tap targets on small screens, compact from the sm breakpoint up. */
const TAP = "h-11 sm:h-9";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(url: string, method: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (res.ok) return { ok: true, data };
    return { ok: false, error: MESSAGES[data.error ?? ""] ?? "Something went wrong. Please try again." };
  } catch {
    return { ok: false, error: "Network error. Please try again." };
  }
}

export function KeysPanel({ projectId, initial, limit }: { projectId: string; initial: Key[]; limit: number }) {
  const router = useRouter();
  const [scopes, setScopes] = useState<string[]>(["ingest"]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // The raw key lives only in this state until the user dismisses it. It is never persisted or put in a URL.
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const active = initial.filter((k) => !k.revokedAt).length;
  const base = `/api/dashboard/projects/${projectId}/keys`;

  async function create() {
    setBusy(true);
    setError(null);
    const r = await call<{ secret: string }>(base, "POST", { scopes, name });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setSecret(r.data.secret);
    setCopied(false);
    setName("");
    router.refresh();
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    const r = await call(`${base}/${id}`, "DELETE");
    setBusy(false);
    setConfirmId(null);
    if (!r.ok) return setError(r.error);
    router.refresh();
  }

  return (
    <div className="mt-6 space-y-6">
      {secret && (
        <Alert>
          <TriangleAlert className="text-status-warning" aria-hidden />
          <AlertTitle>Copy your new key now. You will not be able to see it again.</AlertTitle>
          <AlertDescription className="space-y-3">
            <code className="block break-all rounded-md bg-muted p-3 text-sm text-foreground" data-testid="new-key">
              {secret}
            </code>
            <div className="flex flex-wrap gap-2">
              <Button
                className={TAP}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(secret);
                    setCopied(true);
                  } catch {
                    setError("Could not copy automatically. Select the key and copy it manually.");
                  }
                }}
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                {copied ? "Copied" : "Copy key"}
              </Button>
              <Button
                variant="outline"
                className={TAP}
                onClick={() => {
                  setSecret(null);
                  setCopied(false);
                }}
              >
                I have saved it
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <fieldset className="space-y-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10" disabled={busy || active >= limit}>
        <legend className="px-1 text-sm font-medium">New key</legend>
        <div className="space-y-1.5">
          <label htmlFor="key-name" className="text-sm">
            Name <span className="text-muted-foreground">(optional)</span>
          </label>
          <Input
            id="key-name"
            className={TAP}
            placeholder="e.g. production, CI"
            value={name}
            maxLength={60}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1 sm:flex-row sm:gap-6">
          {SCOPES.map((s) => (
            <label key={s.id} className="flex min-h-11 items-center gap-3 text-sm sm:min-h-9">
              <Checkbox
                className="size-5"
                checked={scopes.includes(s.id)}
                onCheckedChange={(checked) => setScopes((cur) => (checked ? [...cur.filter((x) => x !== s.id), s.id] : cur.filter((x) => x !== s.id)))}
              />
              <span>
                <strong>{s.label}</strong> <span className="text-muted-foreground">{s.help}</span>
              </span>
            </label>
          ))}
        </div>
        <Button className={TAP} disabled={busy || active >= limit || scopes.length === 0} onClick={create}>
          <KeyRound aria-hidden />
          {active >= limit ? "Key limit reached" : "Create key"}
        </Button>
      </fieldset>

      {error && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertDescription className="text-destructive">{error}</AlertDescription>
        </Alert>
      )}

      {initial.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No keys yet. Create one to start sending traces.
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {initial.map((k) => (
            <li key={k.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {k.name || <span className="font-mono">{k.prefix}…</span>}{" "}
                  {k.revokedAt && <Badge variant="secondary">revoked</Badge>}
                </p>
                {k.name && <p className="font-mono text-xs text-muted-foreground">{k.prefix}…</p>}
                <p className="text-xs text-muted-foreground">
                  {k.scopes.join(", ")} · created {formatUtcDate(k.createdAt)} ·{" "}
                  {k.lastUsedAt ? `last used ${formatUtcDate(k.lastUsedAt)}` : "never used"}
                </p>
              </div>
              {!k.revokedAt &&
                (confirmId === k.id ? (
                  <Button variant="destructive" className={TAP} disabled={busy} onClick={() => revoke(k.id)}>
                    Confirm revoke
                  </Button>
                ) : (
                  <Button variant="outline" className={TAP} disabled={busy} onClick={() => setConfirmId(k.id)}>
                    Revoke
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
