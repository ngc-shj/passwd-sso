# Manual Test Plan: vault-reset-cache-invalidation-audit

Tier: Tier-2 — touches vault reset, admin vault reset, and tenant policy change. Each of those is an authentication-state mutation, and the change extends their audit trail. Adversarial scenarios (Redis outage during reset) are included because the entire premise of the change is "the existing throttled-logger does not survive an incident-reconstruction request."

## Pre-conditions

- Local dev stack up: `npm run docker:up` (Postgres + Redis + Jackson + Mailpit + audit-outbox-worker)
- App running: `npm run dev`
- Browser session signed in as a tenant admin user (so admin-reset and tenant policy surfaces are reachable in addition to self-vault-reset)
- A second sign-in slot to verify that captured-but-tombstoned sessions are no longer trusted after reset (e.g., a separate browser profile or an extension token)
- `audit-outbox-worker` running so audit events drain into `audit_logs` for inspection — `npm run worker:audit-outbox` if not already up
- A psql shell handy to inspect `audit_logs.metadata` directly

## Steps

### S1. Self-vault-reset under healthy Redis (positive baseline)
1. Sign in. Set up the vault if not already initialized.
2. Open a second authenticated tab so there is at least one cached session row to tombstone.
3. Navigate to the vault reset surface and confirm the destructive reset (DELETE_VAULT phrase).
4. Inspect the most recent `VAULT_RESET_EXECUTED` audit row:
   ```sql
   SELECT metadata FROM audit_logs
    WHERE action = 'VAULT_RESET_EXECUTED'
    ORDER BY "createdAt" DESC LIMIT 1;
   ```

### S2. Self-vault-reset with Redis offline (failure surfacing)
1. Re-initialize the vault and open a second authenticated tab to repopulate the session cache (so there is something to fail to tombstone).
2. Stop Redis: `docker compose stop redis`.
3. Trigger the vault reset.
4. Inspect the most recent `VAULT_RESET_EXECUTED` audit row metadata.
5. Restore Redis: `docker compose start redis`.

### S3. Admin vault reset with Redis offline
1. As tenant admin, mint an admin-vault-reset token for a target user (the dual-approval flow ending with the target executing `/api/vault/admin-reset`).
2. Stop Redis: `docker compose stop redis`.
3. As the target user, complete the reset.
4. Inspect the most recent `ADMIN_VAULT_RESET_EXECUTE` audit row metadata.
5. Restore Redis: `docker compose start redis`.

### S4. Tenant policy change toggling requirePasskey (positive baseline)
1. As tenant admin, navigate to the tenant security policy page.
2. Ensure at least one signed-in member session exists so the cache has something to tombstone (e.g., a second account in another browser profile).
3. Toggle `requirePasskey` from off → on (or vice versa).
4. Inspect the most recent `POLICY_UPDATE` audit row metadata.

### S5. Tenant policy change toggling requirePasskey with Redis offline
1. Toggle `requirePasskey` back to its prior state to set up a clean delta.
2. Stop Redis: `docker compose stop redis`.
3. Toggle `requirePasskey` again.
4. Inspect the most recent `POLICY_UPDATE` audit row metadata.
5. Restore Redis: `docker compose start redis`.

### S6. Tenant policy change unrelated to passkey (no-invalidation control)
1. With Redis up, edit a non-passkey field — e.g., bump `passwordExpiryWarningDays` by one day.
2. Inspect the most recent `POLICY_UPDATE` audit row metadata.

### S7. Build-time signal — throttled logger still fires
1. With Redis stopped, repeat any of S2 / S3 / S5.
2. Tail the dev server stdout (`npm run dev` window).

## Expected result

- **S1**: `metadata` JSON contains `"cacheTombstoneFailures": 0`. `invalidatedSessions` ≥ 1 (the second tab's session row was deleted). The second tab returns 401 on its next request.
- **S2**: `metadata` contains `"cacheTombstoneFailures"` ≥ 1, equal to the number of session tokens that existed at reset time. `invalidatedSessions` matches the DB-side delete count and is independent of the cache failure (the Postgres delete is durable). After Redis comes back, the cached SessionInfo is still poisoned for up to `SESSION_CACHE_TTL_MS`, but the tombstone failure is now visible in the audit row for forensic reconstruction.
- **S3**: `metadata` contains `"cacheTombstoneFailures"` ≥ 1 alongside the existing `invalidatedSessions` / `invalidatedExtensionTokens` / `invalidatedApiKeys` / `invalidatedMcpAccessTokens` / `invalidatedMcpRefreshTokens` / `invalidatedDelegationSessions` counts. The TENANT or TEAM scope on the audit row is unchanged from prior behavior.
- **S4**: `metadata` contains `"cacheInvalidatedSessions"` ≥ 1 and `"cacheTombstoneFailures": 0`. Pre-existing fields (`requirePasskey`, etc.) remain.
- **S5**: `metadata` contains `"cacheInvalidatedSessions"` ≥ 1 and `"cacheTombstoneFailures"` equal to `cacheInvalidatedSessions` (pipeline failure is all-or-nothing at the network layer, so failed === total).
- **S6**: `metadata` does NOT contain `cacheInvalidatedSessions` or `cacheTombstoneFailures`. Pre-existing fields are unchanged. (Absence of the field, not zero — invalidation never ran for non-passkey edits.)
- **S7**: A `session-cache.redis.fallback` log line appears with the relevant error code (`ECONNREFUSED` / `ETIMEDOUT` / etc.). The throttled logger continues to fire alongside the new audit emission — operational and forensic signals are layered, not replaced.

## Rollback

- Single revert: `git revert <PR-merge-sha>` reverses every commit cleanly. No DB migration, no config change, no schema mutation. The audit-log JSON is additive; revert removes the new fields, but past audit rows that were written with them remain valid JSON and are simply ignored by consumers that don't read them.
