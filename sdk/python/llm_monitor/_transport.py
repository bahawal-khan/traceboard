"""HTTP transport: one POST of a batch to /api/ingest, standard library only, never raises."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

MAX_RESPONSE_BYTES = 1_000_000


class SendResult(object):
    """Outcome of one send. `error` is a short class-like label, never a payload, a header or a key."""

    __slots__ = ("ok", "status", "body", "retry_after_s", "error")

    def __init__(self, ok: bool, status: Optional[int] = None, body: Optional[Dict[str, Any]] = None,
                 retry_after_s: Optional[float] = None, error: Optional[str] = None) -> None:
        self.ok = ok
        self.status = status
        self.body = body
        self.retry_after_s = retry_after_s
        self.error = error

    def __repr__(self) -> str:
        return "SendResult(ok=%r, status=%r, error=%r)" % (self.ok, self.status, self.error)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: urllib would resend the Authorization header to the new location."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def _retry_after(headers: Any) -> Optional[float]:
    try:
        raw = headers.get("Retry-After") if headers is not None else None
        if raw is None:
            return None
        value = float(str(raw).strip())
        return value if value >= 0 else None
    except (TypeError, ValueError):
        return None


class HttpTransport(object):
    def __init__(self, ingest_url: str, api_key: str, timeout_s: float, user_agent: str) -> None:
        self._url = ingest_url
        self._key = api_key
        self._timeout = timeout_s
        self._ua = user_agent
        self._opener = urllib.request.build_opener(_NoRedirect)

    def __repr__(self) -> str:  # the key is never shown
        return "HttpTransport(url=%r)" % self._url

    def send(self, events: List[Dict[str, Any]]) -> SendResult:
        try:
            data = json.dumps({"events": events}, separators=(",", ":")).encode("utf-8")  # ASCII-escaped: always valid UTF-8
            request = urllib.request.Request(
                self._url,
                data=data,
                method="POST",
                headers={
                    "Authorization": "Bearer " + self._key,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": self._ua,
                },
            )
            try:
                with self._opener.open(request, timeout=self._timeout) as response:
                    status = response.status
                    raw = response.read(MAX_RESPONSE_BYTES + 1)
                    headers = response.headers
            except urllib.error.HTTPError as err:  # 3xx (redirects are not followed), 4xx, 5xx
                try:
                    raw = err.read(MAX_RESPONSE_BYTES + 1)
                except Exception:
                    raw = b""
                finally:
                    err.close()  # the error object owns the response; leaving it open leaks a descriptor per failed send
                return SendResult(False, err.code, _parse(raw), _retry_after(err.headers), "http_%d" % err.code)
            body = _parse(raw)
            ok = 200 <= status < 300
            return SendResult(ok, status, body, _retry_after(headers), None if ok else "http_%d" % status)
        except urllib.error.URLError as err:
            return SendResult(False, None, None, None, "network:" + type(err.reason).__name__)
        except Exception as err:  # timeouts, resets, TLS errors, anything else: a label only, never the message
            return SendResult(False, None, None, None, "error:" + type(err).__name__)


def _parse(raw: bytes) -> Optional[Dict[str, Any]]:
    if not raw or len(raw) > MAX_RESPONSE_BYTES:
        return None
    try:
        value = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return None
    return value if isinstance(value, dict) else None
