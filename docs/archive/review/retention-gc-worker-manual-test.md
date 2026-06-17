# Retention-GC Worker — Manual Test Plan (C11/R35 Tier-1)

Run these after deploying the retention-gc-worker to verify docker-shape boot and
least-privilege role smoke. Integration tests cover all other behaviour.

## Pre-conditions

- Dev stack running: `npm run docker:up` (includes `retention-gc-worker` service).
- `psql` available pointing at dev DB (e.g. via `docker exec -it <db-container> psql -U passwd_user passwd_sso`).
- At least one tenant row exists in `tenants`.
- No sensitive data — placeholders like `<test-tenant-id>` are used throughout.

---

## Tier-1 Smoke A — Docker-shape worker boot

### Steps

```bash
# 1. Start the full stack (retention-gc-worker is in docker-compose.override.yml)
npm run docker:up

# 2. Stream the retention-gc-worker logs
docker compose logs -f retention-gc-worker
```

### Expected result

Within 30 seconds the logs contain (in order):

```
{"level":"info","msg":"retention-gc.loop_start","intervalMs":<n>,"batchSize":<n>}
{"level":"info","msg":"retention-gc.sweep_done","counts":{...}}
```

No `level:error` or `level:fatal` lines on a healthy DB.

Confirm the worker connects as the correct DB role:

```sql
-- In psql as superuser
SELECT application_name, usename
FROM pg_stat_activity
WHERE application_name = 'passwd-sso-retention-gc-worker';
```

**Expected**: one row with `usename = 'passwd_retention_gc_worker'`.

### Rollback

```bash
npm run docker:down
```

---

## Tier-1 Smoke B — Least-privilege role smoke

### Steps

Connect as `passwd_retention_gc_worker` directly and run the two positive/negative
probes (mirrors `retention-gc-worker-role.integration.test.ts`).

```sql
-- Connect as the worker role
\c "dbname=passwd_sso user=passwd_retention_gc_worker"

-- POSITIVE: worker can DELETE from a registered EXPIRY table (sessions)
-- under bypass_rls. No real expired row needed — a count of 0 is fine.
BEGIN;
SELECT set_config('app.bypass_rls', 'on', true);
DELETE FROM sessions
  WHERE (id) IN (
    SELECT id FROM sessions WHERE expires < now() LIMIT 1
  );
-- Expected: "DELETE 0" or "DELETE N" (N >= 0), NO error.
COMMIT;

-- NEGATIVE: worker cannot DELETE directly from audit_logs
BEGIN;
SELECT set_config('app.bypass_rls', 'on', true);
DELETE FROM audit_logs WHERE tenant_id = '<test-tenant-id>'::uuid;
-- Expected: ERROR: permission denied for table audit_logs
ROLLBACK;
```

### Expected result

- POSITIVE probe: completes without error (count may be 0).
- NEGATIVE probe: `ERROR: permission denied for table audit_logs`.

### Rollback

No data modified by the NEGATIVE probe (rolled back). POSITIVE probe may delete
up to 1 genuinely-expired session row, which is the intended behaviour.
