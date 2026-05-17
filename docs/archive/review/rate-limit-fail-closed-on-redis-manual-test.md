# Manual Test Plan: rate-limit-fail-closed-on-redis

R35 Tier-2 (auth flows + token issuance touched) — manual test artifact REQUIRED.

Related plan: [`rate-limit-fail-closed-on-redis-plan.md`](./rate-limit-fail-closed-on-redis-plan.md).

## Pre-conditions

Operator substitutes placeholders locally; do NOT commit real values per RS4.

1. Dev cluster up: `npm run docker:up` (starts Postgres, Redis, Mailpit).
2. Migrations applied: `npm run db:migrate`.
3. Two test users, two tenants:
   - `<test-user-A-email>` in tenant A (passkey enrolled, vault initialized).
   - `<test-user-B-email>` in tenant B (passkey enrolled, vault initialized).
4. MCP test client registered via Dynamic Client Registration:
   ```
   curl -X POST http://localhost:3000/api/mcp/register \
     -H 'Content-Type: application/json' \
     -d '{"client_name":"manual-test","redirect_uris":["http://localhost/cb"]}'
   ```
   Capture the returned `client_id` for Scenario B/D.
5. `psql` connection to dev DB available: `psql $DATABASE_URL`.
6. Audit outbox worker running (separate terminal): `npm run worker:audit-outbox`.

## Steps

### Step 1 — Vault unlock with Redis up (happy path)

```
curl -X POST http://localhost:3000/api/vault/unlock \
  -H 'Cookie: <user-A-session-cookie>' \
  -H 'Content-Type: application/json' \
  -d '{"authHash":"<valid-hash>","verifierHash":"<valid-verifier-hash>"}'
```
**Expected**: 200 + `{ valid: true, encryptedSecretKey: "...", ... }`.

### Step 2 — Vault unlock with Redis stopped

```
docker compose stop redis
# wait 2s
curl -i -X POST http://localhost:3000/api/vault/unlock \
  -H 'Cookie: <user-A-session-cookie>' \
  -H 'Content-Type: application/json' \
  -d '{"authHash":"<valid-hash>"}'
```
**Expected**:
- HTTP 503.
- `Retry-After: 30` response header.
- Body: `{"error":"SERVICE_UNAVAILABLE"}`.

Restart Redis:
```
docker compose start redis
# wait 5s for healthcheck
# Repeat Step 1 — expect 200.
```

### Step 3 — Passkey verify with Redis stopped (pre-auth route)

```
docker compose stop redis
# Trigger via browser: navigate to /sign-in/passkey, attempt passkey unlock
# OR: replay a recorded WebAuthn assertion via curl
curl -i -X POST http://localhost:3000/api/auth/passkey/verify \
  -H 'Content-Type: application/json' \
  -d '<webauthn-assertion-payload>'
```
**Expected**:
- HTTP 503 + Retry-After: 30 + `{"error":"SERVICE_UNAVAILABLE"}`.
- No new session created (check `SELECT count(*) FROM sessions WHERE created_at > NOW() - INTERVAL '1 min';` returns 0).
- No audit row in `audit_logs` for this attempt (pre-auth → I3.7 skips emission).
- Application log contains a `rate-limit.fail_closed.pre_auth_skip` entry (grep your log shipper).

### Step 4 — MCP token exchange with Redis stopped (OAuth envelope)

```
docker compose stop redis
curl -i -X POST http://localhost:3000/api/mcp/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code=fake&redirect_uri=http://localhost/cb&client_id=<dcr-client-id>&code_verifier=verifier-value'
```
**Expected**:
- HTTP 503 + `Retry-After: 30`.
- Body: **`{"error":"temporarily_unavailable"}`** (RFC 6749 envelope, NOT `SERVICE_UNAVAILABLE`).
- No token issued (no row in `mcp_access_tokens` for the test client created in the last 5 min).

### Step 5 — OAuth callback with Redis stopped (control: not in opt-in list)

```
docker compose stop redis
# Trigger Google sign-in callback (or recreate flow via curl with stored state)
curl -i 'http://localhost:3000/api/auth/callback/google?code=<from-redirect>&state=<from-init>'
```
**Expected**: The callback continues to function (in-memory rate-limit fallback). HTTP 302 redirect to the post-login URL OR a normal callback handling response. **Not** 503.
This confirms the opt-in list is correctly scoped — non-listed routes remain unaffected.

### Step 6 — Audit verification (post-auth)

After Step 2 with the valid logged-in user A, run:
```sql
SELECT action, scope, actor_type, target_type, target_id, metadata
FROM audit_logs
WHERE action='RATE_LIMIT_FAIL_CLOSED'
  AND created_at > NOW() - INTERVAL '5 min';
```
**Expected**:
- ≥ 1 row.
- `target_type='RateLimiter'`, `target_id='vault.unlock'`.
- `actor_type='HUMAN'`, `metadata.scope='vault.unlock'`, `metadata.ip` and `metadata.ipBucket` populated.

### Step 7 — Audit verification (pre-auth)

After Step 3, run the same query for scope `auth.passkey_verify`. **Expected**: ZERO rows (pre-auth case — I3.7 skipped emission). Then grep the log stream:
```
grep 'rate-limit.fail_closed.pre_auth_skip' /var/log/passwd-sso/app.log | tail -5
```
**Expected**: ≥ 1 line referencing `scope:"auth.passkey_verify"`.

### Step 8 — Throttle verification

Trigger Step 2 ten times in 30 s from one logged-in user (Redis still stopped):
```
docker compose stop redis
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://localhost:3000/api/vault/unlock \
    -H 'Cookie: <user-A-session-cookie>' \
    -H 'Content-Type: application/json' \
    -d '{"authHash":"<valid-hash>"}'
  sleep 0.3
done
```
**Expected**:
- All 10 responses are 503.
- Audit row count for `(scope='vault.unlock', user_id=<user-A>)` in the last 2 min should be exactly **1** (throttle holds):
  ```sql
  SELECT COUNT(*) FROM audit_logs
  WHERE action='RATE_LIMIT_FAIL_CLOSED'
    AND user_id='<user-A-uuid>'
    AND metadata->>'scope'='vault.unlock'
    AND created_at > NOW() - INTERVAL '2 min';
  ```

### Step 9 — Recovery without restart

After any of the above, restart Redis:
```
docker compose start redis
sleep 5
# Repeat Step 1 from the same shell session — no app restart between
curl -i -X POST http://localhost:3000/api/vault/unlock ...
```
**Expected**: 200 (limiter recovered automatically; no app restart required).

## Adversarial scenarios (R35 Tier-2 mandatory)

### Scenario A — Cross-tenant audit isolation

**Pre-conditions**: Both user A (tenant A) and user B (tenant B) logged in.

**Procedure**:
```
docker compose stop redis
# From user-A session:
curl -X POST http://localhost:3000/api/vault/unlock -H 'Cookie: <A-cookie>' \
     -H 'Content-Type: application/json' -d '{"authHash":"<A-hash>"}'
# From user-B session:
curl -X POST http://localhost:3000/api/vault/unlock -H 'Cookie: <B-cookie>' \
     -H 'Content-Type: application/json' -d '{"authHash":"<B-hash>"}'
```

**SQL assertion**:
```sql
SELECT tenant_id, user_id, metadata->>'ip' AS ip, metadata->>'scope' AS scope
FROM audit_logs
WHERE action='RATE_LIMIT_FAIL_CLOSED' AND created_at > NOW() - INTERVAL '5 min'
ORDER BY tenant_id;
```

**Pass**: exactly 2 rows; row for `<tenant-A-uuid>` has `<user-A-uuid>` + user A's IP; row for `<tenant-B-uuid>` has `<user-B-uuid>` + user B's IP. No cross-attribution.

**Fail**: any row has `tenant_id` mismatched against the `user_id`'s actual tenant → ISOLATION BREACH; investigate audit emission path immediately.

### Scenario B — MCP refresh token replay during outage

**Pre-conditions**: A valid MCP refresh token issued before stopping Redis (capture from a successful prior flow).

**Procedure**:
```
docker compose stop redis
# Replay the refresh token 3 times in quick succession:
for i in 1 2 3; do
  curl -X POST http://localhost:3000/api/mcp/token \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d "grant_type=refresh_token&refresh_token=<captured-refresh-token>&client_id=<client-id>"
done
```

**SQL assertion**:
```sql
SELECT action, COUNT(*) FROM audit_logs
WHERE action IN ('MCP_REFRESH_TOKEN_ROTATE','MCP_REFRESH_TOKEN_REPLAY','MCP_REFRESH_TOKEN_FAMILY_REVOKED','RATE_LIMIT_FAIL_CLOSED')
  AND created_at > NOW() - INTERVAL '5 min'
GROUP BY action;
```

**Pass**:
- 1 `RATE_LIMIT_FAIL_CLOSED` row (throttle held at 1 of 3 emit attempts).
- Zero `MCP_REFRESH_TOKEN_ROTATE`, `MCP_REFRESH_TOKEN_REPLAY`, `MCP_REFRESH_TOKEN_FAMILY_REVOKED` rows.

**Fail**: any `MCP_REFRESH_TOKEN_*` row exists → token logic ran despite Redis being down; refresh-family invariants at risk; investigate `mcp/token` route's rate-limit branch ordering.

### Scenario C — Audit storm DoS suppression

**Pre-conditions**: shell with `siege` or `hey` installed; one logged-in user A.

**Procedure**:
```
docker compose stop redis
# Hammer the vault unlock endpoint:
hey -n 1000 -c 20 -m POST \
    -H 'Cookie: <A-cookie>' \
    -H 'Content-Type: application/json' \
    -d '{"authHash":"<A-hash>"}' \
    http://localhost:3000/api/vault/unlock
```

**SQL assertion**:
```sql
SELECT COUNT(*) FROM audit_logs
WHERE action='RATE_LIMIT_FAIL_CLOSED'
  AND user_id='<user-A-uuid>'
  AND metadata->>'scope'='vault.unlock'
  AND created_at > NOW() - INTERVAL '2 min';
```

**Pass**: ≤ 1 row. Throttle holds under flood.

**Fail**: > 1 row → throttle broken or evicted prematurely. Investigate LRU implementation.

### Scenario D — Scope-elevation attempt (MCP)

**Pre-conditions**: An MCP token with `credentials:list` scope only (issued via prior consent flow). An existing delegation session record from a prior successful unlock (record the `delegationSessionId`).

**Procedure**:
```
docker compose stop redis
# Token holder attempts a privileged action that would require credentials:decrypt
curl -i -X POST http://localhost:3000/api/mcp \
  -H 'Authorization: Bearer <mcp-token-with-credentials:list-only>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"decrypt_password","arguments":{"id":"<entry-id>"}}}'
```

**HTTP assertion**: response status **503** with body `{"error":"temporarily_unavailable"}` (OA envelope).

**SQL assertion** (verify route 503'd BEFORE any token/scope logic ran):
```sql
SELECT action, COUNT(*) FROM audit_logs
WHERE action IN ('MCP_REFRESH_TOKEN_ROTATE','MCP_REFRESH_TOKEN_REPLAY','MCP_CONSENT_GRANT')
  AND created_at > NOW() - INTERVAL '5 min'
GROUP BY action;
-- and:
SELECT COUNT(*) FROM delegation_sessions
WHERE created_at > NOW() - INTERVAL '5 min';
```

**Pass**: zero `MCP_REFRESH_TOKEN_*` / `MCP_CONSENT_GRANT` rows AND no new `delegation_sessions` rows in the window. Route 503'd before token/scope logic.

**Fail**: any of those tables show a new row in the window → token/scope code path ran despite Redis being down; investigate route handler branch ordering.

## Expected result (summary)

- 503 emitted with correct envelope per route class (canonical vs RFC 6749 vs custom).
- No session/token issued during outage.
- Audit row emitted for post-auth routes (throttled per scope-user-key per 5 min).
- Pre-auth: warn log only, no audit row.
- Redis recovery requires no app restart; subsequent requests succeed.
- Adversarial scenarios A-D all pass.

## Rollback

If a regression is observed during manual testing:
1. Revert the merge commit per [Runbook §7](../../operations/runbook-redis-outage.md#7-break-glass-procedure-sustained-outage).
2. Plan author: investigate via diff bisection between the merge commit and `main`.

## Pass/fail summary

| Check | Pass criteria | Fail signal |
|-------|---------------|-------------|
| Step 1 | 200 happy path | non-200 → DB / Redis startup issue |
| Step 2 | 503 + Retry-After:30 + canonical envelope | 200 (in-memory fallback) or 500 |
| Step 3 | 503; no session; no audit row; warn log | audit row exists → I3.7 violated |
| Step 4 | 503 + RFC 6749 envelope; no token | canonical envelope on `/api/mcp/*` → C4 row 29 envelope wrong |
| Step 5 | callback works (in-memory fallback) | callback returns 503 → opt-in list scope creep |
| Step 6 | audit row with `target_type='RateLimiter'` | missing fields → C3 contract violated |
| Step 7 | zero audit rows for pre-auth | audit row exists → I3.7 violated |
| Step 8 | exactly 1 audit row per 10 requests | > 1 → throttle broken |
| Step 9 | recovery without restart | 503 persists → limiter not re-checking getRedis() |
| Scenario A | exact tenant↔user pairing | cross-attribution |
| Scenario B | zero refresh-token logic | any MCP_REFRESH_TOKEN_* row |
| Scenario C | exactly 1 audit row under flood | > 1 → throttle bypass |
| Scenario D | zero token/consent/delegation rows | any → route 503 happened too late |
