# Manual Test Plan: dcr-cleanup-to-worker

Verification steps for operators / reviewers to run against a real deployment after merging PR #412. CI integration tests (`ci-integration.yml`) cover the role-grant / sweep / tx-rollback contracts; this document covers behaviors CI cannot exercise: container boot, fresh-install initdb path, and the deprecated-call audit.

---

## 0. Prerequisites

- Docker compose dev stack OR a real cluster
- An `op_*` operator token minted via `/dashboard/tenant/operator-tokens` (will be used only for the 410 stub test)
- `psql` access to the dev DB (or `docker exec passwd-sso-db-1 psql -U passwd_user -d passwd_sso`)
- A tenant id you have admin role in (for the "negative isolation" test)

Set:
```bash
export APP_URL=https://localhost:3001/passwd-sso       # or your deployment's URL
export OP_TOKEN=op_<43-char base64url>
export TENANT_A=<tenant-uuid-where-you-are-admin>
export SYSTEM_TENANT_ID=00000000-0000-4000-8000-000000000002
export SYSTEM_ACTOR_ID=00000000-0000-4000-8000-000000000001
```

---

## 1. Fresh-install initdb path (one-time, on first `docker compose up`)

**Goal**: confirm `02-create-app-role.sql` no longer crashes on `audit_outbox` GRANT, and `03-create-dcr-cleanup-worker-role.sql` runs cleanly.

**Setup** (DESTRUCTIVE — only on a throwaway environment):
```bash
docker compose down -v          # wipes dev DB volume
docker compose up -d db
docker logs passwd-sso-db-1 2>&1 | grep -E "01-|02-|03-|relation .* does not exist|password authentication"
```

**Expected**:
- `running /docker-entrypoint-initdb.d/01-create-jackson-db.sql` (no errors)
- `running /docker-entrypoint-initdb.d/02-create-app-role.sql` (no errors)
- `running /docker-entrypoint-initdb.d/03-create-dcr-cleanup-worker-role.sql` (no errors)
- NO `relation "audit_outbox" does not exist` error
- NO `password authentication failed for user "passwd_dcr_cleanup_worker"` error

**Verify roles**:
```bash
docker exec passwd-sso-db-1 psql -U passwd_user -d passwd_sso -tc \
  "SELECT rolname FROM pg_roles WHERE rolname LIKE 'passwd_%' ORDER BY 1"
```
Expected output: `passwd_app, passwd_dcr_cleanup_worker, passwd_outbox_worker, passwd_user`

**Verify worker can authenticate**:
```bash
docker exec passwd-sso-db-1 psql "postgresql://passwd_dcr_cleanup_worker:passwd_dcr_pass@localhost:5432/passwd_sso" -c "SELECT 1"
docker exec passwd-sso-db-1 psql "postgresql://passwd_outbox_worker:passwd_outbox_pass@localhost:5432/passwd_sso" -c "SELECT 1"
```
Both should print `1`.

---

## 2. Worker boot + sweep (host-mode)

**Goal**: end-to-end sweep deletes an expired DCR row and emits SYSTEM-attributed audit.

**Apply migrations** (after Step 1 if you reset the volume):
```bash
DATABASE_URL=postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso npx prisma migrate deploy
```

**Seed an expired DCR row**:
```bash
docker exec passwd-sso-db-1 psql -U passwd_user -d passwd_sso <<'SQL'
INSERT INTO mcp_clients (
  id, client_id, tenant_id, name,
  is_dcr, dcr_expires_at,
  created_at, updated_at
) VALUES (
  gen_random_uuid(),
  'manual-test-client-' || extract(epoch from now())::int,
  NULL,
  'Manual Test DCR Client',
  true,
  now() - interval '1 hour',
  now(), now()
);
SELECT id, client_id, tenant_id, dcr_expires_at FROM mcp_clients
  WHERE name = 'Manual Test DCR Client';
SQL
```

**Run the worker once** (60s interval for fast verification):
```bash
DCR_CLEANUP_INTERVAL_MS=60000 timeout 5 npx tsx scripts/dcr-cleanup-worker.ts 2>&1 | tail -5
```
Expected log lines:
- `dcr-cleanup.loop_start` with `intervalMs: 60000`, `batchSize: 1000`
- `dcr-cleanup.sweep_done` with `purged: 1`

**Verify deletion**:
```bash
docker exec passwd-sso-db-1 psql -U passwd_user -d passwd_sso -tc \
  "SELECT count(*) FROM mcp_clients WHERE name = 'Manual Test DCR Client'"
```
Expected: `0`

**Verify audit_outbox emission** (drain may not have happened yet):
```bash
docker exec passwd-sso-db-1 psql -U passwd_user -d passwd_sso -tc \
  "SELECT payload->>'action', payload->>'userId', payload->>'actorType', tenant_id, status
   FROM audit_outbox
   WHERE tenant_id = '${SYSTEM_TENANT_ID}'::uuid
   ORDER BY created_at DESC LIMIT 1"
```
Expected: `MCP_CLIENT_DCR_CLEANUP | ${SYSTEM_ACTOR_ID} | SYSTEM | ${SYSTEM_TENANT_ID} | PENDING` (or `SENT` if outbox-worker drained it).

**Run outbox-worker once to drain** (optional):
```bash
timeout 5 npx tsx scripts/audit-outbox-worker.ts 2>&1 | tail -3
```

**Verify audit_logs row landed** with SYSTEM attribution:
```bash
docker exec passwd-sso-db-1 psql -U passwd_user -d passwd_sso -tc \
  "SELECT action, user_id, actor_type, tenant_id, metadata
   FROM audit_logs
   WHERE tenant_id = '${SYSTEM_TENANT_ID}'::uuid
     AND action = 'MCP_CLIENT_DCR_CLEANUP'
   ORDER BY created_at DESC LIMIT 1"
```
Expected: `MCP_CLIENT_DCR_CLEANUP | 00000000-0000-4000-8000-000000000001 | SYSTEM | 00000000-0000-4000-8000-000000000002 | {"purgedCount": 1, "triggeredBy": "dcr-cleanup-worker", "sweepIntervalMs": 60000}`

---

## 3. 410 deprecation stub

**Goal**: confirm the legacy endpoint preserves auth flow, returns 410, emits a deprecation audit event visible to the caller's tenant.

```bash
curl -sk -i -X POST \
  -H "Authorization: Bearer $OP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$APP_URL/api/maintenance/dcr-cleanup"
```

**Expected**:
- `HTTP/1.1 410 Gone`
- Body: `{"error":"endpoint_removed","replacement":"worker:dcr-cleanup"}`

**Verify deprecation audit emitted to caller's tenant**:
```bash
docker exec passwd-sso-db-1 psql -U passwd_user -d passwd_sso -tc \
  "SELECT action, user_id, actor_type, metadata->>'deprecated', metadata->>'replacement'
   FROM audit_logs
   WHERE action = 'MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL'
   ORDER BY created_at DESC LIMIT 1"
```
Expected: `MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL | <op_token's userId> | HUMAN | true | worker:dcr-cleanup`

**Negative — auth flow preserved**:
```bash
# 401 without token
curl -sk -i -X POST -H "Content-Type: application/json" -d '{}' "$APP_URL/api/maintenance/dcr-cleanup" | head -1
# Expected: HTTP/1.1 401 Unauthorized

# 401 with bogus token
curl -sk -i -X POST \
  -H "Authorization: Bearer op_invalidtoken" \
  -d '{}' "$APP_URL/api/maintenance/dcr-cleanup" | head -1
# Expected: HTTP/1.1 401 Unauthorized

# 429 if rate-limited (issue 2 calls within 60s with valid token)
curl -sk -i -X POST -H "Authorization: Bearer $OP_TOKEN" -H "Content-Type: application/json" -d '{}' "$APP_URL/api/maintenance/dcr-cleanup" >/dev/null 2>&1
curl -sk -i -X POST -H "Authorization: Bearer $OP_TOKEN" -H "Content-Type: application/json" -d '{}' "$APP_URL/api/maintenance/dcr-cleanup" | head -1
# Expected: HTTP/1.1 429 Too Many Requests
```

---

## 4. Tenant isolation: SYSTEM events not visible to tenant admin

**Goal**: confirm `MCP_CLIENT_DCR_CLEANUP` audit rows (sentinel-attributed) are NOT exposed via `/api/tenant/audit-logs` for any real tenant. Only the deprecation-call event (caller-attributed) is visible to its own tenant admin.

Sign in as a tenant admin in tenant A, navigate to the audit-logs UI:
- ✅ Should see: `MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL` rows (when YOU called the deprecated endpoint)
- ❌ Should NOT see: any `MCP_CLIENT_DCR_CLEANUP` rows from the worker (those are sentinel-attributed)

DB-side confirmation (via psql, not via UI):
```bash
docker exec passwd-sso-db-1 psql -U passwd_user -d passwd_sso -tc \
  "SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT_A}'::uuid AND action = 'MCP_CLIENT_DCR_CLEANUP'"
```
Expected: `0` (sentinel rows have tenantId=SYSTEM_TENANT_ID, not TENANT_A)

---

## 5. Docker container boot (in addition to host mode)

**Goal**: confirm the worker runs correctly inside its docker-compose service.

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d dcr-cleanup-worker
sleep 5
docker logs passwd-sso-dcr-cleanup-worker --tail 5
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep dcr-cleanup-worker
```

**Expected**:
- Status: `Up <time>` (NOT `Restarting`)
- Logs: `dcr-cleanup.loop_start` and (after the configured interval) `dcr-cleanup.sweep_done`
- NO `Cannot find module '.prisma/client/default'` errors
- NO `password authentication failed` errors

---

## 6. k8s deployment (production-equivalent)

**Goal**: confirm the bundled-binary path works in the production runner image.

```bash
# Build the runner image (or pull from CI registry)
docker build -t passwd-sso:test --target runner .

# Smoke-test the bundled worker via --validate-env-only
docker run --rm \
  -e DCR_CLEANUP_DATABASE_URL=postgresql://invalid:invalid@nonexistent:5432/test \
  -e DATABASE_URL=postgresql://invalid:invalid@nonexistent:5432/test \
  passwd-sso:test \
  node dist/dcr-cleanup-worker.js --validate-env-only
```

**Expected exit 0** with stdout: `{"level":"info","msg":"env validation passed"}`.

For a full deploy:
```bash
kubectl apply -f infra/k8s/dcr-cleanup-worker.yaml
kubectl get pods -l component=dcr-cleanup-worker
kubectl logs -l component=dcr-cleanup-worker --tail=20
```

---

## Verification matrix

| Step | What it proves | Reset needed? |
|---|---|---|
| 1 | initdb 02 + 03 run cleanly on fresh DB | YES (down -v) |
| 2 | Worker actually deletes expired DCR rows + emits SYSTEM audit | NO |
| 3 | 410 stub: auth/rate-limit preserved + deprecation audit emitted | NO |
| 4 | Tenant admins don't leak SYSTEM-attributed cleanup events | NO |
| 5 | Docker compose worker container boots cleanly | NO (just needs up) |
| 6 | k8s runner image's bundled binary runs | NO (separate image build) |

Steps 2-5 can run against the existing dev DB without data loss. Step 1 requires a throwaway environment OR a planned dev-DB reset. Step 6 needs a CI/registry pipeline or a local docker build.

---

## Live verification on dev DB (PR #412 author, 2026-04-28)

### Step 2 (worker sweep) — verified ✓

```
INSERT mcp_clients with is_dcr=true, tenant_id=NULL, dcr_expires_at=now()-1h
→ DCR_CLEANUP_INTERVAL_MS=60000 timeout 5 npx tsx scripts/dcr-cleanup-worker.ts

Output:
{level:info, msg:dcr-cleanup.loop_start, intervalMs:60000, batchSize:1000}
{level:info, msg:dcr-cleanup.sweep_done, purged:1}
```

`audit_logs` (after outbox-worker drain):
```
action: MCP_CLIENT_DCR_CLEANUP
user_id: 00000000-0000-4000-8000-000000000001 (SYSTEM_ACTOR_ID)
actor_type: SYSTEM
tenant_id: 00000000-0000-4000-8000-000000000002 (SYSTEM_TENANT_ID)
metadata: {"purgedCount":1, "triggeredBy":"dcr-cleanup-worker", "sweepIntervalMs":60000}
```

### Step 3 (410 stub) — verified ✓

| Case | Expected | Actual |
|---|---|---|
| Valid token | 410 + `{"error":"endpoint_removed","replacement":"worker:dcr-cleanup"}` | ✓ Match |
| No token | 401 | ✓ 401 + `{"error":"UNAUTHORIZED"}` |
| Bogus token | 401 | ✓ 401 + `{"error":"UNAUTHORIZED"}` |
| Rate-limit (2nd valid call within 60s) | 429 | ✓ 429 + `{"error":"RATE_LIMIT_EXCEEDED"}` + `Retry-After: 60` |

`audit_logs` (1 row total from 4 calls — only the valid-success [1] emitted; rate-limited [4] did NOT emit, matching the plan's "audit emit AFTER rate-limit gate" decision):
```
action: MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL
actor_type: HUMAN
scope: TENANT
tenant_id: <caller's tenantId> (visible in operator's tenant audit log — by design)
metadata: {"tokenId":"...", "tokenSubjectUserId":"...", "deprecated":true, "replacement":"worker:dcr-cleanup"}
```

Strict-shape verified: PRESENT lists match; ABSENT (`purgedCount`, `triggeredBy`, `sweepIntervalMs`, `systemWide`) confirmed by their absence from the metadata payload.

### Step 5 (Docker compose worker) — verified ✓ (during PR review)

After `docker compose down -v` and `up -d`, both `passwd-sso-dcr-cleanup-worker` and `passwd-sso-audit-outbox-worker-1` reached `Up` state with `dcr-cleanup.loop_start` + `sweep_done` logs and no `MODULE_NOT_FOUND` or `password authentication failed` errors.

### Steps 1, 4, 6 — left for operator

- Step 1 (fresh install initdb): destructive (data loss); execute in throwaway environment.
- Step 4 (tenant audit-log UI visibility): UI test, requires browser session.
- Step 6 (k8s deployment): requires k8s cluster.
