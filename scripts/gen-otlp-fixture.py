#!/usr/bin/env python3
"""Generates the OTLP protobuf test fixture from the REAL OpenTelemetry Python exporter.   NOT run by CI; the owner runs it.

    python3 scripts/gen-otlp-fixture.py                    # uses this interpreter to create a temporary venv
    python3 scripts/gen-otlp-fixture.py --python python3.12   # pick the interpreter for the venv (needs ensurepip/venv)
    python3 scripts/gen-otlp-fixture.py --version 1.30.0      # pin the OpenTelemetry packages (default: latest)

What it does
  1. creates a temporary virtual environment and pip-installs `opentelemetry-sdk` and
     `opentelemetry-exporter-otlp-proto-http` (the packages that send OTLP/HTTP protobuf);
  2. runs a child script in that venv that builds deterministic spans (fixed ids and timestamps), exports them with the real
     `OTLPSpanExporter` to a local HTTP server on 127.0.0.1, and captures the exact request bytes;
  3. writes  tests/fixtures/otlp/python-traces.pb  (raw body) and  python-traces.meta.json  (versions, headers, the span
     table the test checks against), then deletes the venv.
Commit only those two files. tests/otlp-fixture.test.ts runs against them (it is skipped while they do not exist).

The spans (two traces):
  trace A  invoke_agent support (GenAI agent, root)
             workflow.step (plain internal span: an ANCESTOR of the chat span, kept by the GenAI-only filter)
               chat gpt-4o (GenAI llm: model, tokens, cache read, time to first chunk, conversation id)
             execute_tool search (GenAI tool, status ERROR, an exception event, an email in the message)
  trace B  GET /health (plain HTTP server span: dropped by the GenAI-only filter)
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "tests", "fixtures", "otlp")

CHILD = r'''
import hashlib, json, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from importlib import metadata

from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.id_generator import IdGenerator
from opentelemetry.trace import SpanKind, Status, StatusCode, set_span_in_context

out_pb, out_meta = sys.argv[1], sys.argv[2]
BASE = 1767225600 * 10**9  # 2026-01-01T00:00:00Z in nanoseconds
MS = 10**6

class Ids(IdGenerator):
    """Deterministic ids: the bytes of the fixture never change between runs."""
    def __init__(self):
        self.t = [0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1, 0xB2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2]
        self.n = 0
    def generate_trace_id(self):
        return self.t.pop(0)
    def generate_span_id(self):
        self.n += 1
        return 0x1000 + self.n

captured = []
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        captured.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.send_header("Content-Length", "0")
        self.end_headers()
    def log_message(self, *a):
        pass

server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

provider = TracerProvider(resource=Resource.create({"service.name": "fixture-service"}), id_generator=Ids())
exporter = OTLPSpanExporter(endpoint="http://127.0.0.1:%d/v1/traces" % server.server_port)
provider.add_span_processor(BatchSpanProcessor(exporter, schedule_delay_millis=60_000, max_export_batch_size=512))
tracer = provider.get_tracer("fixture")

def start(name, parent=None, kind=SpanKind.INTERNAL, at=0, attrs=None):
    ctx = set_span_in_context(parent) if parent is not None else None
    return tracer.start_span(name, context=ctx, kind=kind, start_time=BASE + at * MS, attributes=attrs or {})

agent = start("invoke_agent support", kind=SpanKind.INTERNAL, at=0,
              attrs={"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "support"})
step = start("workflow.step", parent=agent, at=100, attrs={"app.step": "plan"})
chat = start("chat gpt-4o", parent=step, kind=SpanKind.CLIENT, at=200, attrs={
    "gen_ai.operation.name": "chat", "gen_ai.provider.name": "openai",
    "gen_ai.request.model": "gpt-4o", "gen_ai.response.model": "gpt-4o-2024-08-06",
    "gen_ai.usage.input_tokens": 1200, "gen_ai.usage.output_tokens": 80, "gen_ai.usage.cache_read.input_tokens": 1024,
    "gen_ai.response.time_to_first_chunk": 0.42, "gen_ai.conversation.id": "conv-9", "gen_ai.request.stream": True,
})
chat.end(end_time=BASE + 1050 * MS)
step.end(end_time=BASE + 2900 * MS)
tool = start("execute_tool search", parent=agent, at=2900, attrs={"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "search"})
tool.record_exception(ValueError("search backend refused bob@example.com"), timestamp=BASE + 2950 * MS)
tool.set_status(Status(StatusCode.ERROR, "search failed for bob@example.com"))
tool.end(end_time=BASE + 3000 * MS)
agent.end(end_time=BASE + 3100 * MS)
plain = start("GET /health", kind=SpanKind.SERVER, at=50,
              attrs={"http.request.method": "GET", "http.route": "/health", "http.response.status_code": 200})
plain.end(end_time=BASE + 55 * MS)

provider.force_flush()
provider.shutdown()
server.shutdown()
if len(captured) != 1:
    sys.exit("expected exactly one export request, got %d" % len(captured))
req = captured[0]

def hexid(n, width):
    return format(n, "0%dx" % (width * 2))

spans = []
for s in (agent, step, chat, tool, plain):
    ctx = s.get_span_context()
    spans.append({
        "name": s.name, "trace_id": hexid(ctx.trace_id, 16), "span_id": hexid(ctx.span_id, 8),
        "parent_span_id": hexid(s.parent.span_id, 8) if s.parent else None,
        "start_unix_nano": s.start_time, "end_unix_nano": s.end_time,
        "status": s.status.status_code.name,
    })
with open(out_pb, "wb") as f:
    f.write(req["body"])
with open(out_meta, "w") as f:
    json.dump({
        "generator": "scripts/gen-otlp-fixture.py",
        "python": sys.version.split()[0],
        "packages": {p: metadata.version(p) for p in ("opentelemetry-sdk", "opentelemetry-exporter-otlp-proto-http", "opentelemetry-proto")},
        "request": {"path": req["path"], "content_type": req["headers"].get("content-type"), "content_encoding": req["headers"].get("content-encoding"),
                    "bytes": len(req["body"]), "sha256": hashlib.sha256(req["body"]).hexdigest()},
        "base_unix_nano": BASE, "service_name": "fixture-service", "spans": spans,
    }, f, indent=2, sort_keys=True)
    f.write("\n")
print("captured %d bytes, content-type %s" % (len(req["body"]), req["headers"].get("content-type")))
'''


def run(cmd, **kw):
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True, **kw)


def main():
    ap = argparse.ArgumentParser(description="Generate the OTLP protobuf fixture with the real Python exporter.")
    ap.add_argument("--python", default=sys.executable, help="interpreter used to create the temporary venv")
    ap.add_argument("--version", help="pin opentelemetry-sdk and the exporter to this version (default: latest)")
    ap.add_argument("--out-dir", default=DEFAULT_OUT)
    ap.add_argument("--keep-venv", action="store_true", help="do not delete the temporary venv (for debugging)")
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    work = tempfile.mkdtemp(prefix="otlp-fixture-")
    try:
        venv = os.path.join(work, "venv")
        run([args.python, "-m", "venv", venv])
        py = os.path.join(venv, "Scripts" if os.name == "nt" else "bin", "python")
        pin = "==" + args.version if args.version else ""
        run([py, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "opentelemetry-sdk" + pin, "opentelemetry-exporter-otlp-proto-http" + pin])
        child = os.path.join(work, "child.py")
        with open(child, "w") as f:
            f.write(CHILD)
        pb = os.path.join(args.out_dir, "python-traces.pb")
        meta = os.path.join(args.out_dir, "python-traces.meta.json")
        run([py, "-I", child, pb, meta], cwd=work)
        print("wrote", pb)
        print("wrote", meta)
        print("Commit only these two files. Then: npx vitest run tests/otlp-fixture.test.ts")
    finally:
        if args.keep_venv:
            print("venv kept at", work)
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
