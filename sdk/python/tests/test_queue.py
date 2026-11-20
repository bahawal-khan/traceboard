import threading
import unittest

from llm_monitor._queue import BoundedQueue


class TestBoundedQueue(unittest.TestCase):
    def test_fifo_take(self):
        q = BoundedQueue(10)
        for i in range(5):
            q.put(i)
        self.assertEqual(q.take(3), [0, 1, 2])
        self.assertEqual(len(q), 2)
        self.assertEqual(q.take(10), [3, 4])
        self.assertEqual(q.take(10), [])

    def test_full_queue_drops_the_oldest_and_counts_it(self):
        q = BoundedQueue(3)
        results = [q.put(i) for i in range(6)]
        self.assertEqual(results, [False, False, False, True, True, True])
        self.assertEqual(q.take(10), [3, 4, 5])
        self.assertEqual(q.dropped, 3)

    def test_never_exceeds_its_size_under_many_threads(self):
        q = BoundedQueue(100)
        def worker():
            for i in range(2000):
                q.put(i)
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
