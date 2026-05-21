# OWASP Top 10 Audit Findings — Batch 3 Plan (Revised)

## Project Context

- **Type**: Web app (Next.js 16 App Router) + service workers (audit-outbox, dcr-cleanup)
- **Test infrastructure**: unit (vitest) + integration (vitest.integration) + E2E (playwright) + CI/CD
- **Pre-1.0**: Yes — backwards-incompatible data shape changes are acceptable when called out

## Changelog vs Round 1

- C13 (REVOKE) expanded from single migration to **stored-procedure approach**: REVOKE UPDATE/DELETE on `audit_logs`, then expose `SECURITY DEFINER` procedures `audit_logs_tenant_migrate` and `audit_logs_purge` (owned by `passwd_user`) that `passwd_app` is granted EXECUTE on. This preserves correctness of `src/auth.ts:130` tenant merge and `src/app/api/maintenance/purge-audit-logs/route.ts` without breaking either.
- C8 (JIT) now includes Prisma migration adding `requesterUserId` + `requesterServiceAccountId` to `AccessRequest`, with pre-1.0 migration policy: existing PENDING rows transition to `CANCELLED`.
- C1 Consumer-flow extended to include CLI (8 files), `emergency-access/[id]/vault/page.tsx`, `audit-logs/page.tsx`, `use-watchtower.ts`, `password-card.tsx`, and corrected path typo (`.ts` not `.tsx`).
- C19 model name corrected to `PersonalLogAccessGrant` (not `BreakGlassGrant`); email uses existing `src/lib/email/{resend,smtp}-provider.ts` providers.
- C12 path corrected to `src/lib/security/rate-limiters.ts`; IPv6 normalisation explicitly via `rateLimitKeyFromIp`.
- C2 history restore flow defined as two-step (decrypt with history AAD → re-encrypt with entry AAD).
- C18 TOCTOU explicitly: pre-1.0 soft-cap accepted with documented +N concurrency tolerance, where N = max-concurrency observed.
- C3 backward-compat removed (pre-1.0). HMAC binds `${kv}|${payload}`.
- C6 tx-ordering + fail-mode defined.
- C7 scope changed to `allTenants: true`.
- C9 helper changed to existing `requireRecentCurrentAuthMethod`.
- C10 changed to audit-warning-only (not reject).
- C11 identifierHash adds tenant pepper.
- C14 adds new `passwd_audit_chain_verifier` DB role + env var + docker-compose service; worker emits `CHAIN_VERIFY_HEARTBEAT` for liveness.
- C20 removes `auditOutbox` check from `/ready` entirely.
- C21 reclassified as hygiene (no specific CVE driver identified during planning).
- C24 added: `.github/dependabot.yml` for grouped Actions SHA bumps.
- Removed from C13: `audit_anchor_manifests` reference (table does not exist).

## Objective

Close all High and Medium severity OWASP audit findings (2026-05-21) except three explicitly deferred items, landing as a single PR with logically-separated commits across 5 implementation clusters.

## Audit Findings In Scope (25 items: 7 High + 18 Medium)

### Cluster A — Cryptographic Failures (5)
A02-1 (H), A02-2 (H), A02-3 (M), A02-4 (M), A02-5 (M)

### Cluster B — Session / Authentication (7)
A07-1 (H), A07-3 (M), A01-1 (M), A01-2 (M), A07-2 (M), A09-1 (H), A04-6 (M)

### Cluster C — Audit & Integrity (6)
A04-2 (H), A04-3 (H), A08-2 (M), A09-2 (M), A09-3 (M), A09-4 (M)

### Cluster D — Operational (3)
A04-1 (H), A04-5 (M), A05-1 (M)

### Cluster E — Supply Chain (4)
A06-1 (M), A06-3 (M), A06-4 (M), A08-1 (M) — and new locked C24

## Explicitly Out of Scope

- A06-2 argon2-browser → hash-wasm (separate PR)
- A04-7 GDPR self-delete (separate plan)
- A04-4 master-key rotation dual-approval (separate scope)
- All Low/Info findings

## Contracts (Stable IDs)

### C1 — Personal entry AAD: add `vaultType`

- **File**: [src/lib/crypto/crypto-aad.ts:102-107](../../src/lib/crypto/crypto-aad.ts#L102)
- **Signature** (current → new):
  ```ts
  // current
  buildPersonalEntryAAD(userId: string, entryId: string): Uint8Array
  // new
  buildPersonalEntryAAD(userId: string, entryId: string, vaultType: "blob" | "overview"): Uint8Array
  ```
- **Implementation**: `buildAADBytes(SCOPE_PERSONAL, 3, [userId, entryId, vaultType])` (was `2`/`[userId, entryId]`)
- **Pre-1.0 break**: `aadVersion=1` retained; existing personal entries CANNOT be decrypted post-upgrade. CHANGELOG must call this out as `BREAKING CHANGE: personal entry encryption AAD format changed; all existing personal entries cannot be decrypted post-upgrade.`
- **Invariant**: every call site passes `vaultType` explicitly.
- **Forbidden pattern**: `buildPersonalEntryAAD\([^,]+,\s*[^,]+\)` — regex must NOT match (3rd arg required).

### C2 — Personal history AAD scope (new): `buildPersonalHistoryAAD`

- **File**: [src/lib/crypto/crypto-aad.ts](../../src/lib/crypto/crypto-aad.ts)
- **New signature**:
  ```ts
  buildPersonalHistoryAAD(userId: string, entryId: string, historyId: string): Uint8Array
  ```
- **New scope identifier**: `SCOPE_PERSONAL_HISTORY = "PH"` (length-prefixed binary form, 3-field, aadVersion=1)
- **Restore flow** (Consumer 2): decrypt history row with `buildPersonalHistoryAAD(userId, entryId, historyId)` → re-encrypt with `buildPersonalEntryAAD(userId, entryId, "blob")` → UPDATE PasswordEntry.encryptedBlob in tx.
- **Pre-1.0 break**: same as C1 — existing history rows undecryptable.

### C3 — share-access-token version-aware

- **File**: [src/lib/auth/tokens/share-access-token.ts](../../src/lib/auth/tokens/share-access-token.ts)
- **Token format**: `${kv}.${payloadB64}.${signature}` (3 dot-separated segments)
- **HMAC input**: `${kv}|${payloadB64}` (kv bound into signature)
- **Signing key derivation**: `"share-access-token-v" + kv` as HKDF info string from master key version `kv`
- **No backward compat** (pre-1.0): tokens without `kv:` prefix are rejected. Token TTL is 5 min so impact window is bounded.
- **Forward-compat caveat**: rollback after deploy invalidates `kv:` tokens — acceptable pre-1.0; documented in deploy-notes.

### C4 — Webhook secret v1 retirement

- **Files**: [src/lib/webhook-dispatcher.ts:163-174](../../src/lib/webhook-dispatcher.ts#L163), [src/lib/crypto/webhook-aad.ts](../../src/lib/crypto/webhook-aad.ts)
- **Drop**: `secretAadVersion === 1` decrypt branch in webhook-dispatcher
- **Migration**: new `scripts/migrate-webhook-secrets-v1-to-v2.ts` (CLI + exported main function for tests). Idempotent. Walks all `WebhookEndpoint` rows where `secretAadVersion=1`, decrypts with legacy AAD, re-encrypts with v2 AAD, atomically updates `secretAadVersion=2` and ciphertext.
- **Deploy ordering** (3-phase):
  1. Phase A: deploy new code that READS v1 AND v2 (transient — single release with both branches retained).
  2. Phase B: operator runs migration script.
  3. Phase C: next release drops the v1 read branch (this PR is Phase C — Phase A/B assumed completed by operators before merging this PR; if not, operators must run migration during scheduled maintenance with webhook delivery paused).
- **Fail-closed**: post-migration, encountering `secretAadVersion=1` throws `WebhookSecretVersionError`.

### C5 — Directory sync key HKDF

- **File**: [src/lib/key-provider/env-provider.ts:118-131](../../src/lib/key-provider/env-provider.ts#L118)
- **Replace** the direct `SHARE_MASTER_KEY_V1` fallback in dev/test with:
  ```ts
  hkdfSync("sha256", masterKeyV1, /*salt*/ Buffer.alloc(0), "dirsync-derive", 32)
  ```
- **Domain-separation literal table** (collision check): `"verifier-pepper:"`, `"share-access-token-v1"` (C3 new), `"dirsync-derive"` (this) — all distinct. Production uses dedicated env var, this fallback only fires when `DIRECTORY_SYNC_KEY` env is unset (dev/test).

### C6 — Session invalidation on passphrase change / recovery (with fail-mode)

- **Files**: [src/app/api/vault/change-passphrase/route.ts](../../src/app/api/vault/change-passphrase/route.ts), [src/app/api/vault/recovery-key/recover/route.ts](../../src/app/api/vault/recovery-key/recover/route.ts)
- **Call site**: AFTER the existing `prisma.$transaction(...)` commits successfully (separate connection, not nested in bypass-RLS scope).
- **Signature**: `await invalidateUserSessions(userId, { allTenants: true, reason: "change_passphrase" | "recovery_recover" })`
- **Failure handling**: if invalidate throws OR `cacheTombstoneFailures > 0`:
  - Always emit audit metadata with the failure detail (already supported by `InvalidateUserSessionsResult`)
  - If throw: return HTTP 500 with `code: "session_invalidate_failed"`. Client UI must instruct user to manually sign out other devices.
  - Passphrase is already changed; do NOT attempt rollback (would be more dangerous).

### C7 — Passkey signin: full cascade across all tenants

- **File**: [src/app/api/auth/passkey/verify/route.ts:111-167](../../src/app/api/auth/passkey/verify/route.ts#L111)
- **Replace**: `await revokeAllExtensionTokensForUser(user.id)` (current)
- **With**: `await invalidateUserSessions(user.id, { allTenants: true, reason: "passkey_reauth" })`
- **Rationale**: passkey is a global authenticator (AAL3 re-establish). Even though current passkey usage is gated to bootstrap-tenant, the invalidation should match the credential's scope to prevent half-revoked state if multi-tenant access expands.

### C8 — JIT access self-approval prevention

- **Schema migration** (new): `prisma/migrations/<ts>_access_request_requester/migration.sql`:
  ```sql
  ALTER TABLE access_requests
    ADD COLUMN requester_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN requester_service_account_id UUID NULL REFERENCES service_accounts(id) ON DELETE SET NULL,
    ADD CONSTRAINT access_requests_requester_xor
      CHECK ((requester_user_id IS NOT NULL) <> (requester_service_account_id IS NOT NULL));
  -- Pre-1.0 cleanup: existing PENDING rows without requester info are CANCELLED
  UPDATE access_requests SET status = 'CANCELLED' WHERE status = 'PENDING' AND requester_user_id IS NULL AND requester_service_account_id IS NULL;
  CREATE INDEX idx_access_requests_requester_user ON access_requests(requester_user_id) WHERE requester_user_id IS NOT NULL;
  CREATE INDEX idx_access_requests_requester_sa ON access_requests(requester_service_account_id) WHERE requester_service_account_id IS NOT NULL;
  ```
- **Prisma model**: add `requesterUserId String? @db.Uuid` + `requesterServiceAccountId String? @db.Uuid` with relations.
- **Write sites**:
  - Admin-create (session auth, `src/app/api/tenant/access-requests/route.ts` POST): set `requesterUserId = session.user.id`.
  - SA-self-service (`sa_` token, same route): set `requesterServiceAccountId = saId`.
- **Approve check** ([src/app/api/tenant/access-requests/[id]/approve/route.ts:42-50](../../src/app/api/tenant/access-requests/[id]/approve/route.ts#L42)):
  ```ts
  if (request.requesterUserId !== null && request.requesterUserId === session.user.id) {
    return forbidden({ code: "forbidden_self_approval" });
  }
  if (request.requesterServiceAccountId !== null) {
    const sa = await prisma.serviceAccount.findUnique({ where: { id: request.requesterServiceAccountId }, select: { createdById: true } });
    if (sa?.createdById === session.user.id) {
      return forbidden({ code: "forbidden_self_approval" });
    }
  }
  if (request.requesterUserId === null && request.requesterServiceAccountId === null) {
    return badRequest({ code: "invalid_request", message: "requester not recorded" });
  }
  ```

### C9 — WebAuthn DELETE step-up

- **File**: [src/app/api/webauthn/credentials/[id]/route.ts:20-57](../../src/app/api/webauthn/credentials/[id]/route.ts#L20)
- **Helper** (existing): [`requireRecentCurrentAuthMethod`](../../src/lib/auth/session/recent-current-auth-method.ts) — re-asserts current session's auth method (passkey users re-prove passkey, password users re-prove password); semantics already vetted in [src/__tests__/db-integration/require-recent-session.integration.test.ts](../../src/__tests__/db-integration/require-recent-session.integration.test.ts).
- **Call**: `await requireRecentCurrentAuthMethod(req, { maxAgeSeconds: 900 })` at top of DELETE handler. On failure: returns `401 step_up_required`.

### C10 — Counter==0 device warning (NOT reject)

- **File**: [src/lib/auth/webauthn/webauthn-authorize.ts:137-147](../../src/lib/auth/webauthn/webauthn-authorize.ts#L137)
- **Implementation**: after existing CAS, if `storedCredential.counter === 0 && newCounter === 0 && (Date.now() - storedCredential.lastUsedAt.getTime()) < 5000`, EMIT audit warning event `AUDIT_ACTION.WEBAUTHN_COUNTER_ZERO_RAPID_REUSE` (new constant) with `{ credentialId, intervalMs }` metadata. DO NOT reject the auth.
- **Rationale**: 5-sec heuristic produces false positives on legitimate rapid Touch ID re-auth. Primary defense is the signCount CAS (existing). This is defense-in-depth audit telemetry.

### C11 — `AUTH_LOGIN_FAILURE` audit event

- **Files**: [src/lib/constants/audit/audit.ts](../../src/lib/constants/audit/audit.ts) (`AUDIT_ACTION` const), [src/auth.ts](../../src/auth.ts) (events + signIn callback), `messages/{en,ja}.json`, `src/lib/audit/audit-action-groups.ts` (or similar grouping module).
- **New constants**: `AUDIT_ACTION.AUTH_LOGIN_FAILURE`, also `WEBAUTHN_COUNTER_ZERO_RAPID_REUSE` (C10).
- **Emission points** in `src/auth.ts`:
  - `signIn` callback returning `false` (provider-specific reject) → emit with `reason: "credential_mismatch"`, identifierHash.
  - `events.signIn` not called on failure — instead, hook the `error` callback OR wrap provider authorize.
  - For magic-link expired/used: hook in the Email provider verification path.
- **Metadata** (pre-PII): `{ provider: "google" | "saml" | "email" | "passkey" | "credentials", reason: "unknown_email" | "tenant_mismatch" | "provider_error" | "magic_link_expired" | "credential_mismatch", identifierHash: string }`
- **identifierHash**: `hmac_sha256(process.env.AUDIT_IDENTIFIER_PEPPER, email + ":" + tenantId).slice(0, 16)` (16 hex = 64 bits, sufficient for non-correlatable forensics within tenant scope; tenant binding prevents cross-tenant correlation).
- **New env var**: `AUDIT_IDENTIFIER_PEPPER` (32+ hex chars, generated via `npm run generate:key`) — add to env-schema, .env.example, init-env prompt.
- **Group membership**: register in the AUTH group definition (locate during impl).
- **i18n keys**: `auth_login_failure` (en + ja) — match existing snake_case convention.

### C12 — Magic-link per-IP rate-limit

- **File**: [src/lib/security/rate-limiters.ts](../../src/lib/security/rate-limiters.ts) (add new limiter)
- **New limiter**: `magicLinkIpLimiter` — `{ windowMs: 600_000, max: 10 }` (10 per IP per 10 min)
- **Key derivation**: `rateLimitKeyFromIp(extractClientIp(req))` (IPv6 → /64 prefix bucket; reference [src/lib/security/ip-rate-limit.ts](../../src/lib/security/ip-rate-limit.ts) or wherever the helper lives — search at impl time).
- **Wire-up**: invoke in the Auth.js Email Provider `sendVerificationRequest` path (`src/auth.config.ts:108`) BEFORE the existing per-email limiter, so IP exhaustion is checked first.

### C13 — Audit-log integrity via REVOKE + SECURITY DEFINER procedures

- **Critical context**: current code at [src/auth.ts:136](../../src/auth.ts#L136) (tenant-merge `auditLog.updateMany`) and [src/app/api/maintenance/purge-audit-logs/route.ts](../../src/app/api/maintenance/purge-audit-logs/route.ts) (`auditLog.deleteMany`) both run as `passwd_app`. A naked REVOKE would break both.
- **Approach**: keep correctness by routing privileged mutations through PostgreSQL `SECURITY DEFINER` stored procedures owned by `passwd_user` (schema owner). `passwd_app` is granted EXECUTE on the procedures but loses generic UPDATE/DELETE.
- **Migration**: new `prisma/migrations/<ts>_audit_log_revoke_via_definer/migration.sql`:
  ```sql
  -- 1. Create privileged procedures (owned by passwd_user, the migrate role)
  CREATE OR REPLACE PROCEDURE audit_log_tenant_migrate(
    p_user_id UUID, p_from_tenant UUID, p_to_tenant UUID
  ) LANGUAGE SQL SECURITY DEFINER AS $$
    UPDATE audit_logs SET tenant_id = p_to_tenant
    WHERE user_id = p_user_id AND tenant_id = p_from_tenant;
  $$;

  CREATE OR REPLACE FUNCTION audit_log_purge(
    p_tenant_id UUID, p_cutoff TIMESTAMPTZ
  ) RETURNS INTEGER LANGUAGE SQL SECURITY DEFINER AS $$
    WITH d AS (DELETE FROM audit_logs WHERE tenant_id = p_tenant_id AND created_at < p_cutoff RETURNING 1)
    SELECT COUNT(*)::INT FROM d;
  $$;

  -- 2. REVOKE generic mutations from passwd_app
  REVOKE UPDATE, DELETE ON audit_logs FROM passwd_app;
  REVOKE UPDATE, DELETE ON audit_chain_anchors FROM passwd_app;
  -- (audit_anchor_manifests does NOT exist — omitted)

  -- 3. GRANT EXECUTE on the definer functions to passwd_app
  GRANT EXECUTE ON PROCEDURE audit_log_tenant_migrate(UUID, UUID, UUID) TO passwd_app;
  GRANT EXECUTE ON FUNCTION audit_log_purge(UUID, TIMESTAMPTZ) TO passwd_app;
  ```
- **Code refactor**:
  - `src/auth.ts:136` — replace `tx.auditLog.updateMany(...)` with `tx.$executeRaw\`CALL audit_log_tenant_migrate(${userId}::uuid, ${existingTenantId}::uuid, ${found.id}::uuid)\`;`
  - `src/app/api/maintenance/purge-audit-logs/route.ts` — replace the `auditLog.deleteMany` with `tx.$queryRaw<{ rows_deleted: number }[]>\`SELECT audit_log_purge(${tenantId}::uuid, ${cutoffDate}::timestamptz) AS rows_deleted\``
- **Verification**: TABLE OWNER for `audit_logs` / `audit_chain_anchors` must be `passwd_user` (NOT `passwd_app`); confirm via `\dt+ audit_logs` in migration test.
- **Anchor publisher role** (separate concern): if `audit-anchor-publisher.ts` runs as `passwd_outbox_worker`, this REVOKE doesn't affect it. If it runs as `passwd_app`, it needs its own stored procedure OR a separate role. Verify during impl; add Adjacent finding if discovered to run as passwd_app.

### C14 — `audit-chain-verify` worker

- **New file**: `scripts/audit-chain-verify-worker.ts`. Exports `verifyTenantChain(tenantId, deps): Promise<VerifyResult>` as pure function for unit testability.
- **New DB role**: `passwd_audit_chain_verifier` (SELECT ON audit_logs, audit_chain_anchors, tenants; INSERT ON audit_outbox for emit). Added in same migration as C13.
- **New env vars**: `AUDIT_CHAIN_VERIFY_DATABASE_URL`, `PASSWD_AUDIT_CHAIN_VERIFY_PASSWORD` (analogous to existing `PASSWD_OUTBOX_WORKER_PASSWORD`).
- **package.json**: `"worker:audit-chain-verify": "tsx scripts/audit-chain-verify-worker.ts"`
- **docker-compose**: new service `audit-chain-verify-worker` mirroring `audit-outbox-worker` config.
- **Loop behavior**: hourly tick; for each tenant: walk chain, on failure → pino error + `Sentry.captureException` + audit emit `CHAIN_VERIFY_FAILED` (hysteresis: only emit once per tenant per 24h while in failed state).
- **Liveness**: every successful hourly tick emits one `CHAIN_VERIFY_HEARTBEAT` audit event with empty metadata. Operators monitor: no heartbeat in 2h → page.

### C15 — Chain verify bail at first tamper

- **File**: [src/app/api/maintenance/audit-chain-verify/route.ts:266-273](../../src/app/api/maintenance/audit-chain-verify/route.ts#L266)
- **Behavior change**: on first tamper detection, break the walk loop. Response shape:
  ```ts
  { ok: false, walkedThrough: number, firstTamperedSeq: number, results: Array<{ seq: number; verified: boolean | null; unverified: boolean }> }
  ```
  - `walkedThrough`: count of rows verified before tamper.
  - All rows with `seq >= firstTamperedSeq` get `verified: null, unverified: true`.

### C16 — Outbox depth Sentry alert (with hysteresis + sustained re-alert)

- **File**: [scripts/audit-outbox-worker.ts](../../scripts/audit-outbox-worker.ts) (verify exact path)
- **Trigger**: `pending > OUTBOX_READY_PENDING_THRESHOLD` OR `oldestPendingAgeSeconds > 3600`
- **Hysteresis**: track previous alarmed state in worker memory; emit alert on (a) state transition (clear → alarm) AND (b) every 24h while still in alarmed state.
- **Emission**: `Sentry.captureMessage("outbox.depth.alert", "error")` + pino error with structured fields.

### C17 — Alert hook documentation

- **New file**: `docs/operations/alerts.md`
- **Contents**: SIEM query examples for `_logType: "audit-dead-letter"`, `csp.violation`, `outbox.depth.alert`, `chain.verify.failed`. Templates for Datadog, Loki, Splunk.

### C18 — Resource quotas (env-based, soft-cap)

- **New file**: `src/lib/quota/resource-quotas.ts`
- **Signature**:
  ```ts
  export async function assertQuotaAvailable(
    scope: { userId?: string; tenantId?: string },
    resource: "passwords" | "attachment_bytes" | "share_links" | "webhooks",
    increment: number
  ): Promise<void>;  // throws QuotaExceededError
  ```
- **Env vars** (defaults):
  ```
  QUOTA_MAX_PASSWORDS_PER_USER=10000
  QUOTA_MAX_ATTACHMENT_BYTES_PER_USER=1073741824
  QUOTA_MAX_SHARE_LINKS_PER_USER=1000
  QUOTA_MAX_WEBHOOKS_PER_TENANT=100
  ```
- **TOCTOU policy** (pre-1.0 soft-cap accepted): `SELECT SUM/COUNT` then check. Concurrent inserts may overshoot by N (where N = concurrency). Documented in commit message. Hard-cap deferred to plan-based quotas (separate PR with per-plan limits).
- **Error envelope**: `code: "quota_exceeded"`, HTTP 403 (NOT 429 — distinct from rate limits). Body includes `{ resource, current, max }`.
- **Wire-up sites**:
  - `src/app/api/passwords/route.ts` POST → `assertQuotaAvailable({ userId }, "passwords", 1)`
  - `src/app/api/passwords/[id]/attachments/route.ts` POST → `assertQuotaAvailable({ userId }, "attachment_bytes", fileSize)`
  - `src/app/api/share-links/route.ts` POST → `assertQuotaAvailable({ userId }, "share_links", 1)`
  - `src/app/api/tenant/webhooks/route.ts` POST + per-team variant → `assertQuotaAvailable({ tenantId }, "webhooks", 1)`

### C19 — Break-glass cooling-off + email

- **File**: [src/app/api/tenant/breakglass/route.ts](../../src/app/api/tenant/breakglass/route.ts)
- **Model**: `PersonalLogAccessGrant` (CORRECT name; previous draft had wrong `BreakGlassGrant`)
- **Schema migration**: add `effectiveAt DateTime? @map("effective_at") @db.Timestamptz(3)` to `PersonalLogAccessGrant`. NULL backfill = treated as immediate.
- **POST logic**:
  ```ts
  const recentGrant = await prisma.personalLogAccessGrant.findFirst({
    where: { tenantId, requesterId, targetUserId, createdAt: { gt: new Date(Date.now() - 86400_000) } },
    orderBy: { createdAt: "desc" }
  });
  const coolingOffMs = parseInt(process.env.BREAKGLASS_COOLING_OFF_SECONDS ?? "3600", 10) * 1000;
  const effectiveAt = recentGrant === null ? new Date(Date.now() + coolingOffMs) : null;
  // ... existing create with effectiveAt
  ```
- **Access-time check** (callers of the grant): `WHERE revokedAt IS NULL AND expiresAt > now() AND (effectiveAt IS NULL OR effectiveAt <= now())`
- **Email send**: use existing `src/lib/email/index.ts` provider abstraction (resend or smtp via env). Template: new `src/lib/email/templates/breakglass-grant-notification.ts` with grant details + revocation link. Failure handling: log + audit, do NOT block grant creation. In-app notification (existing path) remains.

### C20 — `/api/health/ready` minimization (remove auditOutbox check entirely)

- **Files**: [src/lib/health.ts:89-124](../../src/lib/health.ts#L89), [src/app/api/health/ready/route.ts](../../src/app/api/health/ready/route.ts)
- **Remove**: the `auditOutbox` check from `runHealthChecks` entirely (worker liveness is not app liveness — Kubernetes ready=false would cause incorrect pod rotation).
- **Response body**: `{ status: "healthy" | "unhealthy" }` only (no `checks` subobject).
- **Status code**: 200 for healthy, 503 for unhealthy (DB/Redis).
- **Detailed metrics**: remain at [src/app/api/maintenance/audit-outbox-metrics/route.ts](../../src/app/api/maintenance/audit-outbox-metrics/route.ts) (auth-gated).

### C21 — SimpleWebAuthn server v9 → v11 (hygiene upgrade)

- **package.json**: `@simplewebauthn/server` `^9.0.3` → `^11.0.0`, `@simplewebauthn/browser` `^9.0.1` → `^11.0.0`
- **Driver**: hygiene (no specific CVE driver found during plan review — v9 LTS receives patches). Justification: stay on supported channel for future security backports.
- **Call sites to update**: `src/lib/auth/webauthn/webauthn-authorize.ts`, `src/app/api/webauthn/register/verify/route.ts`, `src/app/api/webauthn/authenticate/verify/route.ts`, `src/app/api/auth/passkey/verify/route.ts`, plus tests under `src/lib/auth/webauthn/*.test.ts`.
- **Known v9→v11 breakage**: `verifyAuthenticationResponse` result shape (`authenticationInfo.newCounter`, attestation object restructuring), `expectedRPID` accepts `string | string[]`. Verify per call site against npm release notes.

### C22 — `next-auth` beta.30 → beta.31

- **package.json**: `"next-auth": "5.0.0-beta.30"` → `"5.0.0-beta.31"`
- **Verify**: beta.31 exists on npm registry (check before edit). Skim release notes for callback signature changes.

### C23 — GitHub Actions SHA pin

- **Files**: `.github/workflows/*.yml`
- **Action**: pin every `uses:` entry to a 40-char SHA with a trailing `# vX.Y.Z` comment.
- **Targets**: `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`, `dorny/paths-filter`, `aquasecurity/trivy-action`, `github/codeql-action/*`, plus any other floating tag uncovered by grep.
- **Verification**: add a pre-PR grep gate (T13) — `grep -rE 'uses: [^@]+@v[0-9]+' .github/workflows/` must return empty (only `@<40 hex>` allowed).

### C24 — Dependabot for Actions SHA bumps (new contract)

- **New file**: `.github/dependabot.yml` (or extend if exists)
- **Config**: add `github-actions` ecosystem, weekly schedule, group by `actions: { patterns: ["*"] }` so all action bumps land as one PR.

## Consumer-Flow Walkthroughs

### C1 (Personal entry AAD — full consumer list)
1. Browser save: [src/lib/vault/personal-entry-save.ts:38](../../src/lib/vault/personal-entry-save.ts#L38) — single call site; pass `"blob"` for the blob encrypt path. Verify the function actually encrypts both blob and overview; if so, pass `"blob"` and `"overview"` respectively.
2. Browser context: [src/lib/vault/vault-context.tsx:1010](../../src/lib/vault/vault-context.tsx#L1010) (entry decrypt — `"blob"`) and [L1052](../../src/lib/vault/vault-context.tsx#L1052) (history decrypt — actually switches to C2's `buildPersonalHistoryAAD`).
3. Browser detail: [src/components/passwords/detail/password-card.tsx:259](../../src/components/passwords/detail/password-card.tsx#L259) — entry decrypt, pass `"blob"`.
4. Browser audit-logs page: [src/app/[locale]/dashboard/audit-logs/page.tsx:82](../../src/app/[locale]/dashboard/audit-logs/page.tsx#L82) — overview decrypt, pass `"overview"`.
5. Browser emergency-access vault: [src/app/[locale]/dashboard/emergency-access/[id]/vault/page.tsx:162](../../src/app/[locale]/dashboard/emergency-access/[id]/vault/page.tsx#L162) (overview decrypt → `"overview"`) and [L230](../../src/app/[locale]/dashboard/emergency-access/[id]/vault/page.tsx#L230) (blob decrypt → `"blob"`).
6. Watchtower hook: [src/hooks/use-watchtower.ts:736](../../src/hooks/use-watchtower.ts#L736) — entry blob decrypt, pass `"blob"`.
7. Crypto unit test: [src/lib/crypto/crypto-aad.test.ts:14,80,86,93,120,135,139,146,164](../../src/lib/crypto/crypto-aad.test.ts) — all instances updated to 3-arg form; add new `it` cases that prove `"blob"` ≠ `"overview"` produces different AAD.
8. CLI (8 files): `cli/src/commands/{list,get,run,env,totp,export,agent,agent-decrypt}.ts` — all currently 2-arg; update to pass `"blob"` (CLI only decrypts blob; the metadata-only commands that read overview must pass `"overview"`). Locate each at impl time via `grep -rn buildPersonalEntryAAD cli/`.
9. Mock: [src/hooks/use-watchtower.test.ts:56](../../src/hooks/use-watchtower.test.ts#L56) — update mock signature.

### C2 (Personal history AAD)
- History GET ([src/app/api/passwords/[id]/history/[historyId]/route.ts](../../src/app/api/passwords/[id]/history/[historyId]/route.ts)): server returns stored `encryptedBlob` + `id` (the historyId); client passes `{userId, entryId, historyId}` to `buildPersonalHistoryAAD`.
- History RESTORE ([src/app/api/passwords/[id]/history/[historyId]/restore/route.ts](../../src/app/api/passwords/[id]/history/[historyId]/restore/route.ts)): client-side two-step — decrypt with history AAD, re-encrypt with `buildPersonalEntryAAD(userId, entryId, "blob")`, send re-encrypted blob to server. Server then updates the live PasswordEntry row. The restore endpoint MUST accept the re-encrypted ciphertext (verify the API contract during impl).
- vault-context.tsx history list ([src/lib/vault/vault-context.tsx:1052](../../src/lib/vault/vault-context.tsx#L1052)): switch from `buildPersonalEntryAAD` to `buildPersonalHistoryAAD(userId, histEntry.entryId, histEntry.historyId)`.

### C3 (share-access-token)
- s/[token] handlers ([src/app/s/[token]/](../../src/app/s/[token]/)) parse `kv:` first segment → `getMasterKeyByVersion(parseInt(kv))` → HMAC verify over `${kv}|${payloadB64}`. Missing `kv:` segment → 401.

### C8 (AccessRequest requester)
- List UI ([src/app/[locale]/dashboard/tenant/access-requests/](../../src/app/[locale]/dashboard/tenant/access-requests/) — verify exact path at impl): renders requester column. If `requesterUserId` set → render user email; if `requesterServiceAccountId` → render SA name; if both null → render "Unknown (legacy)".

### C11 (AUTH_LOGIN_FAILURE)
- Audit log filter UI: reads `action` and looks up label via `auditActionLabels.auth_login_failure` (en + ja keys required).
- Audit group definitions: register in `AUTH` group.
- SIEM exporters (audit-delivery): pass through verbatim.
- i18n coverage test ([src/__tests__/audit-i18n-coverage.test.ts](../../src/__tests__/audit-i18n-coverage.test.ts)): auto-fails on missing key for any new `AUDIT_ACTION_VALUES` entry.

### C18 (Resource quotas)
- POST handlers await `assertQuotaAvailable(...)` → 403 with `quota_exceeded` envelope. UI does NOT show remaining quota (separate feature). Existing toast handles the error.

### C19 (Break-glass cooling-off)
- Break-glass list UI: reads `effectiveAt`; if `null` → label "Active (legacy)"; if `> now()` → label "Pending (effective at HH:MM)"; if `<= now()` → "Active".
- Migration backfill: existing rows get `effectiveAt = NULL` → treated as legacy/immediate (NO retroactive cooling-off).

## Testing Strategy

| ID  | Cluster | Tests | Path |
|-----|---------|-------|------|
| T-C1 | A | Encrypt as `"overview"`, attempt decrypt as `"blob"` → fails GCM. | [src/lib/crypto/crypto-aad.test.ts](../../src/lib/crypto/crypto-aad.test.ts) (extend) |
| T-C2 | A | History AAD scope test; restore flow integration test (decrypt-old → reencrypt-new). | new `src/lib/crypto/crypto-aad-history.test.ts` + `src/__tests__/db-integration/history-restore.integration.test.ts` |
| T-C3 | A | `kv:` HMAC binding (tampered kv rejected); rejection of no-prefix tokens. | extend [src/lib/auth/tokens/share-access-token.test.ts](../../src/lib/auth/tokens/share-access-token.test.ts) if exists, else new. |
| T-C4 | A | **Integration**: insert v1 row → run migration → row is v2 + decryptable; second run idempotent; post-migration v1 row triggers throw. | new `src/__tests__/db-integration/migrate-webhook-secrets-v1-to-v2.integration.test.ts` |
| T-C5 | A | HKDF derivation matches known-vector; collision check vs existing literals. | extend env-provider test. |
| T-C6 | B | **Integration**: session created → passphrase change → fetch with old session → 401. Both routes. | new `src/__tests__/db-integration/passphrase-change-session-invalidation.integration.test.ts` (2 `describe` blocks: change-passphrase / recovery-recover) |
| T-C7 | B | passkey verify cascade allTenants verified via mocking `invalidateUserSessions`. | extend passkey verify test |
| T-C8 | B | 3 cases: (a) requesterUserId === session.userId → 403; (b) different → 200; (c) requesterUserId === null AND requesterServiceAccountId === null → 400; (d) requesterServiceAccountId.createdById === session.userId → 403. | new `src/app/api/tenant/access-requests/[id]/approve/route.test.ts` |
| T-C9 | B | DELETE without recent auth → 401; with recent → 200. | extend webauthn credentials test |
| T-C10 | B | counter==0 + interval<5s → emits warning audit, returns success. | extend webauthn-authorize test |
| T-C11 | B | Failed login of each 5 reasons emits `AUTH_LOGIN_FAILURE` with correct metadata; raw email NOT in metadata. Negative assertion: `expect(metadata).not.toHaveProperty("email")`. Hash is 16-hex length. | new `src/__tests__/auth-failed-login.test.ts` |
| T-C12 | B | 10 OK, 11th rejected with 429. IPv6 /64 normalization: 2 different /128 in same /64 share bucket. | new `src/lib/security/rate-limiters-magic-link-ip.test.ts` |
| T-C13 | C | **Integration**: connect as `passwd_app`, attempt `UPDATE audit_logs SET ...` → permission denied. Same for DELETE on audit_logs and audit_chain_anchors (6 cases). Positive: INSERT and SELECT still work. | new `src/__tests__/db-integration/audit-tables-revoke.integration.test.ts` |
| T-C14 | C | `verifyTenantChain` unit test with fake deps; (a) clean → 0 alerts, (b) tampered → 1 alert + 1 audit, (c) repeated failures → hysteresis. | new `scripts/__tests__/audit-chain-verify-worker.test.mjs` |
| T-C15 | C | 10 rows, tamper row 5; verify response has `walkedThrough=4`, `firstTamperedSeq=5`, rows 5..9 unverified, rows 0..3 verified. | extend `src/__tests__/db-integration/audit-chain-verify-endpoint.integration.test.ts` |
| T-C16 | C | Threshold crossing emits 1 Sentry; sustained-high does NOT re-emit until 24h tick. Fake timer. | new `scripts/__tests__/audit-outbox-worker-alert.test.mjs` |
| T-C18 | D | (a) at-limit insert succeeds, (b) over-limit insert 403, (c) error envelope shape `{ code, resource, current, max }`, (d) tenant isolation (tenant B counter unaffected by tenant A). 4 resources × 4 cases = 16 cases. Integration for tenant isolation; unit for limit math. | new `src/lib/quota/resource-quotas.test.ts` + `src/__tests__/db-integration/quota-tenant-isolation.integration.test.ts` |
| T-C19 | D | Fake timer. (a) First grant: `effectiveAt = now+3600`, email sent. (b) 23h59m later second grant: immediate. (c) 24h later third grant: deferred again. | new `src/app/api/tenant/breakglass/route-cooling-off.test.ts` |
| T-C20 | D | Response body shape: `Object.keys(body).sort()` equals `["status"]`. 200 and 503 cases both verified. | extend [src/__tests__/lib/health.test.ts](../../src/__tests__/lib/health.test.ts) or wherever lives |
| T-C21/22 | E | Full `npx vitest run` + `npx next build` + `npx playwright test webauthn` after upgrade. | CI gate |
| T-C23 | E | Pre-PR script: `grep -rE 'uses: [^@]+@v[0-9]+' .github/workflows/` must return empty. Add to `scripts/pre-pr.sh`. | extend pre-pr.sh |
| T-C24 | E | Verify `.github/dependabot.yml` parses (YAML valid). | shell check |

All tests run via `npm test` (unit) or `npm run test:integration` (requires real DB). E2E gate via `npx playwright test`. Coverage threshold for new module `src/lib/quota/` per project default (60% / 80%).

## Commit Plan (one branch, separated commits)

1. `feat(crypto): bind vaultType to personal entry AAD (C1) [BREAKING]`
2. `feat(crypto): add personal history AAD scope with historyId binding (C2) [BREAKING]`
3. `feat(crypto): version-aware share-access-token format (C3)`
4. `feat(crypto): retire webhook secret AAD v1 with migration script (C4)`
5. `refactor(crypto): HKDF domain-separate directory sync key fallback (C5)`
6. `fix(auth): invalidate sessions on passphrase change and recovery (C6)`
7. `fix(auth): passkey signin uses full all-tenants cascade (C7)`
8. `feat(jit): record requester and reject self-approval (C8)`
9. `fix(webauthn): require recent current-auth-method on credential delete (C9)`
10. `feat(webauthn): audit warning on counter==0 rapid reuse (C10)`
11. `feat(audit): AUTH_LOGIN_FAILURE event with tenant-peppered identifier hash (C11)`
12. `feat(security): per-IP rate-limit on magic-link issuance (C12)`
13. `feat(db): REVOKE UPDATE/DELETE on audit_logs via SECURITY DEFINER procedures (C13)`
14. `feat(worker): audit-chain-verify worker with new DB role (C14)`
15. `fix(audit): bail chain verify at first tamper detection (C15)`
16. `feat(audit): outbox depth Sentry alert with 24h re-alert (C16)`
17. `docs(operations): SIEM alert hook examples (C17)`
18. `feat(quota): env-based resource quotas for passwords/attachments/share-links/webhooks (C18)`
19. `feat(breakglass): cooling-off period and email notification (C19)`
20. `fix(health): minimize /api/health/ready response body (C20)`
21. `chore(deps): upgrade @simplewebauthn server+browser to v11 (C21)`
22. `chore(deps): upgrade next-auth to 5.0.0-beta.31 (C22)`
23. `chore(ci): pin GitHub Actions to SHA across all workflows (C23)`
24. `chore(ci): add dependabot config for Actions ecosystem (C24)`

Each commit message includes the contract ID. The C1 and C2 commits include `BREAKING CHANGE:` footer per Conventional Commits — release-please will pick up the major bump (irrelevant pre-1.0 but documented).

## Considerations & Constraints

- **C1 / C2 pre-1.0 breaking change**: existing personal entry data + history data CANNOT be decrypted after deployment. Documented; user has accepted explicitly.
- **C13 DDL ordering**: the migration creates procedures BEFORE revoking grants. If applied in the wrong order, app would fail between the two statements. Migration is one file → atomic.
- **C13 anchor publisher role**: if `audit-anchor-publisher` runs as `passwd_app`, separate mitigation needed. Verify during impl; add an Adjacent finding if so.
- **C14 worker role bootstrap**: requires `set-audit-chain-verify-worker-password.sh` script analogous to existing `set-outbox-worker-password.sh`. Add.
- **C21 SimpleWebAuthn v11**: WebAuthn registration/authentication flows must be E2E-smoke-tested in CI (Playwright with virtual authenticator) before merge.
- **C22 next-auth beta.31**: verify exists; if removed/replaced upstream, document and skip.
- **C6 transaction nesting**: `invalidateUserSessions` opens its own transaction. Must run AFTER the outer passphrase-change transaction commits (separate `prisma` connection, not within `withBypassRls` scope).
- **C18 TOCTOU**: soft-cap is acceptable pre-1.0 (no hard SLA). Documented.

## Out of Scope (this PR)

- A06-2 argon2-browser → hash-wasm (separate PR — E2E key derivation library swap)
- A04-7 GDPR self-delete (separate plan — large feature)
- A04-4 master-key rotation dual-approval (separate scope)
- All Low/Info findings
- UI for quota remaining display (separate feature)
- Per-plan quota limits (current is env-based; per-tenant.plan limits is separate PR)
- Hard-cap quota enforcement (TOCTOU mitigation; separate if needed)
- audit-anchor-publisher role refactor (only if discovered to run as `passwd_app` during C13 impl)
- **C21 @simplewebauthn server+browser v9 → v11**: deferred during impl after
  discovering v11 breakage scope is larger than estimated. v11 removed the
  `AuthenticatorDevice` type entirely and restructured the verifier response
  (`credentialID`/`credentialPublicKey`/`counter` are now nested under
  `credential.*`). 10+ call sites need updating plus full E2E re-validation
  with a virtual authenticator. Belongs in its own PR alongside a CHANGELOG
  entry that operators can review before deploying. Tracked as follow-up.
- **Bulk Actions SHA pin (C23 follow-up)**: this PR adds the dependabot
  config and pre-PR check infrastructure, but does not perform the bulk
  pin itself. Dependabot will produce the SHA pinning PR on its first run.

## Go/No-Go Gate

| ID  | Subject                                                              | Status |
|-----|----------------------------------------------------------------------|--------|
| C1  | Personal entry AAD adds `vaultType` (pre-1.0 break)                  | locked |
| C2  | Personal history AAD scope `PH` with `historyId` (pre-1.0 break)     | locked |
| C3  | share-access-token `${kv}.${payload}.${sig}`, kv bound to HMAC       | locked |
| C4  | Webhook secret v1 retired, migration script + 3-phase deploy doc     | locked |
| C5  | Directory sync key HKDF with literal-collision-checked info string   | locked |
| C6  | `invalidateUserSessions` post-tx, 500 + audit on failure             | locked |
| C7  | Passkey signin → `allTenants: true` cascade                          | locked |
| C8  | AccessRequest +`requesterUserId`/`requesterServiceAccountId`, XOR    | locked |
| C9  | WebAuthn DELETE → `requireRecentCurrentAuthMethod`                   | locked |
| C10 | counter==0 reuse → audit warning only (no reject)                    | locked |
| C11 | `AUTH_LOGIN_FAILURE` audit + tenant-peppered identifierHash          | locked |
| C12 | Magic-link per-IP rate-limit at `src/lib/security/rate-limiters.ts`  | locked |
| C13 | REVOKE + SECURITY DEFINER procedures for audit_logs/anchors          | locked |
| C14 | audit-chain-verify worker + new role + heartbeat                     | locked |
| C15 | Chain verify bails at first tamper; `walkedThrough` field            | locked |
| C16 | Outbox depth alert with hysteresis + 24h re-alert                    | locked |
| C17 | `docs/operations/alerts.md` SIEM examples                            | locked |
| C18 | Env-based resource quotas (4 resources, soft-cap)                    | locked |
| C19 | Break-glass `effectiveAt` column + email notification                | locked |
| C20 | `/api/health/ready` body `{status}` only, no auditOutbox check       | locked |
| C21 | SimpleWebAuthn v9 → v11 — **DEFERRED to follow-up PR** (impl scope)  | deferred |
| C22 | next-auth beta.30 → beta.31                                          | locked |
| C23 | GitHub Actions SHA pin                                               | locked |
| C24 | `.github/dependabot.yml` for Actions ecosystem                       | locked |
