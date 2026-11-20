"""Shared test helpers: a local ingest server, a fake transport, polling, and child-process entry points.

The child entry points live here (a normal importable module) so multiprocessing's spawn and forkserver start methods
can import them by name in the child process."""
from __future__ import annotations

import gzip
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional

from llm_monitor._transport import SendResult

API_KEY = "lm_" + "A" * 43


def wait_until(predicate: Callable[[], bool], timeout: float = 5.0, step: float = 0.01) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(step)
    return predicate()


class IngestServer(object):
    """A real HTTP server on 127.0.0.1 that records every request and answers like /api/ingest (or as configured)."""

    def __init__(self, status: int = 202, body: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None,
                 delay: float = 0.0, handler: Optional[Callable[[Dict[str, Any]], Any]] = None, port: int = 0) -> None:
        self.requests: List[Dict[str, Any]] = []
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                wire = self.rfile.read(length)
                raw = wire
                if (self.headers.get("Content-Encoding") or "").lower() == "gzip":
                    try:
                        raw = gzip.decompress(wire)
                    except (OSError, EOFError):
                        raw = b""
                try:
                    parsed = json.loads(raw.decode("utf-8"))
                except ValueError:
                    parsed = None
                record = {"path": self.path, "headers": dict((k.lower(), v) for k, v in self.headers.items()), "body": parsed, "raw": raw,
                          "wire_bytes": len(wire), "pid": os.getpid(), "at": time.monotonic()}
                with outer._lock:
                    outer.requests.append(record)
                if delay:
                    time.sleep(delay)
                st, resp_body, resp_headers = status, body, dict(headers or {})
                if handler is not None:
                    st, resp_body, resp_headers = handler(record)
                if resp_body is None and 200 <= st < 300:
                    n = len((parsed or {}).get("events", []))
                    resp_body = {"accepted": n, "duplicates": 0, "rejected": [], "guard": {"status": "ok", "exceeded": []}, "flush_hint_ms": 10000}
                payload = json.dumps(resp_body if resp_body is not None else {"error": "x"}).encode("utf-8")
                self.send_response(st)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                for k, v in resp_headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)

    def __enter__(self) -> "IngestServer":
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._server.shutdown()
        self._server.server_close()

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d" % self._server.server_address[1]

    def events(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [e for r in self.requests if isinstance(r["body"], dict) for e in r["body"].get("events", [])]

    def names(self) -> List[str]:
        return sorted(str(e.get("name")) for e in self.events())


class FakeTransport(object):
    """Records batches; optionally fails, raises or blocks."""

    def __init__(self, ok: bool = True, raises: Optional[BaseException] = None, delay: float = 0.0, status: int = 503) -> None:
        self.batches: List[List[Dict[str, Any]]] = []
        self.status = status
        self.ok = ok
        self.raises = raises
        self.delay = delay
        self._lock = threading.Lock()
        self.release = threading.Event()
        self.release.set()

    def send(self, events: List[Dict[str, Any]]) -> SendResult:
        self.release.wait(10)
        if self.delay:
            time.sleep(self.delay)
        with self._lock:
            self.batches.append(list(events))
        if self.raises is not None:
            raise self.raises
        if not self.ok:
            return SendResult(False, self.status, None, None, "http_%d" % self.status)
        return SendResult(True, 202, {"accepted": len(events), "duplicates": 0, "rejected": [], "flush_hint_ms": 10000}, None, None)

    def all_events(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [e for b in self.batches for e in b]


# ---- child-process entry points (module level so spawn/forkserver can import them) ---------------------------------
def child_flush_own_event(mon: Any, marker: str, parent_thread_ident: Optional[int]) -> None:
    """The child tracks ONE event and flushes explicitly. It must start with an EMPTY queue (the parent's pending event is
    not shared), and must have a thread of its own (a restarted flush thread) after tracking."""
    started_empty = mon._queue_len() == 0
    mon.track(name=marker, kind="custom")
    own_thread = mon._thread_alive() and mon._thread_ident() != parent_thread_ident
    flushed = mon.flush(timeout=5)
    ok = started_empty and own_thread and flushed and mon.stats["events_tracked"] == 1
    sys.exit(0 if ok else 3 if not started_empty else 4 if not own_thread else 5)


def child_background_delivery(mon: Any, marker: str, wait_s: float) -> None:
    """The child tracks one event with batch_size=1 and NEVER calls flush: only its own restarted background thread can
    deliver it."""
    mon.track(name=marker, kind="custom")
    delivered = wait_until(lambda: mon.stats["batches_sent"] >= 1 and mon._queue_len() == 0, wait_s)
    sys.exit(0 if delivered and mon._thread_alive() else 6)


class ScriptedTransport(object):
    """A transport whose answer is a function of the batch, so a test can model server behaviour precisely."""

    def __init__(self, respond: Callable[[List[Dict[str, Any]]], SendResult]) -> None:
        self.respond = respond
        self.batches: List[List[Dict[str, Any]]] = []
        self._lock = threading.Lock()

    def send(self, events: List[Dict[str, Any]]) -> SendResult:
        with self._lock:
            self.batches.append(list(events))
        return self.respond(events)

    def delivered(self) -> List[Dict[str, Any]]:
        """Events of the batches that were answered with success."""
        with self._lock:
            return [e for b in self.batches if self.respond(b).ok for e in b]


def ok_result(events: List[Dict[str, Any]], hint: Optional[float] = None) -> SendResult:
    body: Dict[str, Any] = {"accepted": len(events), "duplicates": 0, "rejected": []}
    if hint is not None:
        body["flush_hint_ms"] = hint
    return SendResult(True, 202, body, None, None)


def fail_result(status: Optional[int], retry_after: Optional[float] = None) -> SendResult:
    return SendResult(False, status, None, retry_after, None if status is None else "http_%d" % status)


# ---- privacy helpers (module level so they can be pickled for spawn/forkserver children) ----------------------------
def redact_acme(text: str) -> str:
    """A custom redactor: a picklable module-level function."""
    return text.replace("ACME", "[company]")


def child_track_private(mon: Any, user_id: str) -> None:
    """A child process tracks one event with raw private inputs and flushes; the parent checks what reached the server."""
    mon.track(name="private", user_id=user_id, prompt="the secret prompt", content={"input": "ACME mail jane@example.com", "output": "ok"})
    sys.exit(0 if mon.flush(timeout=5) else 7)
