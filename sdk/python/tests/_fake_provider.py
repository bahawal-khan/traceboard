"""A local HTTP server that speaks just enough of the OpenAI and Anthropic wire formats for the REAL client packages.

No network, no API keys: the real `openai` / `anthropic` SDKs are pointed at 127.0.0.1 (base_url) and the server answers with
scripted replies, so the wrappers are exercised against what the real packages actually parse (pydantic models, SSE decoding,
retries, exceptions), not against hand-made look-alikes. Standard library only.

A reply is one of `Json`, `Sse` or `Drop`; the server pops the next scripted reply per request and records every request
(path, headers, parsed JSON body) so tests can assert what the wrapper sent (for example the injected `stream_options`)."""
from __future__ import annotations

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Sequence, Tuple


class Json(object):
    def __init__(self, body: Any, status: int = 200, headers: Optional[Dict[str, str]] = None, delay: float = 0.0) -> None:
        self.body, self.status, self.headers, self.delay = body, status, headers or {}, delay


class Sse(object):
    """`events` is a list of (event_name_or_None, data) pairs; data is a dict (sent as JSON) or a str (sent verbatim).
    `delays[i]` seconds are slept BEFORE event i (this is what makes time-to-first-token measurable).
    `cut_after` closes the connection after that many events WITHOUT the terminating chunk: the client sees a truncated chunked
    body (httpx raises a protocol error), i.e. a real mid-stream network failure."""

    def __init__(self, events: Sequence[Tuple[Optional[str], Any]], delays: Optional[Dict[int, float]] = None, cut_after: Optional[int] = None) -> None:
        self.events, self.delays, self.cut_after = list(events), delays or {}, cut_after


class Drop(object):
    """Accept the request, then close the connection without answering (a connection-level failure)."""


class ProviderServer(object):
    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.replies: List[Any] = []
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"  # streams are chunk-encoded, so a cut connection is a REAL protocol error for the client

            def _finish(self) -> None:
                self.close_connection = True

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                try:
                    body = json.loads(raw.decode("utf-8")) if raw else None
                except ValueError:
                    body = None
                with outer._lock:
                    outer.requests.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
                    reply = outer.replies.pop(0) if outer.replies else Json({"error": {"message": "no scripted reply", "type": "server_error"}}, status=500)
                if isinstance(reply, Drop):
                    self._finish()
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                if isinstance(reply, Json):
                    if reply.delay:
                        time.sleep(reply.delay)
                    payload = json.dumps(reply.body).encode("utf-8")
                    self.send_response(reply.status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.send_header("Connection", "close")
                    for k, v in reply.headers.items():
                        self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(payload)
                    self._finish()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    for i, (name, data) in enumerate(reply.events):
                        if reply.cut_after is not None and i >= reply.cut_after:
                            self._finish()
                            self.connection.shutdown(socket.SHUT_RDWR)  # no terminating chunk: the client sees a truncated body
                            return
                        if reply.delays.get(i):
                            time.sleep(reply.delays[i])
                        text = data if isinstance(data, str) else json.dumps(data)
                        frame = (("event: %s\n" % name if name else "") + "data: %s\n\n" % text).encode("utf-8")
                        self.wfile.write(b"%x\r\n%s\r\n" % (len(frame), frame))
                        self.wfile.flush()
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except OSError:
                    pass  # the client went away
                self._finish()

            def log_message(self, *args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self._thread.start()

    @property
    def base(self) -> str:
        return "http://127.0.0.1:%d" % self.port

    def script(self, *replies: Any) -> "ProviderServer":
        with self._lock:
            self.replies.extend(replies)
        return self

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(5)

    def __enter__(self) -> "ProviderServer":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# ---- OpenAI wire format ------------------------------------------------------------------------------------------------

def openai_usage(prompt: int, completion: int, cached: Optional[int] = None) -> Dict[str, Any]:
    u: Dict[str, Any] = {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}
    if cached is not None:
        u["prompt_tokens_details"] = {"cached_tokens": cached}
    return u


def openai_completion(text: str = "4", model: str = "gpt-4o-2024-08-06", prompt: int = 12, completion: int = 3, cached: Optional[int] = None) -> Dict[str, Any]:
    return {
        "id": "chatcmpl-test", "object": "chat.completion", "created": 1_700_000_000, "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        "usage": openai_usage(prompt, completion, cached),
    }


def _chunk(model: str, delta: Dict[str, Any], finish: Optional[str] = None) -> Dict[str, Any]:
    return {"id": "chatcmpl-test", "object": "chat.completion.chunk", "created": 1_700_000_000, "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}


def openai_stream(pieces: Sequence[str] = ("Hel", "lo"), model: str = "gpt-4o-2024-08-06", prompt: int = 12, completion: int = 2,
                  cached: Optional[int] = None, usage: bool = True, first_delay: float = 0.0, cut_after: Optional[int] = None) -> Sse:
    """role-only chunk, content chunks, a finish chunk, optionally the usage-only chunk (empty choices), then [DONE].
    `first_delay` is slept before the first CONTENT chunk (the role-only chunk is sent at once)."""
    events: List[Tuple[Optional[str], Any]] = [(None, _chunk(model, {"role": "assistant", "content": ""}))]
    events += [(None, _chunk(model, {"content": p})) for p in pieces]
    events.append((None, _chunk(model, {}, finish="stop")))
    if usage:
        events.append((None, {"id": "chatcmpl-test", "object": "chat.completion.chunk", "created": 1_700_000_000, "model": model,
                              "choices": [], "usage": openai_usage(prompt, completion, cached)}))
    events.append((None, "[DONE]"))
    return Sse(events, delays={1: first_delay} if first_delay else None, cut_after=cut_after)


# ---- Anthropic wire format ---------------------------------------------------------------------------------------------

def anthropic_usage(input_tokens: int, output_tokens: int, cache_read: Optional[int] = None, cache_creation: Optional[int] = None) -> Dict[str, Any]:
    u: Dict[str, Any] = {"input_tokens": input_tokens, "output_tokens": output_tokens}
    if cache_read is not None:
        u["cache_read_input_tokens"] = cache_read
    if cache_creation is not None:
        u["cache_creation_input_tokens"] = cache_creation
    return u


def anthropic_message(text: str = "4", model: str = "claude-sonnet-5-5", input_tokens: int = 12, output_tokens: int = 3,
                      cache_read: Optional[int] = None, cache_creation: Optional[int] = None) -> Dict[str, Any]:
    return {
        "id": "msg_test", "type": "message", "role": "assistant", "model": model,
        "content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "stop_sequence": None,
        "usage": anthropic_usage(input_tokens, output_tokens, cache_read, cache_creation),
    }


def anthropic_stream(pieces: Sequence[str] = ("Hel", "lo"), model: str = "claude-sonnet-5-5", input_tokens: int = 12, output_tokens: int = 2,
                     cache_read: Optional[int] = None, cache_creation: Optional[int] = None, first_delay: float = 0.0,
                     cut_after: Optional[int] = None) -> Sse:
    """message_start (usage with the input side), a text block with deltas, message_delta (cumulative output tokens), message_stop.
    `first_delay` is slept before the first text delta; message_start and the empty block start are sent at once."""
    start_usage = anthropic_usage(input_tokens, 1, cache_read, cache_creation)
    events: List[Tuple[Optional[str], Any]] = [
        ("message_start", {"type": "message_start", "message": {
            "id": "msg_test", "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None,
            "stop_sequence": None, "usage": start_usage}}),
        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    ]
    first_delta = len(events)
    events += [("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": p}}) for p in pieces]
    events += [
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": output_tokens}}),
        ("message_stop", {"type": "message_stop"}),
    ]
    return Sse(events, delays={first_delta: first_delay} if first_delay else None, cut_after=cut_after)
