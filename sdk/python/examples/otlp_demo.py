#!/usr/bin/env python3
"""Sends a few GenAI spans through a REAL OpenTelemetry exporter to the OTLP endpoint. The point: the app side needs NO
llm_monitor code and NO key handling, only the standard OpenTelemetry exporter environment variables.

    pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http      # NOT dependencies of the llm-monitor SDK
    export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://<your-app>/api/otlp/v1/traces"
    export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer <your lm_ key>"   # put these in .env.local, never in shell history
    python sdk/python/examples/otlp_demo.py

The Python OTLP/HTTP exporter always sends protobuf (verified: OTEL_EXPORTER_OTLP_PROTOCOL=http/json does not change it). The
server also accepts OTLP/JSON, for exporters that send it (for example the JavaScript ones) and for plain HTTP clients.
Output: a summary only. The key and the headers are never printed.

Spans sent: one trace with an agent span, a plain step span (an ancestor, kept), a chat span with token usage and cache tokens,
and a tool span that fails; and one plain HTTP span, which the server's GenAI-only filter drops (OTLP_GENAI_ONLY, default on).
"""
from __future__ import annotations

import os
import sys
import time

REQUIRED = ("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS")


def main() -> int:
    missing = [name for name in REQUIRED if not os.environ.get(name)]
    if missing:
        print("Missing environment variables: %s (names only; see the module docstring)." % ", ".join(missing), file=sys.stderr)
        return 2
    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.trace import SpanKind, Status, StatusCode
    except ImportError:
        print("Install the exporter first: pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http", file=sys.stderr)
        return 2

    provider = TracerProvider(resource=Resource.create({"service.name": "otlp-e2e-demo"}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))  # no arguments: endpoint and headers come from the environment
    tracer = provider.get_tracer("otlp-e2e-demo")

    with tracer.start_as_current_span("invoke_agent support", attributes={"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "support"}):
        with tracer.start_as_current_span("workflow.step", attributes={"app.step": "plan"}):
            with tracer.start_as_current_span("chat gpt-4o", kind=SpanKind.CLIENT, attributes={
                "gen_ai.operation.name": "chat", "gen_ai.provider.name": "openai",
                "gen_ai.request.model": "gpt-4o", "gen_ai.response.model": "gpt-4o-2024-08-06",
                "gen_ai.usage.input_tokens": 1200, "gen_ai.usage.output_tokens": 80, "gen_ai.usage.cache_read.input_tokens": 1024,
                "gen_ai.conversation.id": "otlp-e2e-1",
            }):
                time.sleep(0.05)
        with tracer.start_as_current_span("execute_tool search", attributes={"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "search"}) as tool:
            tool.set_status(Status(StatusCode.ERROR, "search failed"))
            time.sleep(0.02)
    with tracer.start_as_current_span("GET /health", kind=SpanKind.SERVER, attributes={"http.request.method": "GET", "http.route": "/health"}):
        pass

    ok = provider.force_flush(10_000)
    provider.shutdown()
    print("export %s (protobuf over HTTP); 5 spans sent: 4 GenAI-related (agent, step, chat, tool) + 1 plain HTTP span" % ("succeeded" if ok else "FAILED"))
    print("expected stored events: 4 (the HTTP span is dropped by the default GenAI-only filter)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
