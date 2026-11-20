import threading
import unittest

from llm_monitor._queue import BoundedQueue, Item


def item(i, size=10, queued_at=0.0):
    return Item({"n": i}, size, queued_at)


def names(items):
    return [it.event["n"] for it in items]


class TestBoundedQueue(unittest.TestCase):
    def test_fifo_take(self):
        q = BoundedQueue(10)
        for i in range(5):
            q.put(item(i))
        batch, expired = q.take_batch(3, 10_000, 0.0, 1e9)
        self.assertEqual((names(batch), expired), ([0, 1, 2], 0))
        self.assertEqual(len(q), 2)
        self.assertEqual(names(q.take_batch(10, 10_000, 0.0, 1e9)[0]), [3, 4])
        self.assertEqual(q.take_batch(10, 10_000, 0.0, 1e9), ([], 0))

    def test_full_queue_drops_the_oldest_and_counts_it(self):
        q = BoundedQueue(3)
        results = [q.put(item(i)) for i in range(6)]
        self.assertEqual(results, [False, False, False, True, True, True])
        self.assertEqual(names(q.take_batch(10, 10_000, 0.0, 1e9)[0]), [3, 4, 5])
        self.assertEqual(q.dropped, 3)

    def test_a_batch_is_limited_by_bytes_but_always_holds_at_least_one_item(self):
        q = BoundedQueue(100)
        for i in range(10):
            q.put(item(i, size=400))
        batch, _ = q.take_batch(100, 1_000, 0.0, 1e9)
        self.assertEqual(names(batch), [0, 1])  # 800 bytes; a third would make 1,200 > 1,000
        q2 = BoundedQueue(10)
        q2.put(item(0, size=5_000))
        q2.put(item(1, size=5))
        self.assertEqual(names(q2.take_batch(100, 1_000, 0.0, 1e9)[0]), [0])  # an oversized item still goes, alone
        self.assertEqual(names(q2.take_batch(100, 1_000, 0.0, 1e9)[0]), [1])

    def test_a_batch_is_limited_by_count(self):
        q = BoundedQueue(500)
        for i in range(250):
            q.put(item(i, size=1))
        self.assertEqual([len(q.take_batch(100, 10**9, 0.0, 1e9)[0]) for _ in range(3)], [100, 100, 50])

    def test_items_older_than_the_maximum_age_are_discarded_and_counted(self):
        q = BoundedQueue(10)
        q.put(item(0, queued_at=0.0))
        q.put(item(1, queued_at=0.0))
        q.put(item(2, queued_at=95.0))
        batch, expired = q.take_batch(10, 10_000, now=100.0, max_age=10.0)
        self.assertEqual((names(batch), expired), ([2], 2))

    def test_requeue_front_keeps_order_and_goes_before_newer_items(self):
        q = BoundedQueue(10)
        for i in range(3):
            q.put(item(i))
        failed = q.take_batch(2, 10_000, 0.0, 1e9)[0]  # [0, 1]
        q.put(item(3))
        self.assertEqual(q.requeue_front(failed), 0)
        self.assertEqual(names(q.take_batch(10, 10_000, 0.0, 1e9)[0]), [0, 1, 2, 3])

    def test_requeue_into_a_nearly_full_queue_drops_the_oldest_of_the_requeued_items(self):
        q = BoundedQueue(5)
        for i in range(5):
            q.put(item(i))
        failed = q.take_batch(4, 10_000, 0.0, 1e9)[0]  # [0..3]; the queue now holds [4]
        for i in (10, 11, 12):
            q.put(item(i))  # holds [4, 10, 11, 12]; one slot free
        self.assertEqual(q.requeue_front(failed), 3)  # only the newest of the failed batch (3) fits
        self.assertEqual(names(q.take_batch(10, 10_000, 0.0, 1e9)[0]), [3, 4, 10, 11, 12])
        self.assertEqual(q.dropped, 3)
        full = BoundedQueue(2)
        full.put(item(8))
        full.put(item(9))
        self.assertEqual(full.requeue_front([item(0), item(1)]), 2)  # no room at all
        self.assertEqual(len(full), 2)

    def test_never_exceeds_its_size_under_many_threads(self):
        q = BoundedQueue(100)
        def worker():
            for i in range(2000):
                q.put(item(i))
        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(q), 100)
        self.assertEqual(q.dropped, 8 * 2000 - 100)

    def test_rejects_a_nonsense_size(self):
        with self.assertRaises(ValueError):
            BoundedQueue(0)


if __name__ == "__main__":
    unittest.main()
