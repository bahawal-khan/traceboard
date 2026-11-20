# LLM Monitor — Python SDK

Standard library only. Python 3.9+.

```python
from llm_monitor import Monitor

mon = Monitor()   # reads LLM_MONITOR_API_KEY and LLM_MONITOR_URL
mon.track(kind="llm", model="gpt-4o", input_tokens=120, output_tokens=40, latency_ms=830)
```

This is the SDK core: queue, batching, background flush, flush at exit, retries, gzip, hashing and local redaction.
Provider wrappers (`mon.wrap(...)`) and trace context arrive in the next steps.

* **Never raises into your app.** Problems are counted in `mon.stats`. A missing or invalid configuration disables the SDK
  (one `RuntimeWarning` says why; `mon.config_error` has the reason; it never contains your key).
* **Never blocks on the network.** `track()` appends to a bounded in-memory queue (drops the OLDEST event when full).
  A daemon thread sends batches of up to 100 events; the remaining events are sent when the program exits
  (bounded by `exit_flush_timeout_s`, default 2 s).
* **Fork safe.** After `os.fork()` / `multiprocessing` (fork or forkserver) the child starts with an empty queue and its own
  flush thread and never re-sends the parent's events.
* **Survives outages.** A batch that fails for a transient reason (network error, timeout, 408, 429, 5xx) goes back to the
  front of the bounded queue and is retried after an exponential backoff with jitter (`retry_base_s` 1 s, up to
  `retry_max_s` 120 s), never earlier than the server's `Retry-After` (capped at `max_retry_after_s`, 60 s; a daily `quota_exceeded` 429 is honoured up to `max_quota_retry_after_s`, 15 minutes, so a blocked project is not retried every minute all day). Memory stays
  bounded (oldest events are dropped first) and events older than `max_event_age_s` (1 h) are discarded. Permanent
  failures (other 4xx, redirects) drop the batch; a 413 halves it; one event that makes the server fail is isolated and
  dropped after a few attempts. Nothing waits inside a retry loop, so your app never stalls.
* **Small requests.** Batches are split by bytes (about 200 KB) as well as by count (100) and gzip-compressed when large.
  The server's `flush_hint_ms` (clamped to 1-60 s) sets the flush interval.
* **Privacy first.** Pass raw values and the SDK keeps only SHA-256 digests:
  `mon.track(prompt=..., args=..., user_id=...)` sends `prompt_hash`, `args_hash` and `user_id_hash` and forgets the raw
  values (text is normalised first: Unicode NFC, runs of ASCII whitespace become one space, trimmed; structured values
  are hashed as canonical JSON; `hash_salt` turns the user-id hash into a keyed HMAC). Content capture is OFF by default
  (`capture_content=True` to opt in); captured content is redacted locally BEFORE it is queued (secrets, emails, card
  numbers, phone numbers; same rules as the server), then cut to 2 KB. The free-text `error` field is redacted the same
  way, because exception messages often contain emails and ids. Add your own rules with `redactor=my_function` (runs
  first). If redaction fails, the content (or error text) is dropped, never sent raw. A custom redactor must be a
  module-level function if you use multiprocessing with spawn or forkserver; otherwise pickling the Monitor fails loudly.
  Redaction is heuristic and cannot find names or free-text personal data.
* The API key is only sent over https (plain http only to localhost), redirects are never followed, and the key is
  never printed in `repr()`, logs or error labels.

## Development

```bash
cd sdk/python
python3 -m venv .venv                 # kept out of git (.gitignore)
source .venv/bin/activate             # Windows: .venv\Scripts\activate
python -m pip install -e ".[dev]"     # installs pytest; the SDK itself has no dependencies
python -m pytest                      # or, with no extra packages at all:  python -m unittest discover -s tests
```
