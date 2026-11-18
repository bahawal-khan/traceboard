import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">TraceBoard</h1>
      <p className="max-w-md text-muted-foreground">
        Observability and trustworthy evaluation for LLM apps and agents. Coming soon.
      </p>
      <div className="flex gap-3">
        <Link className="rounded-md bg-primary px-4 py-2 text-primary-foreground" href="/sign-in">
          Sign in
        </Link>
        <Link className="rounded-md border px-4 py-2" href="/sign-up">
          Sign up
        </Link>
      </div>
    </main>
  );
}
