"""Demo traffic for LLM Monitor: a simulated support agent, no provider account needed.

    export LLM_MONITOR_API_KEY=lm_...           # from the dashboard (Project -> API keys)
    export LLM_MONITOR_URL=https://your-app.vercel.app
    python examples/demo.py                      # 12 agent runs, ~1 s

    python examples/demo.py --dry-run            # no key, no network: prints what WOULD be sent
    python examples/demo.py --runs 40 --realtime # slower, with realistic latencies

What it sends (all through the real SDK wrappers, against simulated OpenAI and Anthropic clients):
  * normal runs: an agent span with a retrieval step, a streamed OpenAI call and an Anthropic call (with prompt caching),
    a tool call, and a conversation thread id
  * one run where a tool fails (status "error", the error text is redacted before it leaves the process)
  * one run where the agent LOOPS: it repeats the same tool call with identical arguments, which is exactly the
    pattern the Guard feature stops (the identical `args_hash` values are what it detects)
Prompts are never sent, only hashes. Nothing here calls a real LLM API.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from types import SimpleNamespace as NS
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from llm_monitor import Monitor, observe, set_default_monitor, span, trace  # noqa: E402
from llm_monitor.integrations.anthropic import instrument_anthropic  # noqa: E402
from llm_monitor.integrations.openai import instrument_openai  # noqa: E402

LOOP_REPEATS = 6


# ---- simulated providers (same shapes as the real SDKs; see the wrappers' docs) -------------------------------------------
class _SimClock(object):
    def __init__(self, realtime: bool, rng: random.Random) -> None:
        self.realtime, self.rng = realtime, rng

    def wait(self, lo: float, hi: float) -> None:
        if self.realtime:
            time.sleep(self.rng.uniform(lo, hi))


class _SimOpenAICompletions(object):
    def __init__(self, clock: _SimClock) -> None:
        self.clock = clock

    def create(self, **kw: Any) -> Any:
        rng = self.clock.rng
        prompt_tokens = rng.randint(400, 2500)
        use = NS(prompt_tokens=prompt_tokens, completion_tokens=rng.randint(30, 300), total_tokens=0,
                 prompt_tokens_details=NS(cached_tokens=(prompt_tokens // 2 if rng.random() < 0.4 else 0)))
        model = "gpt-4o-mini-2024-07-18"
        if kw.get("stream"):
            def gen() -> Any:
                yield NS(model=model, usage=None, choices=[NS(delta=NS(role="assistant", content=None, tool_calls=None, refusal=None, function_call=None))])
                self.clock.wait(0.2, 0.5)  # time to first token
                for word in ("Your", " refund", " was", " issued", "."):
                    self.clock.wait(0.01, 0.04)
                    yield NS(model=model, usage=None, choices=[NS(delta=NS(role=None, content=word, tool_calls=None, refusal=None, function_call=None))])
                if (kw.get("stream_options") or {}).get("include_usage"):
                    yield NS(model=model, usage=use, choices=[])

            return gen()
        self.clock.wait(0.3, 0.9)
        return NS(model=model, usage=use, choices=[NS(message=NS(role="assistant", content="Your refund was issued."), finish_reason="stop")])


class SimOpenAI(object):
    def __init__(self, clock: _SimClock) -> None:
        self.chat = NS(completions=_SimOpenAICompletions(clock))


class _SimMessages(object):
    def __init__(self, clock: _SimClock) -> None:
        self.clock = clock

    def create(self, **kw: Any) -> Any:
        rng = self.clock.rng
        self.clock.wait(0.4, 1.2)
        cached = rng.choice([0, 0, 1500, 3000])
        use = NS(input_tokens=rng.randint(30, 400), output_tokens=rng.randint(40, 400),
                 cache_read_input_tokens=cached or None, cache_creation_input_tokens=None if cached else rng.choice([None, 1500]))
        return NS(model="claude-haiku-5-5", usage=use, stop_reason="end_turn", content=[NS(type="text", text="Summary: refund issued.")])


class SimAnthropic(object):
    def __init__(self, clock: _SimClock) -> None:
        self.messages = _SimMessages(clock)


# ---- the demo agent --------------------------------------------------------------------------------------------------------
def build_agent(mon: Any, clock: _SimClock) -> Dict[str, Any]:
    openai_client = instrument_openai(SimOpenAI(clock), mon)
    claude = instrument_anthropic(SimAnthropic(clock), mon)

    @observe("search_docs", kind="retrieval", monitor=mon)
    def search_docs(query: str) -> List[str]:
        clock.wait(0.02, 0.08)
        return ["Refunds are issued within 5 days."]

    @observe("lookup_order", kind="tool", monitor=mon)
    def lookup_order(order_id: str) -> Dict[str, Any]:
        clock.wait(0.02, 0.1)
        return {"id": order_id, "status": "delivered"}

    @observe("flaky_payments_api", kind="tool", monitor=mon)
    def flaky_payments_api(order_id: str) -> None:
        clock.wait(0.02, 0.05)
        raise ConnectionError("payments API unreachable for customer jane.doe@example.com (order %s)" % order_id)

    return {"openai": openai_client, "claude": claude, "search": search_docs, "order": lookup_order, "pay": flaky_payments_api}


def run_demo(mon: Any, runs: int = 12, seed: int = 7, realtime: bool = False) -> Dict[str, int]:
    """Sends `runs` normal agent runs plus one failing run and one looping run. Returns what it did."""
    rng = random.Random(seed)
    clock = _SimClock(realtime, rng)
    a = build_agent(mon, clock)
    messages = [{"role": "system", "content": "You are a support agent."}, {"role": "user", "content": "Where is my refund for order 1042?"}]

    for i in range(runs):
        with trace("support-agent", kind="agent", monitor=mon, thread_id="demo-conv-%d" % (i % 4)):
            a["search"]("refund policy")
            a["order"]("order-%d" % (1000 + i))
            for _ in a["openai"].chat.completions.create(model="gpt-4o-mini", messages=messages, stream=True):
                pass
            a["claude"].messages.create(model="claude-haiku-5-5", max_tokens=200, system="Summarise.", messages=messages[1:])

    with trace("support-agent", kind="agent", monitor=mon, thread_id="demo-conv-failing"):
        a["order"]("order-9")
        try:
            a["pay"]("order-9")
        except ConnectionError:
            pass  # the agent recovers; the failed tool call is already recorded
        a["openai"].chat.completions.create(model="gpt-4o-mini", messages=messages)

    with trace("support-agent (looping)", kind="agent", monitor=mon, thread_id="demo-conv-loop"):
        for _ in range(LOOP_REPEATS):  # the same call, again and again: Guard's loop detector keys on identical args_hash
            a["search"]("refund policy")
            a["openai"].chat.completions.create(model="gpt-4o-mini", messages=messages)
    return {"normal_runs": runs, "failing_runs": 1, "looping_runs": 1}


class _PrintTransport(object):
    """--dry-run: collects batches instead of sending them."""

    def __init__(self) -> None:
        self.events: List[Dict[str, Any]] = []

    def send(self, events: List[Dict[str, Any]]) -> Any:
        from llm_monitor._transport import SendResult
        self.events.extend(events)
        return SendResult(True, 202, {"accepted": len(events), "duplicates": 0, "rejected": [], "flush_hint_ms": 3000}, None, None)


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--runs", type=int, default=12, help="normal agent runs (default 12)")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--realtime", action="store_true", help="sleep for realistic latencies")
    p.add_argument("--dry-run", action="store_true", help="no key or network: print what would be sent")
    p.add_argument("--out", help="with --dry-run: also write the events to this JSON-lines file")
    args = p.parse_args(argv)

    transport = _PrintTransport() if args.dry_run else None
    if args.dry_run:
        mon = Monitor("lm_" + "D" * 43, "https://dry-run.invalid", transport=transport)
    else:
        mon = Monitor()
        if not mon.enabled:
            print("LLM Monitor is not configured (%s)." % mon.config_error)
            print("Set LLM_MONITOR_API_KEY and LLM_MONITOR_URL, or try --dry-run.")
            return 2
    set_default_monitor(mon)
    done = run_demo(mon, runs=max(0, args.runs), seed=args.seed, realtime=args.realtime)
    flushed = mon.flush(10)
    stats = mon.stats
    print("agent runs: %(normal_runs)d normal, %(failing_runs)d with a failing tool, %(looping_runs)d looping" % done)
    print("events tracked: %d, sent: %s, dropped: %d" % (stats.get("events_tracked", 0), stats.get("events_sent", "?"), stats.get("events_dropped_queue_full", 0)))
    if args.dry_run and transport is not None:
        kinds: Dict[str, int] = {}
        for e in transport.events:
            kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
        print("dry run, nothing was sent. events by kind: %s" % json.dumps(kinds, sort_keys=True))
        if args.out:
            with open(args.out, "w", encoding="utf-8") as f:
                for e in transport.events:
                    f.write(json.dumps(e, sort_keys=True) + "\n")
            print("wrote %s" % args.out)
    elif flushed:
        print("done. Open the dashboard: the traces should appear within a few seconds.")
    else:
        print("some events are still queued (the server is slow or unreachable); the SDK will keep retrying while this process lives.")
    mon.shutdown()
    return 0 if (flushed or args.dry_run) else 1


if __name__ == "__main__":
    sys.exit(main())
