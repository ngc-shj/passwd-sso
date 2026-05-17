# Runbook: Redis Outage — Rate-Limit Fail-Closed Behaviour

This runbook explains operator action when Redis is unavailable AND the application's rate-limiters with `failClosedOnRedisError: true` (42 routes / 46 limiters — see [Route table](#route-table) below) begin returning `503 Service Unavailable` to clients.

Related plan: [`docs/archive/review/rate-limit-fail-closed-on-redis-plan.md`](../archive/review/rate-limit-fail-closed-on-redis-plan.md). Security rationale at the end ([Why fail-closed](#why-fail-closed)).

## 1. Symptom

- Spike in `503 Service Unavailable` on the routes listed in [Route table](#route-table).
- Application logs show many `rate-limit.redis.fallback` warn lines (throttled — one log per `~5 s` window per error code).
- Audit log query (next section) returns rows for `RATE_LIMIT_FAIL_CLOSED`.
- For pre-auth routes (passkey/options, webauthn/auth/options, etc.) audit rows are NOT emitted; instead `rate-limit.fail_closed.pre_auth_skip` warn lines appear.

Client-side: user sees "Service temporarily unavailable" toast (canonical envelope) OR OAuth client sees `temporarily_unavailable` error code (RFC 6749 envelope on `/api/mcp/*`).

## 2. Root cause check

```bash
# Direct Redis check (dev / single-instance)
redis-cli ping
# Docker Compose check
docker compose ps redis

# Managed Redis: check provider console for cluster health,
# failover status, and connection limits.

# Sentinel deployments
redis-cli -h <sentinel-host> -p 26379 sentinel master mymaster
```

Common causes:
- Container/instance crash, OOM, network partition.
- Authentication failure after credential rotation (check `REDIS_URL` env).
- Connection pool exhausted (very high concurrent connection count).
- Sentinel failover stuck mid-promotion.

## 3. Impact

- Listed routes return 503 → users cannot unlock vault, complete passkey login, mint tokens, accept emergency-access grants, verify share-link passwords.
- Non-listed routes (~120 other rate-limited endpoints) continue to function with in-memory per-process rate-limit fallback. They are degraded (per-instance ceiling instead of distributed) but functional.
- Audit subsystem continues to operate (Postgres-backed); the `RATE_LIMIT_FAIL_CLOSED` rows themselves are throttled per `(scope, userId|ip-bucket)` per 5 min to avoid storms.
- Webhook subscribers do NOT receive `RATE_LIMIT_FAIL_CLOSED` (suppressed via `WEBHOOK_DISPATCH_SUPPRESS` to avoid storms during outage). Monitor via SIEM / logs instead.

## 4. Recovery

1. Restore Redis (restart container, replace instance, resolve failover).
2. No application restart required — the limiter checks `getRedis()` on every call and recovers automatically when Redis responds.
3. Verify recovery: subsequent calls to opt-in routes return 200/4xx (not 503).
4. Optional: check audit row count drops within the next 5 min window (throttle expiry).

## 5. Audit verification

After an event, query the audit_logs table to inventory affected scopes:

```sql
-- Post-auth events (route resolved tenant)
SELECT scope, target_id AS limiter_scope, COUNT(*) AS n
FROM audit_logs
WHERE action='RATE_LIMIT_FAIL_CLOSED'
  AND created_at > NOW() - INTERVAL '1 hour'
GROUP BY scope, target_id
ORDER BY n DESC;

-- Per-tenant breakdown
SELECT tenant_id, COUNT(*) AS n
FROM audit_logs
WHERE action='RATE_LIMIT_FAIL_CLOSED'
  AND created_at > NOW() - INTERVAL '1 hour'
GROUP BY tenant_id
ORDER BY n DESC;
```

Pre-auth events (no resolvable tenant) are NOT in `audit_logs`. Grep the application log stream:

```bash
# Aggregated log query (adjust for your log shipper / SIEM)
grep 'rate-limit.fail_closed.pre_auth_skip' /var/log/passwd-sso/app.log \
  | jq -r '"\(.time)\t\(.scope)\t\(.ipBucket)"' \
  | sort | uniq -c | sort -rn | head -20
```

## 6. Alerting

Suggested alertmanager / log-based rules. Tune `N` / `M` to your traffic baseline.

**Rule A — 503 rate on listed routes**:
```yaml
- alert: RateLimitFailClosedSpike
  expr: |
    sum(rate(http_requests_total{
      route=~"/api/(vault|auth/passkey|webauthn|share-links/verify-access|api-keys|tenant/access-requests|mcp|extension|mobile|share-links/.*/content|emergency-access/accept|teams/invitations/accept)/.*",
      status="503"
    }[2m])) > 5
  for: 2m
  annotations:
    summary: "Rate-limit fail-closed routes returning 503 (Redis outage suspected)"
    runbook: "docs/operations/runbook-redis-outage.md"
```

**Rule B — log-based fail-closed signal**:
```yaml
- alert: RateLimitRedisFallbackLog
  expr: |
    sum(rate({app="passwd-sso"} |= "rate-limit.redis.fallback" [5m])) > 0.5
  for: 5m
  annotations:
    summary: "Rate-limiter falling back to in-memory due to Redis errors"
```

## 7. Break-glass procedure (sustained outage)

If Redis cannot be restored within the operational tolerance window AND immediate access to vault-unlock / token-mint is essential (e.g., during a customer incident response), the documented escape is to **revert the merge commit that introduced fail-closed and re-deploy**.

There is **no env-toggle** to disable fail-closed in v1 — this is a deliberate design choice to preserve the "no silent disable in production" security guarantee (a misconfigured env var should not silently weaken the protection).

### Procedure

1. Identify the merge commit that introduced fail-closed:
   ```bash
   git log --oneline --grep='rate-limit fail-closed' main | head -5
   ```
2. Create a revert PR:
   ```bash
   git checkout -b emergency/revert-rate-limit-fail-closed
   git revert <merge-commit-sha>
   git push -u origin emergency/revert-rate-limit-fail-closed
   gh pr create --title "EMERGENCY: revert rate-limit fail-closed (Redis outage)" \
                --body "Restores in-memory fallback for the 42 opt-in routes until Redis is recovered."
   ```
3. Merge via standard CI/CD path. Deploy time becomes the recovery window.
4. After Redis is recovered, re-merge fail-closed in a follow-up PR (cherry-pick from the original change).

### Trade-off accepted

- Worst case: hours-long outage with no operator escape valve other than revert+deploy.
- Likelihood: low if Redis is HA / managed; medium for single-instance deployments.
- Cost to mitigate (add env knob): rejected for v1 to preserve audit-evident behavior. Re-evaluate in 6 months based on real-world outage data; if env-toggle is added, it MUST emit a `RATE_LIMIT_FAIL_CLOSED_DISABLED` audit row on each request so the disable is audit-evident.

## 8. Why fail-closed

Background: most rate-limiters in this app `fail open` to in-memory per-process counters when Redis is unavailable. For the 42 routes in the [Route table](#route-table) — which guard authentication, credential issuance, vault operations, and OAuth token exchange — fail-open silently weakens the effective rate-limit ceiling by `instance_count` in a multi-process / serverless / autoscale deployment. An attacker can spread retries across instances and bypass the documented protection during a Redis outage.

Fail-closed on these endpoints converts an availability degradation into an explicit 503, which:
- Forces clients (and attackers) to back off.
- Surfaces the outage to operators via audit + logs + alertmanager.
- Eliminates the cross-instance bypass vector.

The trade-off: legitimate users cannot complete the affected flows during an outage. We accept this because the alternative (silent credential-brute-force tolerance) is materially worse.

## Route table

| Route | Limiter scope | Envelope |
|-------|---------------|----------|
| `/api/vault/unlock` | `vault.unlock` | `SERVICE_UNAVAILABLE` |
| `/api/vault/unlock/data` | `vault.unlock_data` | `SERVICE_UNAVAILABLE` |
| `/api/vault/setup` | `vault.setup` | `SERVICE_UNAVAILABLE` |
| `/api/vault/reset` | `vault.reset` | `SERVICE_UNAVAILABLE` |
| `/api/vault/change-passphrase` | `vault.change_passphrase` | `SERVICE_UNAVAILABLE` |
| `/api/vault/admin-reset` | `vault.admin_reset` | `SERVICE_UNAVAILABLE` |
| `/api/vault/recovery-key/recover` (×2) | `vault.recovery_recover_verify`, `vault.recovery_recover_reset` | `SERVICE_UNAVAILABLE` |
| `/api/vault/recovery-key/generate` | `vault.recovery_generate` | `SERVICE_UNAVAILABLE` |
| `/api/vault/rotate-key` | `vault.rotate_key` | `SERVICE_UNAVAILABLE` |
| `/api/vault/rotate-key/data` | `vault.rotate_key_data` | `SERVICE_UNAVAILABLE` |
| `/api/vault/delegation` | `vault.delegation` | `SERVICE_UNAVAILABLE` |
| `/api/vault/delegation/check` | `vault.delegation_check` | **custom** `{authorized:false, reason:"service_unavailable"}` 503 |
| `/api/auth/passkey/verify` | `auth.passkey_verify` (pre-auth) | `SERVICE_UNAVAILABLE` |
| `/api/auth/passkey/options` | `auth.passkey_options` (pre-auth) | `SERVICE_UNAVAILABLE` |
| `/api/auth/passkey/options/email` | `auth.passkey_options_email` (pre-auth) | `SERVICE_UNAVAILABLE` |
| `/api/auth/passkey/reauth/verify` | `auth.passkey_reauth_verify` | `SERVICE_UNAVAILABLE` |
| `/api/auth/passkey/reauth/options` | `auth.passkey_reauth_options` | `SERVICE_UNAVAILABLE` |
| `/api/webauthn/authenticate/verify` | `webauthn.auth_verify` | `SERVICE_UNAVAILABLE` |
| `/api/webauthn/authenticate/options` | `webauthn.auth_options` (pre-auth) | `SERVICE_UNAVAILABLE` |
| `/api/webauthn/register/verify` | `webauthn.reg_verify` | `SERVICE_UNAVAILABLE` |
| `/api/webauthn/register/options` | `webauthn.reg_options` | `SERVICE_UNAVAILABLE` |
| `/api/webauthn/credentials/[id]/prf` | `webauthn.prf` | `SERVICE_UNAVAILABLE` |
| `/api/webauthn/credentials/[id]/prf/options` | `webauthn.prf_options` | `SERVICE_UNAVAILABLE` |
| `/api/share-links/verify-access` (×2) | `share.verify_access_ip` (pre-auth), `share.verify_access_token` | `SERVICE_UNAVAILABLE` |
| `/api/api-keys` (POST) | `apikey.create` | `SERVICE_UNAVAILABLE` |
| `/api/tenant/access-requests` (POST) | `access_request.create` | `SERVICE_UNAVAILABLE` |
| `/api/tenant/access-requests/[id]/approve` | `access_request.approve` | `SERVICE_UNAVAILABLE` |
| `/api/tenant/access-requests/[id]/deny` | `access_request.deny` | `SERVICE_UNAVAILABLE` |
| `/api/mcp/token` (×2) | `mcp.token`, `mcp.token_ip` | **`temporarily_unavailable`** (RFC 6749) |
| `/api/mcp/authorize` | `mcp.authorize` | **`temporarily_unavailable`** |
| `/api/mcp/register` | `mcp.dcr_register` | **`temporarily_unavailable`** |
| `/api/mcp/revoke` | `mcp.revoke` | **`temporarily_unavailable`** |
| `/api/extension/token` | `extension.token` | `SERVICE_UNAVAILABLE` |
| `/api/extension/token/exchange` | `extension.token_exchange` | `SERVICE_UNAVAILABLE` |
| `/api/extension/token/refresh` | `extension.token_refresh` | `SERVICE_UNAVAILABLE` |
| `/api/extension/bridge-code` | `extension.bridge_code` | `SERVICE_UNAVAILABLE` |
| `/api/mobile/token` | `mobile.token` | `SERVICE_UNAVAILABLE` |
| `/api/mobile/token/refresh` | `mobile.token_refresh` | `SERVICE_UNAVAILABLE` |
| `/api/tenant/members/[userId]/reset-vault/[resetId]/approve` (×2) | `vault.admin_reset_approve`, `vault.admin_reset_approve_target` | `SERVICE_UNAVAILABLE` |
| `/api/share-links/[id]/content` | `share.content` | `SERVICE_UNAVAILABLE` |
| `/api/emergency-access/accept` | `emergency_access.accept_token` (pre-auth-ish) | `SERVICE_UNAVAILABLE` |
| `/api/teams/invitations/accept` | `teams.invitation_accept_token` | `SERVICE_UNAVAILABLE` |
