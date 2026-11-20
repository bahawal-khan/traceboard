"""Configuration: explicit arguments win over environment variables; invalid configuration disables the SDK, it never raises."""
from __future__ import annotations

import os
import re
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlsplit

ENV_API_KEY = "LLM_MONITOR_API_KEY"
ENV_URL = "LLM_MONITOR_URL"
INGEST_PATH = "/api/ingest"
USER_AGENT_PREFIX = "llm-monitor-python"

# Shape of a key issued by the platform: "lm_" + 43 base64url characters (lib/api-key.ts).
_API_KEY = re.compile(r"[A-Za-z0-9_-]{43}")
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

MAX_BATCH = 100  # server limit (docs/ARCHITECTURE.md section 2)
# The server caps a body at 256,000 bytes compressed AND decompressed; a batch is split by BYTES well below that, because
# content capture can make 100 events exceed it (docs/PHASES.md, P2.7b note).
SERVER_BODY_LIMIT = 256_000
DEFAULT_BATCH_BYTES = 200_000


class Config(object):
    """Validated, immutable-by-convention settings. The API key is held here and nowhere else in the public surface."""

    __slots__ = (
        "api_key", "base_url", "ingest_url", "batch_size", "queue_size", "flush_interval_ms",
        "min_flush_interval_ms", "max_flush_interval_ms", "timeout_s", "exit_flush_timeout_s",
        "capture_content", "allow_insecure_http", "compress", "max_batch_bytes", "retry_base_s", "retry_max_s",
        "max_retry_after_s", "max_quota_retry_after_s", "max_event_age_s",
    )

    def __init__(self, **kw: Any) -> None:
        for name in self.__slots__:
            object.__setattr__(self, name, kw[name])

    def __setattr__(self, name: str, value: Any) -> None:  # pragma: no cover - guard only
        raise AttributeError("Config is read-only")

    def __repr__(self) -> str:  # never shows the key
        return "Config(url=%r, batch_size=%d, queue_size=%d)" % (self.base_url, self.batch_size, self.queue_size)


def _clamp(value: Any, low: float, high: float, default: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return max(low, min(high, v))


def resolve_config(
    api_key: Optional[str] = None,
    url: Optional[str] = None,
    *,
    batch_size: int = MAX_BATCH,
    queue_size: int = 10_000,
    flush_interval_ms: float = 5_000,
    min_flush_interval_ms: float = 1_000,
    max_flush_interval_ms: float = 60_000,
    timeout_s: float = 5.0,
    exit_flush_timeout_s: float = 2.0,
    capture_content: bool = False,
    allow_insecure_http: bool = False,
    compress: bool = True,
    max_batch_bytes: int = DEFAULT_BATCH_BYTES,
    retry_base_s: float = 1.0,
    retry_max_s: float = 120.0,
    max_retry_after_s: float = 60.0,
    max_quota_retry_after_s: float = 900.0,
    max_event_age_s: float = 3_600.0,
) -> Tuple[Optional[Config], Optional[str]]:
    """Returns (config, None) or (None, reason). The reason never contains the API key."""
    key = api_key if api_key is not None else os.environ.get(ENV_API_KEY)
    base = url if url is not None else os.environ.get(ENV_URL)
    if not key:
        return None, "no API key (set %s or pass api_key)" % ENV_API_KEY
    if not isinstance(key, str) or not key.startswith("lm_") or _API_KEY.fullmatch(key[3:]) is None:
        return None, "the API key does not have the expected format"
    if not base or not isinstance(base, str):
        return None, "no server URL (set %s or pass url)" % ENV_URL

    parts = urlsplit(base.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None, "the server URL must be an http(s) URL"
    if parts.username is not None or parts.password is not None:
        return None, "the server URL must not contain credentials"
    if parts.query or parts.fragment:
        return None, "the server URL must not contain a query or fragment"
    if parts.scheme == "http" and parts.hostname not in _LOCAL_HOSTS and not allow_insecure_http:
        # Never send the API key in clear text to a remote host by accident.
        return None, "refusing to send the API key over plain http to a non-local host (use https)"
    try:
        parts.port  # noqa: B018 - raises ValueError for an invalid port
    except ValueError:
        return None, "the server URL has an invalid port"

    base_url = "%s://%s%s" % (parts.scheme, parts.netloc, parts.path.rstrip("/"))
    lo = _clamp(min_flush_interval_ms, 10, 60_000, 1_000)
    hi = _clamp(max_flush_interval_ms, lo, 600_000, 60_000)
    base = _clamp(retry_base_s, 0.001, 60, 1.0)
    retry_after_cap = _clamp(max_retry_after_s, 0, 3_600, 60.0)
    cfg = Config(
        api_key=key,
        base_url=base_url,
        ingest_url=base_url + INGEST_PATH,
        batch_size=int(_clamp(batch_size, 1, MAX_BATCH, MAX_BATCH)),
        queue_size=int(_clamp(queue_size, 1, 100_000, 10_000)),
        flush_interval_ms=_clamp(flush_interval_ms, lo, hi, 5_000),
        min_flush_interval_ms=lo,
        max_flush_interval_ms=hi,
        timeout_s=_clamp(timeout_s, 0.1, 60, 5.0),
        exit_flush_timeout_s=_clamp(exit_flush_timeout_s, 0, 30, 2.0),
        capture_content=bool(capture_content),
        allow_insecure_http=bool(allow_insecure_http),
        compress=bool(compress),
        max_batch_bytes=int(_clamp(max_batch_bytes, 1_000, SERVER_BODY_LIMIT - 6_000, DEFAULT_BATCH_BYTES)),
        retry_base_s=base,
        retry_max_s=_clamp(retry_max_s, base, 3_600, 120.0),
        # The server's Retry-After can be up to a day (daily quota); honouring that would park the background thread.
        max_retry_after_s=retry_after_cap,
        # A daily quota ("quota_exceeded") answers Retry-After until UTC midnight. Retrying every minute or two all day would
        # cost the server one invocation per retry per project, so that one reason is honoured up to a larger cap. It is
        # never smaller than the cap for other errors, and never more than a day.
        max_quota_retry_after_s=_clamp(max_quota_retry_after_s, retry_after_cap, 86_400, max(900.0, retry_after_cap)),
        # Events older than the server's 24 h window are refused (ts_too_old), so 23 h is the useful maximum.
        max_event_age_s=_clamp(max_event_age_s, 1, 82_800, 3_600.0),
    )
    return cfg, None


def settings_for_pickle(**kw: Any) -> Dict[str, Any]:
    return dict(kw)
