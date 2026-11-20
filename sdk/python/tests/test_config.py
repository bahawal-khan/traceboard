import os
import unittest
from unittest import mock

from llm_monitor._config import ENV_API_KEY, ENV_URL, resolve_config
from _helpers import API_KEY


class TestResolveConfig(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop(ENV_API_KEY, None)
        os.environ.pop(ENV_URL, None)

    def test_explicit_arguments(self):
        cfg, err = resolve_config(API_KEY, "https://monitor.example.com/")
        self.assertIsNone(err)
        self.assertEqual(cfg.base_url, "https://monitor.example.com")
        self.assertEqual(cfg.ingest_url, "https://monitor.example.com/api/ingest")
        self.assertEqual((cfg.batch_size, cfg.queue_size, cfg.capture_content), (100, 10_000, False))

    def test_environment_variables_and_explicit_wins(self):
        os.environ[ENV_API_KEY] = API_KEY
        os.environ[ENV_URL] = "https://env.example.com"
        self.assertEqual(resolve_config()[0].base_url, "https://env.example.com")
        self.assertEqual(resolve_config(url="https://arg.example.com")[0].base_url, "https://arg.example.com")

    def test_missing_pieces_disable_with_a_reason_that_never_contains_the_key(self):
        cfg, err = resolve_config(None, "https://x.example.com")
        self.assertIsNone(cfg)
        self.assertIn(ENV_API_KEY, err)
        cfg, err = resolve_config(API_KEY, None)
        self.assertIsNone(cfg)
        self.assertIn(ENV_URL, err)
        for bad_key in ("lm_short", "xx_" + "A" * 43, "lm_" + "A" * 43 + "!", "lm_" + "A" * 44, "SECRET-" + "A" * 43):
            cfg, err = resolve_config(bad_key, "https://x.example.com")
            self.assertIsNone(cfg, bad_key)
            self.assertNotIn(bad_key, err)

    def test_url_rules(self):
        for bad in ("ftp://x.example.com", "not a url", "https://", "https://u:p@x.example.com", "https://x.example.com/?a=b", "https://x.example.com/#f", "https://x.example.com:99999"):
            self.assertIsNone(resolve_config(API_KEY, bad)[0], bad)

    def test_the_key_is_never_sent_over_plain_http_to_a_remote_host(self):
        cfg, err = resolve_config(API_KEY, "http://monitor.example.com")
        self.assertIsNone(cfg)
        self.assertIn("https", err)
        for local in ("http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"):
            self.assertIsNotNone(resolve_config(API_KEY, local)[0], local)
        self.assertIsNotNone(resolve_config(API_KEY, "http://monitor.example.com", allow_insecure_http=True)[0])

    def test_options_are_clamped(self):
        cfg, _ = resolve_config(API_KEY, "https://x.example.com", batch_size=10_000, queue_size=0, flush_interval_ms=1, timeout_s=1000)
        self.assertEqual(cfg.batch_size, 100)
        self.assertEqual(cfg.queue_size, 1)
        self.assertEqual(cfg.flush_interval_ms, 1000)  # the documented 1-60 s range
        self.assertEqual(cfg.timeout_s, 60)
        cfg, _ = resolve_config(API_KEY, "https://x.example.com", flush_interval_ms=10**9)
        self.assertEqual(cfg.flush_interval_ms, 60_000)
        cfg, _ = resolve_config(API_KEY, "https://x.example.com", flush_interval_ms=50, min_flush_interval_ms=20)
        self.assertEqual(cfg.flush_interval_ms, 50)  # the range is configurable (tests use it)
        cfg, _ = resolve_config(API_KEY, "https://x.example.com", batch_size="abc", timeout_s=float("nan"))
        self.assertEqual((cfg.batch_size, cfg.timeout_s), (100, 5.0))

    def test_delivery_options_have_safe_defaults_and_are_clamped(self):
        cfg, _ = resolve_config(API_KEY, "https://x.example.com")
        self.assertEqual((cfg.compress, cfg.max_batch_bytes, cfg.retry_base_s, cfg.retry_max_s, cfg.max_retry_after_s, cfg.max_event_age_s),
                         (True, 200_000, 1.0, 120.0, 60.0, 3600.0))
        self.assertLess(cfg.max_batch_bytes, 256_000)  # the server's body limit
        cfg, _ = resolve_config(API_KEY, "https://x.example.com", max_batch_bytes=10**9, retry_base_s=0, retry_max_s=0, max_retry_after_s=10**9, max_event_age_s=10**9)
        self.assertLess(cfg.max_batch_bytes, 256_000)  # can never be configured past the server limit
        self.assertEqual(cfg.retry_base_s, 0.001)
        self.assertGreaterEqual(cfg.retry_max_s, cfg.retry_base_s)
        self.assertEqual(cfg.max_retry_after_s, 3600)
        self.assertEqual(cfg.max_event_age_s, 82_800)  # 23 h: the server refuses events older than 24 h
        cfg, _ = resolve_config(API_KEY, "https://x.example.com", max_batch_bytes=1, max_event_age_s=0, compress=0)
        self.assertEqual((cfg.max_batch_bytes, cfg.max_event_age_s, cfg.compress), (1_000, 1, False))
        cfg, _ = resolve_config(API_KEY, "https://x.example.com", retry_base_s="x", max_batch_bytes=None, max_event_age_s=float("nan"))
        self.assertEqual((cfg.retry_base_s, cfg.max_batch_bytes, cfg.max_event_age_s), (1.0, 200_000, 3600.0))

    def test_the_quota_retry_after_cap_defaults_to_15_minutes_and_is_never_below_the_normal_cap(self):
        base = "https://x.example.com"
        self.assertEqual(resolve_config(API_KEY, base)[0].max_quota_retry_after_s, 900.0)
        self.assertEqual(resolve_config(API_KEY, base, max_quota_retry_after_s=120)[0].max_quota_retry_after_s, 120)
        self.assertEqual(resolve_config(API_KEY, base, max_quota_retry_after_s=10**9)[0].max_quota_retry_after_s, 86_400)
        self.assertEqual(resolve_config(API_KEY, base, max_quota_retry_after_s=5, max_retry_after_s=60)[0].max_quota_retry_after_s, 60)
        self.assertEqual(resolve_config(API_KEY, base, max_quota_retry_after_s="x")[0].max_quota_retry_after_s, 900.0)
        self.assertEqual(resolve_config(API_KEY, base, max_retry_after_s=3600)[0].max_quota_retry_after_s, 3600)  # raised with the normal cap

    def test_repr_never_shows_the_key(self):
        cfg, _ = resolve_config(API_KEY, "https://x.example.com")
        self.assertNotIn(API_KEY, repr(cfg))
        self.assertNotIn("A" * 20, repr(cfg))
        with self.assertRaises(AttributeError):
            cfg.api_key = "x"


if __name__ == "__main__":
    unittest.main()
