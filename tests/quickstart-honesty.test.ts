import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyOverview } from "@/components/dashboard/empty-overview";

/**
 * The quickstart text a new user copies must match the REAL code. Each instruction is tied to the file that defines it, so
 * renaming an environment variable, a module, a route or the demo breaks this test instead of the user's first five minutes.
 */
const read = (p: string) => readFileSync(p, "utf8");
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const markup = decode(renderToStaticMarkup(createElement(EmptyOverview, { range: "24h", basePath: "/dashboard/projects/p1", keysHref: "/dashboard/projects/p1/keys" })));

describe("quickstart: every copyable instruction is true for the current code", () => {
  const config = read("sdk/python/llm_monitor/_config.py");

  it("the environment variable names are the ones the SDK reads", () => {
    expect(config).toContain('ENV_API_KEY = "LLM_MONITOR_API_KEY"');
    expect(config).toContain('ENV_URL = "LLM_MONITOR_URL"');
    expect(markup).toContain("export LLM_MONITOR_API_KEY=lm_...");
    expect(markup).toContain("export LLM_MONITOR_URL=https://<your-deployment>");
  });

  it("the URL is a base address: the SDK appends the ingest path and the ingest route exists there", () => {
    expect(config).toContain('INGEST_PATH = "/api/ingest"');
    expect(existsSync("app/api/ingest/route.ts")).toBe(true);
    expect(markup).not.toMatch(/LLM_MONITOR_URL=\S*\/api\//);
    expect(markup).toContain("without any path");
  });

  it("the SDK snippet runs as pasted: every name it uses is imported, and the modules and functions exist", () => {
    expect(markup).toContain("from openai import OpenAI");
    expect(markup).toContain("from llm_monitor import Monitor");
    expect(markup).toContain("from llm_monitor.integrations.openai import instrument_openai");
    expect(markup).toContain("client = instrument_openai(OpenAI(), Monitor())");
    expect(read("sdk/python/llm_monitor/integrations/openai.py")).toContain("def instrument_openai(");
    expect(read("sdk/python/llm_monitor/integrations/anthropic.py")).toContain("def instrument_anthropic(");
    expect(read("sdk/python/llm_monitor/__init__.py")).toMatch(/\bMonitor\b/);
  });

  it("the install line is the local one and still says it is not on PyPI", () => {
    expect(markup).toContain("pip install ./sdk/python");
    expect(markup).toContain("not on PyPI yet");
    expect(existsSync("sdk/python/pyproject.toml")).toBe(true);
  });

  it("the demo command points at a file that exists", () => {
    expect(markup).toContain("python sdk/python/examples/demo.py");
    expect(existsSync("sdk/python/examples/demo.py")).toBe(true);
  });

  it("the OpenTelemetry settings use the real route and the standard exporter variables", () => {
    expect(markup).toContain("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://<your-deployment>/api/otlp/v1/traces");
    expect(existsSync("app/api/otlp/v1/traces/route.ts")).toBe(true);
    expect(markup).toContain('OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer <your lm_ key>"');
  });

  it("shows no real key, no key in a URL, and makes no timing promise it has not measured", () => {
    expect(markup).not.toMatch(/lm_[A-Za-z0-9_-]{8,}/);
    expect(markup).not.toMatch(/https?:\/\/[^\s"<]*[?&](key|api_key|token)=/i);
    expect(markup).not.toMatch(/\b\d+\s*(s|sec|seconds)\b.*first trace|first trace.*\b\d+\s*(s|sec|seconds)\b/i);
  });
});
