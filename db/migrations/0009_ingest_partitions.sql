-- P2.3: event partitions for the current UTC month and the next three, so ingest never meets a
-- missing partition even if the daily job (P2.11) is late. Ingest rejects any ts outside now +/- 24h,
-- so the previous month is only needed on the first day or two of a month; it was created in 0005 and
-- is kept by retention until day 14. Idempotent: existing partitions are skipped.
--
-- No other schema change is needed for ingest: usage_daily.requests (0004), projects.last_viewed_at
-- (0002) and every grant the ingest statement uses (0003, 0005) already exist. Rollup tables
-- deliberately have no DELETE for app_rw; cleanup is a SECURITY DEFINER function in P2.11.
-- The month is computed in UTC because partition bounds are UTC month boundaries.
SELECT ensure_event_partitions((date_trunc('month', now() AT TIME ZONE 'UTC'))::date, 4);
