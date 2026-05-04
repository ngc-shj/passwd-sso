# Manual Test Plan: Adversarial Tests + MCP Race Fix (#435)

R35 Tier-2 — auth flow (OAuth refresh token rotation). Production change is `src/lib/mcp/oauth-server.ts` `exchangeRefreshToken` restructure plus `MCP_REFRESH_TOKEN_FAMILY_REVOKED` audit action.

This document is the gating artifact between "CI green" and "actually works on a real deployment".

---

## Pre-conditions

1. **Build artifacts** match the PR branch:
   - `prisma/schema.prisma` has `MCP_REFRESH_TOKEN_FAMILY_REVOKED` in `AuditAction` enum
   - `prisma/migrations/20260504015602_add_mcp_refresh_token_family_revoked_audit/` applied to the target DB
   - `npm run db:migrate` clean (`prisma migrate status` reports no pending)
   - `npx prisma generate` ran on the build host so Prisma Client TypeScript types include the new enum value
   - `next build` succeeded
2. **DB state**:
   - Tenants + at least one user + one MCP client created (use existing dashboard or seed)
   - `mcp_clients.is_active = true`
   - `audit_logs` table writable; `audit_outbox` worker (if enabled) running
3. **Operator credentials** ready:
   - DB superuser (`passwd_user`) for direct row inspection — use `docker compose exec db psql -U passwd_user -d passwd_sso`
   - `passwd_app` role active for the running app process (RLS enforced in dev/prod)
4. **Test scaffolding** (replace placeholders before running):
   - `<test-mcp-client-id>` — value of `mcp_clients.client_id` for the test client
   - `<test-client-secret>` — plaintext of the test client's secret (NOT the hash; see "Secret reconstruction" below if no plaintext is recorded — for a freshly created DCR client the secret is shown once at registration and not stored)
   - `<test-tenant-id>` — UUID of the test tenant
   - `<test-user-email>` — email of an existing test user (use `<test@example.com>`-style placeholder per RS4)

**Secret reconstruction**: if the test client's plaintext secret was not preserved at registration, create a new test client via the dashboard (`/dashboard/tenant/mcp-clients`) — the secret is shown once and copy-able. Use that for the duration of this test plan.

---

## Steps

Sections marked `(destructive — operator-only)` mutate persistent state and should not be re-run after the rollback section.

### Step 1: Issue an initial token pair (sequential happy-path)

Use the OAuth Authorization Code + PKCE flow to obtain an access + refresh token pair. Easiest path: hit `/api/mcp/authorize` then `/api/mcp/token` with `grant_type=authorization_code` from a test MCP client (see [Anthropic's MCP CLI](https://modelcontextprotocol.io/) or `passwd-sso login --mcp` if the project's CLI supports it).

**Capture**:
- `<refresh-token-A>` — the plaintext `refresh_token` in the response (starts with `mcpr_`)
- `<access-token-A>` — the plaintext `access_token` (starts with `mcp_`)

### Step 2: Sequential refresh exchange (baseline)

```
curl -i -X POST http://localhost:3000/api/mcp/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "refresh_token=<refresh-token-A>" \
  -d "client_id=<test-mcp-client-id>" \
  -d "client_secret=<test-client-secret>"
```

**Expected result**:
- HTTP 200
- Response body contains `access_token`, `refresh_token`, `token_type: "Bearer"`, `expires_in: 3600`, `scope`
- Capture `<refresh-token-B>` and `<access-token-B>` from the response

**DB verification** (as `passwd_user`):
```sql
SELECT id, rotated_at, replaced_by_hash IS NOT NULL AS has_replaced
FROM mcp_refresh_tokens
WHERE token_hash = encode(digest('<refresh-token-A>', 'sha256'), 'hex');
```
- `rotated_at` MUST be non-null (recently rotated)
- `has_replaced` MUST be true

```sql
SELECT id, revoked_at IS NOT NULL AS revoked
FROM mcp_access_tokens
WHERE token_hash = encode(digest('<access-token-A>', 'sha256'), 'hex');
```
- `revoked` MUST be true (old AT revoked during rotation)

```sql
SELECT id, revoked_at
FROM mcp_access_tokens
WHERE token_hash = encode(digest('<access-token-B>', 'sha256'), 'hex');
```
- `revoked_at` MUST be null (new AT is live)

**Audit verification**:
```sql
SELECT action, metadata->>'familyId' AS family_id
FROM audit_logs
WHERE tenant_id = '<test-tenant-id>'
  AND action = 'MCP_REFRESH_TOKEN_ROTATE'
ORDER BY created_at DESC LIMIT 1;
```
- One row, recent timestamp

### Step 3: Replay detection (sequential)

Re-submit `<refresh-token-A>` (the now-rotated token):

```
curl -i -X POST http://localhost:3000/api/mcp/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "refresh_token=<refresh-token-A>" \
  -d "client_id=<test-mcp-client-id>" \
  -d "client_secret=<test-client-secret>"
```

**Expected result**:
- HTTP 400
- Response body: `{"error": "invalid_grant"}`

**DB verification — fail-closed family revocation must persist**:
```sql
SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL) AS unrevoked
FROM mcp_refresh_tokens
WHERE family_id = (
  SELECT family_id FROM mcp_refresh_tokens
  WHERE token_hash = encode(digest('<refresh-token-A>', 'sha256'), 'hex')
);
```
- `unrevoked` MUST be 0 (entire family revoked)

```sql
SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL) AS unrevoked
FROM mcp_access_tokens at
WHERE EXISTS (
  SELECT 1 FROM mcp_refresh_tokens rt
  WHERE rt.access_token_id = at.id
    AND rt.family_id = (
      SELECT family_id FROM mcp_refresh_tokens
      WHERE token_hash = encode(digest('<refresh-token-A>', 'sha256'), 'hex')
    )
);
```
- `unrevoked` MUST be 0 (all family ATs revoked, including the previously-live `<access-token-B>`)

**Audit verification — replay event recorded**:
```sql
SELECT action, metadata
FROM audit_logs
WHERE tenant_id = '<test-tenant-id>'
  AND action = 'MCP_REFRESH_TOKEN_REPLAY'
ORDER BY created_at DESC LIMIT 1;
```
- One row with `metadata.reason = 'replay'` and `metadata.familyId = <captured-family-id>`

### Step 4: Verify access token rejection after family revocation

```
curl -i -X GET http://localhost:3000/api/mcp \
  -H "Authorization: Bearer <access-token-B>"
```

**Expected result**:
- HTTP 401 (token revoked — was a member of the now-revoked family)
- Body: `{"error": "invalid_token"}` (or equivalent rejection)

### Step 5: Issue a fresh token pair for race testing

Repeat Step 1 to obtain a new `<refresh-token-C>` and `<access-token-C>` (fresh family — separate from the now-revoked Step 1-3 family).

### Step 6: Concurrent rotation race (the production fix proof)

Run two refresh requests in parallel against the SAME `<refresh-token-C>`:

```
# Use a shell that supports parallel execution. Example with bash:
(curl -s -o /tmp/race-A.txt -w "A:%{http_code}\n" -X POST http://localhost:3000/api/mcp/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "refresh_token=<refresh-token-C>" \
  -d "client_id=<test-mcp-client-id>" \
  -d "client_secret=<test-client-secret>" &) ; \
(curl -s -o /tmp/race-B.txt -w "B:%{http_code}\n" -X POST http://localhost:3000/api/mcp/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "refresh_token=<refresh-token-C>" \
  -d "client_id=<test-mcp-client-id>" \
  -d "client_secret=<test-client-secret>") ; \
wait
cat /tmp/race-A.txt /tmp/race-B.txt
```

**Expected result**:
- Exactly one of A/B returns HTTP 200 with `access_token` + `refresh_token`
- The other returns HTTP 400 with `{"error": "invalid_grant"}`
- (Less common, equally valid) BOTH may return 400 if the requests serialized at the connection-pool level — this is acceptable as long as ZERO requests return 200 with both succeeding. The "never both succeed" invariant is the security property; per-request serialization is implementation-detail noise.

**Note**: rate limiter is 10/min per `client_id`; this single race attempt is well under the limit. If you re-run this test more than 10 times in 60s, expect `429 slow_down` responses unrelated to the fix.

**DB verification — fail-closed family revocation under race**:
```sql
SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL) AS unrevoked,
       COUNT(*) AS total
FROM mcp_refresh_tokens
WHERE family_id = (
  SELECT family_id FROM mcp_refresh_tokens
  WHERE token_hash = encode(digest('<refresh-token-C>', 'sha256'), 'hex')
);
```
- `unrevoked` MUST be 0 (entire family revoked, including the winner's freshly-issued tokens)
- `total` MUST be ≥ 2 (the original RT plus winner's new RT — confirms the race was attempted, not just rejected at validation)

**Audit verification — concurrent rotation event recorded**:
```sql
SELECT action, metadata
FROM audit_logs
WHERE tenant_id = '<test-tenant-id>'
  AND action = 'MCP_REFRESH_TOKEN_FAMILY_REVOKED'
ORDER BY created_at DESC LIMIT 1;
```
- One row with `metadata.reason = 'concurrent_rotation'` AND `metadata.familyId = <captured-family-id>`

---

## Adversarial scenarios (Tier-2 mandatory)

### A1: Token theft + race-then-victim-abandons (the fix's primary target)

**Threat**: attacker steals victim's `<refresh-token>`. Victim's client also tries to refresh at the same time. Without the fix, attacker could win the race and keep tokens until expiry if victim gives up retry. With the fix, family revoked the moment Phase 2 commits.

**Steps**:
1. Issue fresh token pair (Step 5 procedure) → capture `<refresh-token-D>`
2. From two terminals, fire the same race as Step 6 — simulate "victim" + "attacker" presenting the same token.
3. Whichever request returns 200 (the "attacker"), capture its `<access-token-attacker>`.
4. Wait 5 seconds (Phase 2 revocation commits within milliseconds of Phase 1; the pause is a generous margin).
5. Try to use `<access-token-attacker>` to call `GET /api/mcp` — must return 401 (revoked as part of family).

**Expected**: attacker token revoked even though attacker "won" the race. Victim must re-authenticate. This is the fail-closed guarantee.

### A2: Cross-tenant refresh token use

**Threat**: a refresh token issued for tenant A, presented with `client_id` belonging to tenant B's MCP client.

**Steps**:
1. Create a second tenant + a second MCP client in that tenant. Capture `<test-mcp-client-id-tenant-B>` and `<test-client-secret-tenant-B>`.
2. Issue a refresh token for tenant A's client (Step 1).
3. Submit it with tenant B's `client_id` + secret.

**Expected**: HTTP 401 with `{"error": "invalid_client"}` — `rt.mcpClient.clientId !== params.clientId` rejects the rotation.

### A3: Replay after family revocation

**Threat**: attacker captured an access token from earlier in the family's lifetime; tries to use it after Phase 2 revocation has fired.

**Steps**:
1. Run Step 6 (race scenario). Capture `<access-token-pre-revocation>` from the winner's response.
2. Within 1 second, use it: `curl -H "Authorization: Bearer <access-token-pre-revocation>" GET /api/mcp/...`. May succeed (Phase 2 latency window — documented).
3. Wait 5 seconds. Use it again.

**Expected**:
- 1-second-after attempt MAY succeed (within Phase 1→Phase 2 commit window, ~ms; documented residual TOCTOU). This is bounded by DB write latency.
- 5-seconds-after attempt MUST fail with 401 (revoked).

### A4: Audit log integrity — no plaintext token leakage

```sql
SELECT metadata
FROM audit_logs
WHERE tenant_id = '<test-tenant-id>'
  AND action IN ('MCP_REFRESH_TOKEN_REPLAY', 'MCP_REFRESH_TOKEN_FAMILY_REVOKED', 'MCP_REFRESH_TOKEN_ROTATE')
ORDER BY created_at DESC LIMIT 10;
```

**Expected**: no `metadata` row contains a substring matching `mcp_` or `mcpr_` followed by base64url chars (would indicate a plaintext token was logged). `familyId` (UUID) and `clientId` (`mcpc_...`) are expected; bearer tokens MUST NOT appear.

### A5: Migration rollback safety

**Threat**: post-deploy decision to rollback. Verify the migration is reversible without data loss to MCP token rows.

**Steps** (NOT EXECUTED in normal verification — this is a planning artifact):
1. The migration only adds an enum value. PostgreSQL `ALTER TYPE ADD VALUE` cannot be reversed (no `ALTER TYPE DROP VALUE` in standard SQL).
2. Code rollback (revert oauth-server.ts) is safe even with the new enum value still present in the DB — the OLD code never references it.

**Expected**: rollback is one-way for the schema (acceptable — the new value just sits unused), and the code revert is clean.

---

## Expected results summary

| Step | Expected HTTP | Expected DB invariants | Expected audit |
|------|--------------|------------------------|----------------|
| 1 (initial issue) | 200 | new RT, new AT live | `MCP_AUTHORIZATION_CODE_EXCHANGE` (existing) |
| 2 (sequential refresh) | 200 | old RT rotated_at set; new RT live | `MCP_REFRESH_TOKEN_ROTATE` |
| 3 (replay) | 400 invalid_grant | family fully revoked | `MCP_REFRESH_TOKEN_REPLAY` with reason='replay' |
| 4 (revoked AT use) | 401 invalid_token | (no change) | (none — auth failure logged elsewhere) |
| 6 (race) | 200 + 400 (or 400+400) | family fully revoked incl. winner's new RT/AT | `MCP_REFRESH_TOKEN_FAMILY_REVOKED` with reason='concurrent_rotation' |
| A2 (cross-tenant) | 401 invalid_client | (no mutation) | (existing client-mismatch audit) |

---

## Rollback

### Code rollback (safe, fully reversible)

```bash
git revert 55672431..HEAD~1   # Revert Phase 3 review fixes + final review log
git revert 71c20b87           # Revert i18n + lint downstream fixes
git revert 9d834e44           # Revert crypto adversarial tests
git revert a9cb72a8           # Revert tenant-swap test
git revert b9560a3f           # Revert MCP race test
git revert bc8838d4           # Revert MCP race fix (production)
git revert 3861ecb8           # Revert scaffolding (helpers + audit constants + CI + schema)
```

Or, simpler: reset the branch and force-push (only if no other PRs depend on these commits).

After code revert: existing MCP token rotation reverts to the prior behavior (concurrent rotation race exists but undetected; production runs as before this PR). No data corruption.

### Schema rollback (irreversible — operator-only, NOT recommended)

The `MCP_REFRESH_TOKEN_FAMILY_REVOKED` enum value cannot be dropped from `AuditAction` in PostgreSQL. After code revert:
- The enum value remains in the DB schema (harmless — code never writes it after revert)
- No audit_logs rows reference it (so no FK / type cast issues)
- A future re-deploy of this PR would be a no-op for the schema (migration sees enum value already present, idempotent)

If the audit_logs already contains rows with `action = 'MCP_REFRESH_TOKEN_FAMILY_REVOKED'` (from this PR being live), revert is still safe — the OLD code never reads the action by enum-narrowed type, only emits it. Existing rows remain readable as historical audit data.

### Worker rollback (audit_outbox)

If `audit_outbox` worker is running and processing rows, no special handling needed. The new audit action emits via the same `logAuditAsync` path; it goes to `audit_outbox` and the worker drains it normally.

---

## Operator sign-off

After running Steps 1-6 + Adversarial scenarios A1-A4 against a non-production environment:

- [ ] Step 1: initial token issue OK
- [ ] Step 2: sequential rotation OK; old RT rotated, old AT revoked, new tokens live
- [ ] Step 3: replay rejected with HTTP 400; family fully revoked; audit row present
- [ ] Step 4: revoked AT rejected with HTTP 401
- [ ] Step 5: fresh token pair issued for race scenario
- [ ] Step 6: race scenario produces ≤1 success + ≥1 failure; family fully revoked; `MCP_REFRESH_TOKEN_FAMILY_REVOKED` audit row with `metadata.reason = 'concurrent_rotation'` present
- [ ] A1: attacker's "won" token revoked within ~5s
- [ ] A2: cross-tenant rejected with `invalid_client`
- [ ] A3: Phase 1→2 latency window bounded; post-window AT use rejected
- [ ] A4: no plaintext bearer tokens in audit_logs metadata

**Operator name**: ______________
**Environment**: ______________ (e.g., `staging`, `dev-cluster`)
**Timestamp**: ______________
**Notes**: ______________
