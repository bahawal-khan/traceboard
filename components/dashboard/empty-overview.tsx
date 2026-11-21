import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { OverviewRange } from "@/lib/dashboard/types";
import { formatInt } from "@/lib/format";
import { QUOTAS } from "@/lib/quotas";

const RANGE_TEXT: Record<OverviewRange, string> = { "24h": "the last 24 hours", "7d": "the last 7 days" };

// Quoted from README.md / sdk/python/README.md. Placeholders only: nothing here is a real key or address.
const ENV_SNIPPET = `export LLM_MONITOR_API_KEY=lm_...
export LLM_MONITOR_URL=https://<your-deployment>`;

const SDK_SNIPPET = `from llm_monitor import Monitor
from llm_monitor.integrations.openai import instrument_openai   # or .anthropic: instrument_anthropic

client = instrument_openai(OpenAI(), Monitor())`;

const OTLP_SNIPPET = `export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://<your-deployment>/api/otlp/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer <your lm_ key>"`;

function Code({ children, label }: { children: string; label: string }) {
  return (
    <pre aria-label={label} className="rounded-lg bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground sm:text-sm">
      <code>{children}</code>
    </pre>
  );
}

/**
 * Shown instead of charts when the selected window has no events at all: zero-filled charts would look like data.
 * `keysHref` is the project's API keys page (absent in the demo, which is never empty).
 */
export function EmptyOverview({ range, basePath, keysHref }: { range: OverviewRange; basePath: string; keysHref?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No events in {RANGE_TEXT[range]}</CardTitle>
        <CardDescription>
          Send your first trace and it appears here. Setup takes about two minutes, and the free plan accepts up to{" "}
          {formatInt(QUOTAS.eventsPerDayPerProject)} events per day.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ol className="list-decimal space-y-4 pl-5 marker:text-muted-foreground">
          <li className="space-y-2">
            <p>Create an API key for this project. It is shown once; copy it then.</p>
            {keysHref ? (
              <Link href={keysHref} className={buttonVariants({ variant: "outline", className: "h-11 px-4 sm:h-9" })}>
                Create an API key
              </Link>
            ) : null}
          </li>
          <li className="space-y-2">
            <p>
              Install the Python SDK from the repository (<code className="text-xs">pip install ./sdk/python</code>, not on PyPI yet) and set two
              environment variables:
            </p>
            <Code label="Environment variables">{ENV_SNIPPET}</Code>
          </li>
          <li className="space-y-2">
            <p>Add three lines around your provider client:</p>
            <Code label="Python SDK setup">{SDK_SNIPPET}</Code>
          </li>
        </ol>

        <div className="space-y-2 border-t pt-4">
          <p className="font-medium">Already use OpenTelemetry?</p>
          <p className="text-sm text-muted-foreground">Point your exporter at this deployment, with no code change:</p>
          <Code label="OpenTelemetry exporter settings">{OTLP_SNIPPET}</Code>
        </div>

        {range === "24h" ? (
          <div className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
            <span>Sent data earlier?</span>
            <Link href={`${basePath}?range=7d`} className={buttonVariants({ variant: "ghost", className: "h-11 px-2 font-medium text-foreground underline underline-offset-4 sm:h-9" })}>
              Look at the last 7 days
            </Link>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
