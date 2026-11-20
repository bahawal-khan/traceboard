# LLM Monitor — Python SDK

Standard library only. Python 3.9+.

```python
from llm_monitor import Monitor

mon = Monitor()   # reads LLM_MONITOR_API_KEY and LLM_MONITOR_URL
mon.track(kind="llm", model="gpt-4o", input_tokens=120, output_tokens=40, latency_ms=830)
```

This is the SDK core (queue, batching, background flush, flush at exit). Provider wrappers (`mon.wrap(...)`), trace
context, retries, gzip and hashing arrive in the next steps.

* **Never raises into your app.** Problems are counted in `mon.stats`. A missing or invalid configuration disables the SDK
  (one `RuntimeWarning` says why; `mon.config_error` has the reason; it never contains your key).
* **Never blocks on the network.** `track()` appends to a bounded in-memory queue (drops the OLDEST event when full).
  A daemon thread sends batches of up to 100 events; the remaining events are sent when the program exits
  (bounded by `exit_flush_timeout_s`, default 2 s).
* **Fork safe.** After `os.fork()` / `multiprocessing` (fork or forkserver) the child starts with an empty queue and its own
  flush thread and never re-sends the parent's events.
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
