-- Probe for docs/archive/review/worker-batch-limit-overrun-plan.md.
-- Run against a dev database as its owner; everything rolls back:
--   docker compose exec -T db psql -U passwd_user -d passwd_sso -q \
--     -f - < docs/archive/review/worker-batch-limit-overrun-probe.sql
-- Each case reports how many of 3 eligible rows a LIMIT 2 statement touched,
-- under GUCs that force the IN-subquery onto the inner side of a Nested Loop
-- Semi Join (rescanned per outer row). Cases A-F use 3 rows sharing one
-- processing_started_at; G and H insert 3 more rows (max_attempts = 98) with
-- distinct values, ascending and descending in insertion (heap) order.
-- Observed on Postgres 16 (2026-10-08):
--   A 3   B 3   C 2   D 2   E 3   F 2   G 3   H 2
-- Overrun needs a lock in the rescanned subquery and the outer scan reaching,
-- later in heap order, a row a rescan admitted after skipping rows this
-- statement already updated. Tied values always line up (btree orders equal
-- keys by heap TID); distinct values overrun only when heap order matches.
BEGIN;
INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, processing_started_at, created_at, next_retry_at)
SELECT gen_random_uuid(), (SELECT id FROM tenants LIMIT 1), '{}'::jsonb, 'PROCESSING', 0, 8,
       now() - interval '1 hour', now(), now()
FROM generate_series(1, 3);
SET LOCAL enable_hashagg = off;
SET LOCAL enable_hashjoin = off;
SET LOCAL enable_mergejoin = off;
SET LOCAL enable_material = off;
SET LOCAL enable_sort = off;
SAVEPOINT s;

\echo A: reaper as written (IN, ORDER BY, LIMIT, FOR UPDATE SKIP LOCKED)
WITH r AS (UPDATE audit_outbox SET attempt_count = attempt_count + 1
  WHERE id IN (SELECT id FROM audit_outbox WHERE status = 'PROCESSING'
    AND processing_started_at < now() - make_interval(secs => 300)
    ORDER BY processing_started_at ASC LIMIT 2 FOR UPDATE SKIP LOCKED)
  RETURNING id) SELECT count(*) FROM r;
ROLLBACK TO s;

\echo B: lock without ORDER BY (IN, LIMIT, FOR UPDATE)
WITH r AS (UPDATE audit_outbox SET attempt_count = attempt_count + 1
  WHERE id IN (SELECT id FROM audit_outbox WHERE status = 'PROCESSING'
    AND processing_started_at < now() - make_interval(secs => 300)
    LIMIT 2 FOR UPDATE)
  RETURNING id) SELECT count(*) FROM r;
ROLLBACK TO s;

\echo C: tied ORDER BY without a lock (IN, ORDER BY, LIMIT)
WITH r AS (UPDATE audit_outbox SET attempt_count = attempt_count + 1
  WHERE id IN (SELECT id FROM audit_outbox WHERE status = 'PROCESSING'
    AND processing_started_at < now() - make_interval(secs => 300)
    ORDER BY processing_started_at ASC LIMIT 2)
  RETURNING id) SELECT count(*) FROM r;
ROLLBACK TO s;

\echo D: the fix (MATERIALIZED CTE, subquery unchanged)
WITH picked AS MATERIALIZED (SELECT id FROM audit_outbox WHERE status = 'PROCESSING'
    AND processing_started_at < now() - make_interval(secs => 300)
    ORDER BY processing_started_at ASC LIMIT 2 FOR UPDATE SKIP LOCKED),
  r AS (UPDATE audit_outbox SET attempt_count = attempt_count + 1
    WHERE id IN (SELECT id FROM picked) RETURNING id)
SELECT count(*) FROM r;
ROLLBACK TO s;

\echo E: = ANY (SELECT ... LIMIT ... FOR UPDATE SKIP LOCKED)
WITH r AS (UPDATE audit_outbox SET attempt_count = attempt_count + 1
  WHERE id = ANY (SELECT id FROM audit_outbox WHERE status = 'PROCESSING'
    AND processing_started_at < now() - make_interval(secs => 300)
    ORDER BY processing_started_at ASC LIMIT 2 FOR UPDATE SKIP LOCKED)
  RETURNING id) SELECT count(*) FROM r;
ROLLBACK TO s;

\echo F: = ANY (ARRAY(SELECT ... LIMIT ... FOR UPDATE SKIP LOCKED)) -- InitPlan, evaluated once
WITH r AS (UPDATE audit_outbox SET attempt_count = attempt_count + 1
  WHERE id = ANY (ARRAY(SELECT id FROM audit_outbox WHERE status = 'PROCESSING'
    AND processing_started_at < now() - make_interval(secs => 300)
    ORDER BY processing_started_at ASC LIMIT 2 FOR UPDATE SKIP LOCKED))
  RETURNING id) SELECT count(*) FROM r;
ROLLBACK TO s;

\echo G: case A, distinct values ascending in insertion (heap) order
INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, processing_started_at, created_at, next_retry_at)
SELECT gen_random_uuid(), (SELECT id FROM tenants LIMIT 1), '{}'::jsonb, 'PROCESSING', 0, 98,
       now() - interval '1 hour' + n * interval '1 second', now(), now()
FROM generate_series(1, 3) AS n;
WITH r AS (UPDATE audit_outbox SET attempt_count = attempt_count + 1
  WHERE id IN (SELECT id FROM audit_outbox WHERE status = 'PROCESSING' AND max_attempts = 98
    AND processing_started_at < now() - make_interval(secs => 300)
    ORDER BY processing_started_at ASC LIMIT 2 FOR UPDATE SKIP LOCKED)
  RETURNING id) SELECT count(*) FROM r;
ROLLBACK TO s;

\echo H: case A, distinct values descending in insertion (heap) order
INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, processing_started_at, created_at, next_retry_at)
SELECT gen_random_uuid(), (SELECT id FROM tenants LIMIT 1), '{}'::jsonb, 'PROCESSING', 0, 98,
       now() - interval '1 hour' - n * interval '1 second', now(), now()
FROM generate_series(1, 3) AS n;
WITH r AS (UPDATE audit_outbox SET attempt_count = attempt_count + 1
  WHERE id IN (SELECT id FROM audit_outbox WHERE status = 'PROCESSING' AND max_attempts = 98
    AND processing_started_at < now() - make_interval(secs => 300)
    ORDER BY processing_started_at ASC LIMIT 2 FOR UPDATE SKIP LOCKED)
  RETURNING id) SELECT count(*) FROM r;
ROLLBACK;
