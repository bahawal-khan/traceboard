import gc
import socket
import time
import unittest
import warnings

from llm_monitor._transport import HttpTransport, SendResult
from _helpers import API_KEY, IngestServer


def transport_for(server, timeout=2.0):
    return HttpTransport(server.url + "/api/ingest", API_KEY, timeout, "llm-monitor-python/test")


EVENT = {"event_id": "3f0c1b2e-8a64-4d1f-9c7e-5b2a6d9e1f40", "ts": "2026-11-20T12:00:00.000Z", "kind": "llm", "status": "ok", "name": "hello"}


class TestHttpTransport(unittest.TestCase):
    def test_posts_json_with_bearer_auth(self):
        with IngestServer() as server:
            result = transport_for(server).send([EVENT, dict(EVENT, name="two")])
            self.assertTrue(result.ok)
            self.assertEqual(result.status, 202)
            self.assertEqual(result.body["accepted"], 2)
            (req,) = server.requests
            self.assertEqual(req["path"], "/api/ingest")
            self.assertEqual(req["headers"]["authorization"], "Bearer " + API_KEY)
            self.assertEqual(req["headers"]["content-type"], "application/json")
            self.assertTrue(req["headers"]["user-agent"].startswith("llm-monitor-python/"))
            self.assertEqual([e["name"] for e in req["body"]["events"]], ["hello", "two"])

    def test_non_ascii_text_survives(self):
        with IngestServer() as server:
            transport_for(server).send([dict(EVENT, name="héllo \U0001F600 日本語")])
            self.assertEqual(server.events()[0]["name"], "héllo \U0001F600 日本語")

    def test_error_statuses_are_results_not_exceptions(self):
        for status in (400, 401, 403, 413, 422, 500, 503):
            with IngestServer(status=status, body={"error": "x", "requestId": "r"}) as server:
                r = transport_for(server).send([EVENT])
                self.assertFalse(r.ok, status)
                self.assertEqual((r.status, r.error), (status, "http_%d" % status))
                self.assertEqual(r.body["error"], "x")

    def test_retry_after_is_parsed(self):
        with IngestServer(status=429, body={"error": "rate_limited"}, headers={"Retry-After": "7"}) as server:
            self.assertEqual(transport_for(server).send([EVENT]).retry_after_s, 7.0)
        with IngestServer(status=429, body={"error": "rate_limited"}, headers={"Retry-After": "soon"}) as server:
            self.assertIsNone(transport_for(server).send([EVENT]).retry_after_s)

    def test_redirects_are_not_followed_so_the_key_cannot_leak_to_another_location(self):
        with IngestServer(handler=lambda rec: (302, {"moved": True}, {"Location": "/somewhere-else"})) as server:
            r = transport_for(server).send([EVENT])
            self.assertFalse(r.ok)
            self.assertEqual(r.status, 302)
            self.assertEqual(len(server.requests), 1)  # no second request, with or without the Authorization header

    def test_connection_refused_is_a_result_with_a_label_only(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()  # nothing listens here now
        r = HttpTransport("http://127.0.0.1:%d/api/ingest" % port, API_KEY, 1.0, "ua").send([EVENT])
        self.assertFalse(r.ok)
        self.assertIsNone(r.status)
        self.assertRegex(r.error, r"^(network|error):")
        self.assertNotIn(API_KEY, repr(r))
        self.assertNotIn(API_KEY, r.error)

    def test_timeout_returns_in_time(self):
        with IngestServer(delay=1.5) as server:
            started = time.monotonic()
            r = transport_for(server, timeout=0.3).send([EVENT])
            self.assertLess(time.monotonic() - started, 1.2)
            self.assertFalse(r.ok)
            self.assertIsNotNone(r.error)

    def test_an_unparseable_or_huge_answer_does_not_break_a_successful_send(self):
        with IngestServer(handler=lambda rec: (202, None, {})) as server:
            self.assertTrue(transport_for(server).send([EVENT]).ok)
        big = {"pad": "x" * 1_200_000}
        with IngestServer(status=202, body=big) as server:
            r = transport_for(server).send([EVENT])
            self.assertTrue(r.ok)
            self.assertIsNone(r.body)  # the oversized answer is ignored, not parsed

    def test_failed_sends_do_not_leak_responses(self):
        with IngestServer(status=500, body={"error": "x"}) as server:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always", ResourceWarning)
                transport = transport_for(server)
                for _ in range(20):
                    transport.send([EVENT])
                gc.collect()
            self.assertEqual([w for w in caught if issubclass(w.category, ResourceWarning)], [])

    def test_the_transport_never_shows_its_key(self):
        t = HttpTransport("https://x.example.com/api/ingest", API_KEY, 1.0, "ua")
        self.assertNotIn(API_KEY, repr(t))
        self.assertIsInstance(SendResult(True), SendResult)


if __name__ == "__main__":
    unittest.main()
