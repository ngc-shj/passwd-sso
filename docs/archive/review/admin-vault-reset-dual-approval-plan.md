# Plan: Admin Vault Reset — Dual-Admin Approval + Post-Reset Session Invalidation

Origin: PR #413 deferred item `#2` (Admin Vault Reset dual-admin approval + post-reset session invalidation).

## Project context

- **Type**: web app (Next.js 16 + Prisma 7 + PostgreSQL 16)
- **Test infrastructure**: unit + integration (Vitest), CI/CD via GitHub Actions
- **Manual test artifact required**: yes (R35 Tier-2 — auth/authz / session lifecycle change)

## Objective

Replace the current single-admin approval model for tenant vault resets with a **dual-admin approval** flow, and ensure that after `executeVaultReset()` runs, every authentication artifact for the target user is revoked (sessions, extension tokens, API keys, cached SessionInfo) so a leaked cookie cannot resurrect access to a wiped vault.

Threat addressed:

1. **Single-admin vault destruction**: today, one OWNER/ADMIN unilaterally creates the reset record. A compromised single admin account can destroy a member vault and inherit a stale session.
2. **Stale auth after reset**: `executeVaultReset()` clears `vaultSetupAt`, key material, and recovery fields, but the target user's `Session`, `ExtensionToken`, and `ApiKey` rows survive. A logged-in attacker can immediately re-setup a fresh vault under the victim's identity, OR (if the attacker holds a copy of the cookie) authenticate to the now-empty account before the user notices.

## Requirements

### Functional

| ID | Requirement |
|----|-------------|
| FR1 | After an OWNER/ADMIN initiates a vault reset, the reset is in `PENDING_APPROVAL` state and is NOT consumable by the target user. |
| FR2 | A second OWNER/ADMIN (different `User.id` from the initiator) MUST approve the reset before the target user's confirmation page accepts the token. |
| FR3 | The approver MUST satisfy `isTenantRoleAbove(approver.role, target.role)` — same hierarchy rule as initiate. |
| FR4 | The approver MUST NOT be the same user as the initiator (self-approval prohibited; enforced at write time AT THE DB CAS LEVEL via `initiatedById: { not: actor.id }` — the app-level check is advisory UX only, not load-bearing — see S5). |
| FR5 | A reset that is not approved within 24h auto-expires (legacy `expiresAt` semantics retained). After approval, `expiresAt` is reset to **`min(createdAt + 24h, now + EXECUTE_TTL_MS)`** (default `EXECUTE_TTL_MS = 60 minutes`) — preserves the original 24h cap (S12 fix) while giving the target a predictable window. JSDoc on `EXECUTE_TTL_MS` MUST cite "S3 mitigation — short post-approval window for email-channel disclosure window" so the rationale survives future maintenance (F19 fix). |
| FR6 | The initiator can revoke a `PENDING_APPROVAL` reset; any qualified admin can revoke an `APPROVED` (not yet executed) reset. The existing revoke endpoint absorbs both states. |
| FR7 | After `executeVaultReset()` returns, the target user's sessions, extension tokens, and API keys MUST be invalidated AND the per-tenant session cache MUST be tombstoned within one cache cycle. **Scope: ALL tenants the target is a member of, not just the initiating tenant** (see F3+S2 fix). |
| FR8 | Email + in-app notifications fire to the target user **only after approval lands**, NOT at initiation, to avoid leaking the reset URL token before approval is in place. The revoked notification (existing `ADMIN_VAULT_RESET_REVOKED`) MUST also be conditional on prior approval — a revoke during `pending_approval` MUST NOT notify the target (see F2 fix). |
| FR9 | Tenant audit log captures: `ADMIN_VAULT_RESET_INITIATE`, `ADMIN_VAULT_RESET_APPROVE` (new), `ADMIN_VAULT_RESET_EXECUTE`, `ADMIN_VAULT_RESET_REVOKE` with `metadata.initiatedById`, `metadata.approvedById`, `metadata.invalidatedSessions`, etc. EXPIRE has no audit row — documented as accepted gap (S7) since expiry is a passive transition derived at read time. |
| FR10 | The Tenant settings UI (history dialog) shows the approval state and `approvedBy.{name,email}`; "Approve" CTA is visible to any qualifying OWNER/ADMIN whose `User.id !== initiatedById`. |
| FR11 | History dialog status shows `pending_approval | approved | executed | revoked | expired` (5 states; was 4). |
| FR12 | Approve endpoint MUST snapshot the target user's email at initiate time and bind it into the reset's AAD. Approval refuses if `target.email` has changed since initiate (S9). |

### Non-functional

| ID | Requirement |
|----|-------------|
| NFR1 | All state transitions on `AdminVaultReset` use compare-and-swap (`updateMany` with full from-state in WHERE) — extends the EA CAS pattern shipped in PR #413. |
| NFR2 | Approve, revoke, execute paths are concurrency-safe under two truly parallel admin requests. The integration test in step 11.2 MUST exercise true concurrency (distinct Prisma client instances + `pg_advisory_lock` barrier) — interleaved sequential calls under one client are insufficient. |
| NFR3 | Backwards compatibility: existing rows in `admin_vault_resets` are migrated to a defined post-state. **Backfill rule (S11 fix — option c)**: in-flight rows (`executed_at IS NULL AND revoked_at IS NULL AND expires_at > now()`) are SET to `revoked_at = created_at` so their email-link tokens cannot be redeemed post-deploy under the old single-admin policy. NO operator-drain script is required — the migration is correct-by-construction. Already-EXECUTED, already-REVOKED, and EXPIRED rows are untouched (only `target_email_at_initiate` is populated for them). The legacy-row backfill therefore creates ZERO synthetic-approval rows; the `approvedById = initiatedById` sentinel pattern from the round-1 plan is no longer used. (F8 audit-trail concern is also dropped because no synthetic-approval rows exist.) |
| NFR4 | No behavioral degradation for the target-user confirmation page: it still receives only the token via URL fragment; it does NOT need to know about approval state — the server enforces it. |
| NFR5 | The session-invalidation step is idempotent and never blocks the audit log emission — failure modes are logged, not propagated to the caller. |

## Technical approach

### Schema change (Prisma)

Add three columns to `AdminVaultReset`:

```
encryptedToken        String?   @map("encrypted_token") @db.Text
approvedAt            DateTime? @map("approved_at") @db.Timestamptz(3)
approvedById          String?   @map("approved_by_id") @db.Uuid
targetEmailAtInitiate String    @map("target_email_at_initiate") @db.VarChar(320)  // FR12 — bound to AAD
approvedBy            User?     @relation("adminVaultResetApprover", fields: [approvedById], references: [id], onDelete: SetNull)
```

Add the inverse relation on `User`:

```
adminVaultResetsAsApprover  AdminVaultReset[] @relation("adminVaultResetApprover")
```

Index addition:

```
@@index([targetUserId, approvedAt, executedAt, revokedAt])  // ADDS to (does NOT replace) the existing
                                                            // [targetUserId, executedAt, revokedAt] index
```

**Why no status enum**: the existing model derives status from nullable timestamps. Adding a 5th state by enum diverges from that pattern; deriving from `approvedAt` keeps the convention. R3 — match the existing convention.

**Migration**: `additive nullable + backfill` per R24. Step 1 (this PR) adds the columns and backfills legacy rows. The columns remain nullable (or have a backfilled-then-NOT-NULL constraint for `targetEmailAtInitiate`, see step 1).

**DB role grants (R14, F6)**: the migration MUST verify `passwd_app` has SELECT/INSERT/UPDATE on the new columns. `passwd_app` was set up with table-level grants on `admin_vault_resets` per the existing migration; new columns inherit. A grant probe step is added to step 1.5 below — explicit verification is required.

### State machine

```
                +-----+ initiate +------------------+
                |     +--------->+ PENDING_APPROVAL +-----+ revoke +-----------+
                |                +-------+----------+     +------->+ REVOKED   |
                |                        |                         +-----------+
                |                  approve|       (expiresAt)
                |                        v                         +-----------+
                |                +------------------+--- expire -->+ EXPIRED   |
                |                |    APPROVED      |              +-----------+
                |                +-------+----------+
                |                        |
                |                target executes (POST /api/vault/admin-reset)
                |                        |
                |                        v
                |                +------------------+
                |                | EXECUTED         |
                |                +------------------+
```

Status derivation (server- and client-side) lives in `src/lib/vault/admin-reset-status.ts`:

```ts
export type ResetStatus =
  | "pending_approval" | "approved" | "executed" | "revoked" | "expired";

export function deriveResetStatus(r: {
  approvedAt: Date | null;
  executedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}, now = new Date()): ResetStatus {
  if (r.executedAt) return "executed";
  if (r.revokedAt) return "revoked";
  if (r.expiresAt < now) return "expired";
  if (r.approvedAt) return "approved";
  return "pending_approval";
}
```

Unit test pins every transition.

### Endpoint changes

#### New: `POST /api/tenant/members/[userId]/reset-vault/[resetId]/approve`

Auth pre-checks:
1. session exists + tenant membership
2. `requireTenantPermission(actor.id, MEMBER_VAULT_RESET)`
3. `isTenantRoleAbove(actor.role, target.role)`
4. **Find reset record** (no CAS yet) — verify `tenantId, targetUserId` match path params; return 404 otherwise
5. **App-level pre-check (advisory UX only)**: if `actor.id === resetRecord.initiatedById` return 403 with helpful error message. The CAS guard in step 7 is the load-bearing enforcement (FR4 + S5).
6. **Email-snapshot guard (FR12)**: re-fetch target user; if `currentEmail !== resetRecord.targetEmailAtInitiate` return 409 `RESET_TARGET_EMAIL_CHANGED` and audit the attempt. (S9 mitigation.)

Then execute (ordering matters for F7+S4):

7. **Decrypt encryptedToken FIRST** with AAD `(tenantId, resetId, targetEmailAtInitiate)`. On failure return generic 409 `RESET_NOT_APPROVABLE` to the user (S14 fix — do NOT leak distinct `RESET_TOKEN_DECRYPT_FAILED` to user-facing channel) and log the underlying decrypt error to the **operational logger only** (S16 fix — do NOT include the distinct cause in audit metadata; tenant admins read `/api/tenant/audit-logs` so the audit channel is part of the same oracle the S14 fix closed). Audit metadata for the failed-approve attempt records only `{ resetId, cause: "RESET_NOT_APPROVABLE" }` — same coarse code as the user-facing response. Leave the row UNCHANGED (no CAS). Operator can re-issue. (Decrypt-fail-after-CAS would create a phantom approval — F7 fix.)
8. **CAS update**:
   ```ts
   const ttlCap = new Date(resetRecord.createdAt.getTime() + RESET_TOTAL_TTL_MS);  // 24h from initiate
   const newExpiresAt = new Date(Math.min(ttlCap.getTime(), now.getTime() + EXECUTE_TTL_MS));
   updateMany({
     where: {
       id: resetId,
       tenantId: actor.tenantId,
       targetUserId,
       approvedAt: null,
       executedAt: null,
       revokedAt: null,
       expiresAt: { gt: now },
       initiatedById: { not: actor.id },  // load-bearing FR4 guard
     },
     data: {
       approvedAt: now,
       approvedById: actor.id,
       expiresAt: newExpiresAt,  // FR5: capped at min(createdAt + 24h, now + EXECUTE_TTL_MS) per S12 fix
     },
   });
   ```
   `count === 0` → 409 (race lost / already approved / revoked / expired / self-approval — error message generic to avoid disclosure).
9. **Send email + in-app notification** (best-effort, errors logged, do not propagate). The plaintext token from step 7 goes into the email URL fragment.
10. **Emit audit** `ADMIN_VAULT_RESET_APPROVE` with `metadata: { resetId, initiatedById, targetUserId }`.

Rate limiter: `createRateLimiter` from [src/lib/security/rate-limit.ts](src/lib/security/rate-limit.ts), per-actor key `rl:admin-reset:approve:<actorId>` with `windowMs: 15 * MS_PER_MINUTE, max: 10`. Per-target limiter also added per RS2: `rl:admin-reset:approve:target:<targetUserId>` with `windowMs: MS_PER_DAY, max: 5` (caps repeated approval attempts on a single target — pairs with the existing initiate per-target limiter).

#### Modified: `POST /api/tenant/members/[userId]/reset-vault` (initiate)

- No longer emails or notifies the target user (defer to approve).
- Captures `targetEmailAtInitiate` snapshot from the target's current `email`.
- Encrypts plaintext token with AAD `(tenantId, resetId, targetEmailAtInitiate)`, stores in `encryptedToken`.
- Sends an in-app notification + email to OTHER tenant admins eligible to approve (`requireTenantPermission(MEMBER_VAULT_RESET)` + `isTenantRoleAbove(role, target.role)` + `userId != initiatedById`) — per S6, restrict by permission, not bare role check.
- Audit metadata: `{ resetId }`. (Drop `pendingApproval: true` flag — F12 — state already in `approvedAt = null` column.)

#### Modified: `POST /api/tenant/members/[userId]/reset-vault/[resetId]/revoke`

- WHERE clause already covers both `pending_approval` and `approved` states implicitly (`executedAt: null, revokedAt: null, expiresAt > now`); add an inline comment confirming both states are revocable.
- On success: read the row's `approvedAt` BEFORE the update. **Conditional notification**: only send `ADMIN_VAULT_RESET_REVOKED` to target user when the row was already `approved` at the time of revoke (`approvedAt != null` pre-update) — pending revokes leave the target unaware (F2 + FR8). Email + in-app notification both gated.
- NULL out `encryptedToken` on revoke success (single-line addition to the `data:` clause). Audit row continues to fire.

#### Modified: `POST /api/vault/admin-reset` (target user executes)

Three changes:

1. After `findUnique`, BEFORE CAS: if `resetRecord.approvedAt === null` return 409 `VAULT_RESET_NOT_APPROVED` (F11). CAS WHERE clause additionally adds `approvedAt: { not: null }` for safety.
2. After `executeVaultReset()` returns, call `invalidateUserSessions(target.id, { reason: "admin_vault_reset", allTenants: true })` — extend the helper with an `allTenants: true` option that drops the tenantId filter (F3+S2 fix). Documented in the helper's docstring + an ADR snippet noting that admin vault reset specifically requires cross-tenant invalidation (the target user holds vault data only in the initiating tenant per current model, but their `Session` rows in OTHER tenants are still authentication artifacts that survive the wipe). Audit metadata records `invalidatedSessions, invalidatedExtensionTokens, invalidatedApiKeys` (mapped from real return shape `{ sessions, extensionTokens, apiKeys }` — T5 fix; mapping done explicitly in the route handler).
3. NULL out `encryptedToken` on success.
4. Target's current request: rely on `invalidateUserSessions` deleting the active Session row + tombstoning the cache. The `window.location.href = .../dashboard` redirect in [src/app/[locale]/vault-reset/admin/page.tsx#L64](src/app/[locale]/vault-reset/admin/page.tsx#L64) issues a fresh request that hits the now-tombstoned session, gets 401, lands on sign-in.

#### Schema for status response

`GET /api/tenant/members/[userId]/reset-vault` extends the per-record shape (N1 fix — includes `targetEmailAtInitiate`):

```ts
{
  id: string;
  status: "pending_approval" | "approved" | "executed" | "revoked" | "expired";
  createdAt: Date;
  expiresAt: Date;
  approvedAt: Date | null;
  executedAt: Date | null;
  revokedAt: Date | null;
  initiatedBy: { name: string | null; email: string };
  approvedBy: { name: string | null; email: string } | null;
  targetEmailAtInitiate: string;  // exposed so admin can reconcile email-change race in UI
}
```

**Backwards compatibility on `status` (F5)**: the value `pending` is RENAMED to `pending_approval`. Per `git grep` of CLI / extension / external API consumers (see step 8.1), no consumer relies on the literal string `"pending"` today — both surfaces use `pendingResets` count, not status string. The rename ships as a breaking change documented in REST API v1 changelog. The `openapi-spec.ts` API version stays at `1.0.0` because the response shape was not in the published OpenAPI. If a consumer surfaces, add a one-release back-compat alias in a follow-up.

### Audit log

- New action: `AUDIT_ACTION.ADMIN_VAULT_RESET_APPROVE = "ADMIN_VAULT_RESET_APPROVE"`. Concrete grep evidence shows the action is referenced at:
  - [src/lib/constants/audit/audit.ts:101-103](src/lib/constants/audit/audit.ts#L101-L103) — primary action constant
  - Four group arrays: [audit.ts:255-257](src/lib/constants/audit/audit.ts#L255-L257), [audit.ts:369-371](src/lib/constants/audit/audit.ts#L369-L371), [audit.ts:512-513](src/lib/constants/audit/audit.ts#L512-L513), [audit.ts:534-536](src/lib/constants/audit/audit.ts#L534-L536). Decision for line 512-513 (currently lists only INITIATE+EXECUTE, no REVOKE): read the group's purpose at the comment above its declaration; APPROVE follows the same semantic class as EXECUTE (both are "consequential / approver-action" events) so APPROVE belongs there. Document the decision inline in a comment when adding APPROVE.
  - [src/lib/constants/audit/audit.test.ts:201](src/lib/constants/audit/audit.test.ts#L201) area — existing test is a NEGATIVE assertion. Add a NEW positive test that iterates `[INITIATE, APPROVE, EXECUTE, REVOKE]` and asserts each is present in every of the 4 group arrays where APPROVE belongs (T4 fix).
  - i18n: every `messages/{en,ja}/AuditLog.json` keyed by `ADMIN_VAULT_RESET_EXECUTE` — add the parallel `ADMIN_VAULT_RESET_APPROVE` key.
  - Webhook event subscription UI ([src/components/settings/developer/tenant-webhook-card.test.tsx:137-139](src/components/settings/developer/tenant-webhook-card.test.tsx#L137-L139), [src/components/team/security/team-webhook-card.test.tsx:126](src/components/team/security/team-webhook-card.test.tsx#L126)) — add the new action to the tenant webhook test (positive) and confirm exclusion from team webhook test (negative). R11 — confirm the webhook event-subscription list semantics match the audit action group semantics.
- Audit metadata for `_EXECUTE`: append `invalidatedSessions, invalidatedExtensionTokens, invalidatedApiKeys` (mapped from helper return `{ sessions, extensionTokens, apiKeys }`).
- Audit metadata for `_APPROVE`: `{ resetId, initiatedById, targetUserId }`.

### Notifications

- New `NOTIFICATION_TYPE.ADMIN_VAULT_RESET_PENDING_APPROVAL`:
  - Postgres enum: `enum NotificationType` (Prisma) is compiled to a Postgres ENUM. Migration MUST issue `ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_VAULT_RESET_PENDING_APPROVAL';` — non-transactional in Postgres so this statement runs OUTSIDE the migration's transaction wrapper (Prisma supports this via separate migration file or `-- non-transactional` comment as used by the prior `_revoke` migration at `prisma/migrations/20260305010000_tenant_vault_reset_revoke/migration.sql:6`). (F1 fix.)
  - TypeScript constant added to [src/lib/constants/audit/notification.ts](src/lib/constants/audit/notification.ts) `NOTIFICATION_TYPE` literal.
  - `NOTIFICATION_TYPE_VALUES` is auto-derived via `Object.values()` so no manual sync needed.
- Existing `NOTIFICATION_TYPE.ADMIN_VAULT_RESET` — repurposed: now fires only at approve.
- Notification messages updated in `src/lib/notification/notification-messages.ts` + `messages/{en,ja}/Notifications.json`.
- **Exhaustive coverage test (T8 fix)**: target test file `src/lib/notification/notification-messages.test.ts` (verify existence; if missing, create it). The test iterates `NOTIFICATION_TYPE_VALUES` and asserts each yields a non-empty title + body in BOTH `en` and `ja` locales. Failing test → missing i18n key.
- New email template: `src/lib/email/templates/admin-vault-reset-pending.ts` (sent to other admins). Existing `admin-vault-reset.ts` template repurposed for post-approval target-user email.

### UI changes

Confirmed UI consumers via grep:

- **[src/components/settings/account/tenant-members-card.tsx](src/components/settings/account/tenant-members-card.tsx)**: pending-resets badge — verified the existing query already counts `approvedAt: null` rows AND `approvedAt: { not: null }, executedAt: null, revokedAt: null, expiresAt > now` rows (the existing groupBy filters do not exclude approved-but-not-executed rows). The plan's prior step 9.2 was redundant — F10 fix removes it.
- **[src/components/settings/security/tenant-reset-history-dialog.tsx](src/components/settings/security/tenant-reset-history-dialog.tsx)**: render 5 statuses; "Approve" button visible for `pending_approval` rows when `currentUser.id !== row.initiatedBy.id`. The Revoke button stays.
  - **i18n key mapping (F4+F9 fix)**: existing template uses `t(\`status\${capitalize(r.status)}\`)` against `messages/{en,ja}/TenantAdmin.json` (NOT `AdminConsole.json` as the prior plan said). Capitalizing `pending_approval` produces `Pending_approval` → key `statusPending_approval` which does not match TypeScript's camelCase convention. Replace the template-string lookup with an explicit map:
    ```ts
    const STATUS_KEY_MAP: Record<ResetStatus, string> = {
      pending_approval: "statusPendingApproval",
      approved: "statusApproved",
      executed: "statusExecuted",
      revoked: "statusRevoked",
      expired: "statusExpired",
    };
    ```
    Add the 2 new keys (`statusPendingApproval`, `statusApproved`) to `messages/{en,ja}/TenantAdmin.json`.
- **Webhook event subscription pickers** ([tenant-webhook-card.tsx](src/components/settings/developer/tenant-webhook-card.tsx), [team-webhook-card.tsx](src/components/team/security/team-webhook-card.tsx)): the new `ADMIN_VAULT_RESET_APPROVE` action appears in the tenant scope picker; tests at `*-webhook-card.test.tsx` extended to assert presence/absence respectively.
- **Notification dropdown / list UI**: the new `ADMIN_VAULT_RESET_PENDING_APPROVAL` type renders via the existing `notificationTitle()/notificationBody()` lookup table.
- **Approve action**: opens a confirmation dialog ("Approve vault reset for `<target.email>`?") and calls the new endpoint. Dialog includes the English confirmation token `APPROVE` typed by the second admin to prevent click-fatigue. Constant `VAULT_CONFIRMATION_PHRASE.APPROVE = "APPROVE"` exported from [src/lib/constants/vault.ts](src/lib/constants/vault.ts) (NEW file or existing — verify); also export the existing `DELETE_VAULT = "DELETE MY VAULT"` and refactor the current 17 hardcoded literals in `route.test.ts` + the page to consume it. (T12 + RT3 fix.)
- **R26 disabled cue**: the Approve button is `disabled` with paired visual style + tooltip ("You initiated this reset; another admin must approve") when `currentUser.id === row.initiatedBy.id`.

### Session-invalidation integration

- Reuse [src/lib/auth/session/user-session-invalidation.ts](src/lib/auth/session/user-session-invalidation.ts) `invalidateUserSessions()` AFTER extending it with an `allTenants: true` option (F3+S2):
  - Today the helper signature is `invalidateUserSessions(userId, { tenantId: string; reason?: string })`. Change the type to a discriminated union (F18 + F20 fix):
    ```ts
    type InvalidateOptions =
      | { tenantId: string; allTenants?: undefined; reason?: string }
      | { allTenants: true; tenantId?: undefined; reason?: string };
    ```
    This makes `tenantId` and `allTenants: true` mutually exclusive at compile time. Implementation also adds a runtime `if (options.tenantId && options.allTenants) throw ...` for defense-in-depth.
  - The `allTenants: true` branch drops the `tenantId` filter from all three sub-queries (Session, ExtensionToken, ApiKey) and the cache tombstone SELECT.
  - The `withBypassRls` allowlist is purpose-keyed (`BYPASS_PURPOSE.TOKEN_LIFECYCLE`), not model-keyed — confirmed at [src/lib/tenant-rls.ts:5-52](src/lib/tenant-rls.ts#L5-L52). No new bypass purpose required.
  - Existing call sites (team member removal, SCIM user deletion) keep the tenantId-scoped behavior unchanged. Only `admin-reset/route.ts` invokes the new `allTenants: true` branch.
- Sequencing invariant (R3 / S-6): SELECT tokens BEFORE deleteMany, then tombstone cache AFTER DB commit. Already satisfied by the helper; no change.
- Call site: inside `handlePOST` of `/api/vault/admin-reset/route.ts`, AFTER `executeVaultReset()` resolves AND BEFORE `logAuditAsync()` so audit metadata reflects actual count.

### Crypto helper architecture (F14+S1, S10 fix)

**S10 (Critical) constraint**: changing the AAD format for `account-token-crypto.ts` would break decryption of all existing OAuth ciphertexts already written to `accounts.refresh_token / access_token / id_token` in production (AES-GCM authenticates AAD verbatim). Therefore the refactor MUST preserve byte-for-byte AAD compatibility for the account-token path. The domain-separation defense is achieved differently per caller:

1. Extract `encryptWithKey`, `decryptWithKey`, `parseEnvelope`, `SENTINEL = "psoenc1:"` into `src/lib/crypto/envelope.ts`. The shared module accepts a **caller-built AAD `Buffer`** — it does NOT construct AAD itself.
2. Each caller is responsible for AAD construction. Cross-subsystem substitution is prevented because:
   - AAD construction lives in caller-specific modules (`account-token-crypto.ts` and `admin-reset-token-crypto.ts`).
   - The two callers' AAD shapes are structurally distinguishable: `${provider}:${providerAccountId}` (account-token, two UUID/string segments) vs `${tenantId}:${resetId}:${targetEmailAtInitiate}` (admin-reset, three segments with email). A swapped ciphertext would have AAD with the wrong shape on the receiving side, and the receiving side's AAD is built locally — substitution attempt produces an authenticity tag mismatch.
   - **No domain prefix is added.** This was the round-1 S1 fix proposal but it was incompatible with S10 (existing ciphertexts). The orthogonal protection — distinct AAD shapes per caller, enforced by per-caller AAD construction — gives equivalent substitution resistance without breaking compat.
3. `account-token-crypto.ts` continues to construct AAD as `Buffer.from("${provider}:${providerAccountId}", "utf8")` — **byte-for-byte identical** to the legacy implementation. It internally delegates the envelope ops to `envelope.ts` but the AAD bytes that go into AES-GCM are unchanged. Existing ciphertexts continue to decrypt.
4. New module `src/lib/vault/admin-reset-token-crypto.ts` constructs its own AAD as `Buffer.from("${tenantId}:${resetId}:${targetEmailAtInitiate}", "utf8")` (FR12) and calls `envelope.ts`. Defensive comment in the module documents that the AAD bytes are opaque (never re-parsed) per S13 — `:` may appear in quoted-local-part emails per RFC 5322 §3.4.1, which is fine because AES-GCM AAD does not require parseability, only equality.
5. **Mandatory regression test (S10 fix)**: `account-token-crypto.test.ts` MUST include a fixture-based test that loads a ciphertext produced under the legacy code path (committed as a binary fixture under `src/__tests__/fixtures/account-token-legacy-ciphertext.json` with the corresponding plaintext + AAD inputs in clear) and asserts the post-refactor `decryptAccountToken()` returns the original plaintext. This catches any accidental AAD-byte drift introduced by the refactor.
6. Existing `account-token-crypto.test.ts` remaining test cases continue to pass with zero edits.

## Implementation steps

1. **Schema migration** (Prisma + SQL):
   1.1 Add `encryptedToken`, `approvedAt`, `approvedById`, `targetEmailAtInitiate` columns to `AdminVaultReset`. Add inverse relation on `User`. Add `[targetUserId, approvedAt, executedAt, revokedAt]` index. Generate Prisma migration.
   1.2 **Two-statement migration** (Postgres `ALTER TYPE` is non-transactional):
       - File 1 (transactional): `ALTER TABLE` + index + RLS policy update.
       - File 2 (non-transactional, separate migration): `ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_VAULT_RESET_PENDING_APPROVAL';`. Mirror the existing `prisma/migrations/20260305010000_tenant_vault_reset_revoke/migration.sql:6` precedent.
   1.3 *(removed in round 3 — superseded by step 1.6's auto-revoke + email-snapshot SQL. The old auto-approve clause contradicted NFR3's round-2 redesign.)*
   1.4 After backfill confirms zero rows with `target_email_at_initiate IS NULL`, ALTER COLUMN to NOT NULL (separate migration in a follow-up PR — kept nullable in this PR for safety; reconcile in R24 step 2.)
   1.5 **Grant probe (R14, F6 fix)**: run `GRANT SELECT, INSERT, UPDATE ON admin_vault_resets TO passwd_app;` (idempotent if already table-scoped) AND verify column-level grants for the new columns by issuing the operations from `passwd_app` against a test row. Document in the manual-test artifact.
   1.6 **Backfill SQL** (S11 fix — option c, correct-by-construction):
       ```sql
       -- Auto-revoke in-flight rows so their email-link tokens cannot be
       -- redeemed post-deploy under the old single-admin policy.
       UPDATE admin_vault_resets
          SET revoked_at = created_at
        WHERE executed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now();

       -- Populate the new targetEmailAtInitiate column for ALL rows
       -- (pending/executed/revoked/expired) so a future ALTER TO NOT NULL
       -- can run without orphans.
       UPDATE admin_vault_resets r
          SET target_email_at_initiate = u.email
         FROM users u
        WHERE r.target_user_id = u.id
          AND r.target_email_at_initiate IS NULL;

       -- Emit a SYSTEM-actor audit row per legacy auto-revoked row so
       -- tenant-side observability is not silently degraded (S17 fix).
       INSERT INTO audit_logs (
         tenant_id, scope, actor_type, action, target_type, target_id, metadata, created_at
       )
       SELECT tenant_id,
              'TENANT',
              'SYSTEM',
              'ADMIN_VAULT_RESET_REVOKE',
              'User',
              target_user_id,
              jsonb_build_object('resetId', id, 'reason', 'dual_approval_migration'),
              now()
         FROM admin_vault_resets
        WHERE revoked_at = created_at  -- only newly auto-revoked rows
          AND created_at < now() - interval '5 seconds';  -- exclude any concurrent live revoke
       ```
       NO operator-script step is required. NO synthetic-approval rows are created. Backfill emits a SYSTEM-actor audit row per auto-revoked legacy row so tenant audit log readers see the state change (S17 fix). The `approvedById = initiatedById` sentinel pattern is gone.

       **Note on actorType "SYSTEM"**: confirm `actor_type` enum already includes `SYSTEM` per the cross-actor audit groundwork in machine-identity work (`AuditActorType.SYSTEM`). If absent, add to the enum in this PR's migration step 1.1 alongside the schema columns.
   1.7 Run `npm run db:migrate` against the local dev DB with seeded data. Confirm in-flight rows show as `revoked` in the history dialog (manual). Run the new migration backfill integration test (step 11.2 below) — automated regression for NFR3.
2. **Constants & enums**:
   2.1 Add `ADMIN_VAULT_RESET_APPROVE` to `AUDIT_ACTION` and to all 4 group arrays where APPROVE belongs (decision documented inline at line 512-513). Add positive exhaustive test in `audit.test.ts` per T4.
   2.2 Add `ADMIN_VAULT_RESET_PENDING_APPROVAL` to `NOTIFICATION_TYPE` literal. Verify (or create) `notification-messages.test.ts` exhaustively asserts coverage in both locales (T8).
   2.3 Add `VAULT_RESET_NOT_APPROVED, RESET_TOKEN_DECRYPT_FAILED, RESET_TARGET_EMAIL_CHANGED` to `API_ERROR` ([src/lib/http/api-error-codes.ts](src/lib/http/api-error-codes.ts)). Update `apiErrorToI18nKey()` mapping. Update `messages/{en,ja}/ApiErrors.json`.
   2.4 Add `EXECUTE_TTL_MS = 60 * MS_PER_MINUTE` to `src/lib/constants/time.ts` (or wherever existing TTL constants live).
   2.5 Export `VAULT_CONFIRMATION_PHRASE = { DELETE_VAULT: "DELETE MY VAULT", APPROVE: "APPROVE" }` from [src/lib/constants/vault.ts](src/lib/constants/vault.ts) (new file or extend existing). Refactor existing literal usages — `git grep -n 'DELETE MY VAULT'` identified ~23 occurrences across `route.test.ts` + the admin-reset page + adjacent files (N5 correction; round-1 stated 17). All call sites must consume the constant; verify with `git grep` post-refactor that no string literal remains.
3. **Helpers**:
   3.1 Create `src/lib/vault/admin-reset-status.ts` exporting `deriveResetStatus()` + `ResetStatus` type. Unit tests cover all 5 transitions.
   3.2 Refactor: extract `src/lib/crypto/envelope.ts` from `account-token-crypto.ts` per F14+S1 (domain-separated AAD). Migrate `account-token-crypto.ts` to consume it. Add `src/lib/vault/admin-reset-token-crypto.ts` calling `envelope.ts` with domain `"admin-reset-token-v1"`.
4. **Initiate endpoint** (`reset-vault/route.ts`):
   4.1 Capture `targetEmailAtInitiate = targetMember.user.email` (FR12).
   4.2 Encrypt plaintext token with AAD `(tenantId, resetId, targetEmailAtInitiate)`, store in `encryptedToken`.
   4.3 Remove target-user email + notification.
   4.4 Add notification + email to other eligible admins (recipient set: `TenantMember` rows where `tenantId === actor.tenantId, role >= ADMIN, userId != initiatedById`, AND `isTenantRoleAbove(member.role, target.role)` per S6 — narrower than role >= ADMIN).
   4.5 Update audit metadata: `{ resetId, expiresAt }` (F23 fix — keep `expiresAt` so audit row is self-contained for compliance queries; drop only the redundant `pendingApproval: true` flag).
5. **Approve endpoint** (new): `src/app/api/tenant/members/[userId]/reset-vault/[resetId]/approve/route.ts`. Implement steps 1-10 from the §"Approve endpoint" section above. Rate limiters per §"Rate limiter".
6. **Execute endpoint** (`/api/vault/admin-reset/route.ts`):
   6.1 After `findUnique`, BEFORE CAS: `if (resetRecord.approvedAt === null) return 409 VAULT_RESET_NOT_APPROVED` (F11).
   6.2 CAS WHERE adds `approvedAt: { not: null }` (defense-in-depth).
   6.3 After `executeVaultReset()` returns, call `invalidateUserSessions(targetUserId, { allTenants: true, reason: "admin_vault_reset" })`.
   6.4 Map helper return shape to audit metadata: `metadata.invalidatedSessions = result.sessions; metadata.invalidatedExtensionTokens = result.extensionTokens; metadata.invalidatedApiKeys = result.apiKeys;` (T5 fix — explicit mapping).
   6.5 NULL out `encryptedToken` on success.
7. **Revoke endpoint**: NULL out `encryptedToken` on success. Read `approvedAt` BEFORE the CAS update (or include it in the SELECT step) and gate the target-user notification on `approvedAt != null` (F2 + FR8).
8. **GET history endpoint**:
   8.1 Grep `git grep -n '"pending"' cli/ extension/ src/__tests__/` to confirm no consumer relies on the old literal. Document outcome in the PR description.
   8.2 Extend response shape with `approvedAt`, `approvedBy`, `targetEmailAtInitiate` (`approvedBy: null` for pending rows; `approvedBy: { name, email }` for approved). Update `deriveResetStatus()` callsite. R19 — flip `toHaveProperty` to `toEqual` exact-shape in `route.test.ts:478-494`. Add tests for `pending_approval` and `approved` branches (T3).
9. **UI**:
   9.1 Update history dialog to render 5 statuses (using `STATUS_KEY_MAP`) + Approve button + R26 disabled-cue.
   9.2 (Removed — the existing pendingResets count already covers the new approved rows; no code change needed. F10 fix.)
   9.3 Add `statusPendingApproval`, `statusApproved` keys to `messages/{en,ja}/TenantAdmin.json` (NOT `AdminConsole.json` — F9 fix). **Existing `statusPending` key (F22)**: keep it in the locale file as a legacy entry but mark with a comment `// retained for back-compat; see plan F22`. Add a follow-up TODO `TODO(post-deploy-cleanup): remove statusPending after one release` so the entry does not linger forever.
   9.4 R23 — no mid-stroke validation in the new approve confirmation input; commit-time check only.
10. **Notification + email plumbing**:
    10.1 Add `ADMIN_VAULT_RESET_PENDING_APPROVAL` notification messages.
    10.2 New email template `admin-vault-reset-pending.ts` (sent to other admins).
    10.3 Existing `admin-vault-reset.ts` template now reads "Approval received — your vault has been scheduled for reset" + URL.
11. **Tests**:
    11.1 **Unit**:
        - `deriveResetStatus` — every transition.
        - `admin-reset-token-crypto.test.ts` mirroring `account-token-crypto.test.ts` 1:1 (round-trip, random IV, sentinel matcher, null/undefined input, AAD mismatch, malformed ciphertext, tampered tag — 7 cases) (T7).
        - **`account-token-crypto.test.ts` legacy-fixture regression (S10 fix, T15 round-3 refinement)**: load committed fixture from `src/__tests__/fixtures/account-token-legacy-ciphertext.json` containing:
          - `masterKeyHex`: deterministic test-only 256-bit key (NOT the dev `.env` key)
          - `masterKeyVersion`: numeric (use `0` for the fixture)
          - `provider`, `providerAccountId`: AAD inputs
          - `plaintext`: original token string
          - `ciphertext`: produced under the pre-refactor code, in the existing `psoenc1:0:<base64url>` format

          A generation script at `scripts/regenerate-account-token-legacy-fixture.ts` produces these inputs (run once at S10 fix authoring; not part of the regular build). The test bootstraps `KeyProvider` with the fixture key (mock `getKeyProviderSync`) and asserts `decryptAccountToken()` returns the original plaintext.
        - Approve route: auth gates; app-level self-approval blocked; CAS WHERE rejects each branch (already-approved, revoked, expired, self-approval, target-email-changed); decrypt-fail-before-CAS leaves row PENDING (F7).
        - **Approve route AAD-binding test (N7 fix, T17 round-3 refinement)**: pure mocked-Prisma unit test (NOT real DB) that simulates the row with `targetEmailAtInitiate = e1`, mocks `findUnique` to return that row, then mutates the mock to return a row with `targetEmailAtInitiate = e2` and asserts the approve handler's decrypt step fails (returns 409 `RESET_NOT_APPROVABLE`) because AAD bytes differ. No DB teardown required because no real row is created. Confirms FR12's AAD binding is load-bearing, not just the email-snapshot pre-check.
        - Execute route: `VAULT_RESET_NOT_APPROVED` 409 path; `invalidateUserSessions` called with `{ allTenants: true, reason: "admin_vault_reset" }` AND assert audit metadata uses helper-source-truth keys mapped correctly (T5).
        - **InvalidateUserSessions discriminated-union enforcement (F20 fix, T16 round-3 refinement)**: in `src/lib/auth/session/user-session-invalidation.test.ts`, embed a TypeScript compile-time assertion using `// @ts-expect-error mutually exclusive` on the line `invalidateUserSessions(uid, { tenantId: "x", allTenants: true })` — `tsc --noEmit` (run as part of `npx next build`) will fail if the directive's expected error does not occur. The test file's runtime body adds a second assertion that the helper throws at runtime when both options leak past the type check (e.g., via `as any` cast).
        - Revoke route: `encryptedToken: null` is in the `data` clause; target notification gated on `approvedAt != null` (F2).
        - Audit-action-group exhaustive positive coverage for all 4 ADMIN_VAULT_RESET_* across all 4 group arrays (T4).
        - Notification-messages exhaustive en/ja coverage (T8). Test file exists at [src/lib/notification/notification-messages.test.ts](src/lib/notification/notification-messages.test.ts) — confirmed via `ls src/lib/notification/`. Extend the existing exhaustive-coverage assertion (N6 fix — file confirmed to exist; "verify or create" wording was stale).
        - Initiate route recipient-set tests: zero other admins, multiple admins, OWNER+ADMIN mix (T10).
        - **History dialog component test (N2 fix)**: `tenant-reset-history-dialog.test.tsx` — render dialog for each of the 5 statuses × 2 actor relationships (initiator vs other admin). Assertions: status label uses `STATUS_KEY_MAP` lookup; Approve button visible AND enabled only when `status === "pending_approval" && currentUser.id !== row.initiatedBy.id`; Approve button visible-but-disabled with tooltip when `currentUser.id === row.initiatedBy.id` (R26).
    11.2 **Integration (real DB)**:
        - **True-concurrency parallel approve test** (T1 — Critical, T14 round-3 refinement): create `src/__tests__/db-integration/admin-vault-reset-dual-approval.integration.test.ts`. Use TWO distinct Prisma client instances (separate `pg.Pool` connections — see `src/__tests__/db-integration/helpers.ts:57-68` for the documented pattern). The `pg_advisory_lock` barrier pattern has NO existing precedent in this repo (verified via `git grep`); pick ONE of these two implementations:
          - **(a) Statistical N=50 loop**: launch both approve calls via `Promise.all` from the two distinct clients. Loop the test 50 iterations. Without a barrier the interleave is best-effort, but 50 iterations against a connection-pooled real DB has historically been sufficient to flush ordering nondeterminism. Acceptable but weaker than (b).
          - **(b) Author a real barrier helper** at `src/__tests__/db-integration/helpers.ts` using `pg_advisory_lock(<test-id>)` released after both calls have entered. Adds ~30 LOC of test infra; preferred. Document the helper as the canonical concurrency-test primitive for future tests.
          Pick (b) unless time-constrained. Either way, the pass condition is: exactly one call returns `count === 1`, the other `count === 0`; `approvedById` is one of the two actor IDs; the row's final state is consistent.
        - **Migration backfill test** (T2 — Critical, F24/S18/T13 round-3 fix): create `src/__tests__/db-integration/admin-vault-reset-migration.integration.test.ts`. Seed 4 legacy rows in pre-migration shape (PENDING / EXECUTED / REVOKED / EXPIRED). Run the data backfill UPDATE from step 1.6. Assert (auto-revoke semantics, NOT auto-approve): PENDING row has `revokedAt = createdAt, approvedAt IS NULL, approvedById IS NULL` and `deriveResetStatus() === "revoked"`; EXECUTED/REVOKED/EXPIRED rows have all timestamp columns untouched (only `targetEmailAtInitiate` populated by the second UPDATE); `deriveResetStatus()` on each row returns the original status. Negative assertion: no row has `approvedAt != null` post-backfill.
        - **Session invalidation cross-tenant** (FR7 + F3+S2): create the target user as `TenantMember` of two tenants. Insert `Session` rows in both tenants. Run execute. Assert all sessions deleted, both cache tombstones present.
        - **encryptedToken NULL lifecycle** (T6): integration test that confirms the column actually becomes NULL after revoke and execute (not just that the data clause includes it).
        - **Self-approval blocked at DB level (N3 fix, T18 round-3 refinement)**: the integration test MUST exercise the CAS guard directly, not the app-level pre-check that returns early. Recommended pattern: **(a) direct CAS-call** — call `prisma.adminVaultReset.updateMany({ where: <route's WHERE clause with initiatedById = X, actor.id = X>, data: {...} })` via the test client and assert `result.count === 0`. Then `findUnique` post-test and assert `approvedAt IS NULL` (row state unchanged). This pattern is preferred over (b) `auth()` mocking because it directly validates the production WHERE clause that goes to Postgres without route-handler cruft. Pattern (b) is acceptable as a backup if the route's WHERE is hard to extract.
    11.3 Existing route tests updated for new response shape (R19 exact-shape — T3).
    11.4 (Removed — replaced by 11.1 unit-mock branches for non-race paths and 11.2 real-DB tests for race paths.)
12. **Manual test plan** at `./docs/archive/review/admin-vault-reset-dual-approval-manual-test.md` (R35 Tier-2). Sections: Pre-conditions, Steps, Expected results, Rollback (revert migration + revert deploy), Adversarial scenarios. Adversarial scenarios MUST include:
    - Initiator-self-approve via direct API call.
    - Double-approve race (two browser tabs).
    - Expired-row approve attempt.
    - Execute without prior approval.
    - Replay of email link AFTER target executes (token-used 410).
    - Replay of email link AFTER admin revokes the approved reset (token-used 410).
    - **FR7 multi-device probe (T11)**: target signs in on 3 browsers (different tenants if applicable); run dual-approval flow; execute from one browser; verify all 3 receive 401 within `TOMBSTONE_TTL_MS`; verify the behavior persists after the TTL expires.
    - **Email-change race (FR12 + S9)**: change `target.email` between initiate and approve; verify approve returns 409 `RESET_TARGET_EMAIL_CHANGED`.
    - **Pending revoke notification gate (F2)**: revoke during pending_approval; verify target receives NO notification/email.

## Testing strategy

| Layer | What | How |
|-------|------|-----|
| Unit | Status derivation | `src/lib/vault/admin-reset-status.test.ts` — every transition |
| Unit | Crypto round-trip | `src/lib/vault/admin-reset-token-crypto.test.ts` — 7 cases per `account-token-crypto.test.ts` precedent |
| Unit | Approve route happy path + every auth/CAS failure mode | Vitest with mocked Prisma + auth |
| Unit | Execute route session-invalidation call shape + audit metadata mapping | Vitest, asserts `invalidateUserSessions` called with exact args + helper return → audit metadata keys |
| Unit | Revoke notification gate (F2) | Vitest assertion on `createNotification` not called when `approvedAt: null` |
| Unit | Audit action group exhaustive positive coverage | Extended `audit.test.ts` |
| Unit | Notification messages exhaustive en/ja | `notification-messages.test.ts` |
| Unit | Initiate recipient-set edge cases | T10 — zero / multiple / role mix |
| Integration | TRUE concurrency CAS race for approve | `admin-vault-reset-dual-approval.integration.test.ts` — distinct clients + advisory-lock barrier + 10-iter loop |
| Integration | Migration backfill regression | `admin-vault-reset-migration.integration.test.ts` |
| Integration | Cross-tenant session invalidation | `admin-vault-reset-cross-tenant-sessions.integration.test.ts` |
| Integration | encryptedToken NULL lifecycle | Same as above OR sub-test |
| Manual | Tier-2 manual test (FR1-FR12 + adversarial scenarios) | `*-manual-test.md` artifact |

## Considerations & constraints

### Out of scope (deferred / cross-references)

- **Optional N-of-M approval**: this PR implements 2-of-N. Configurable thresholds out of scope. TODO marker: `TODO(admin-vault-reset-policy): support N-of-M policy`.
- **Approval delegation / admin handoff during approval window**: no "emergency approval" path. Intended security property.
- **Post-execute audit anchor**: tracked separately as deferred PR #413 item `#3`.
- **Verifier pepper rotation interaction**: unchanged.
- **NOT NULL constraint on `targetEmailAtInitiate`**: kept nullable in this PR; flipped to NOT NULL in a follow-up after backfill confirms zero NULL rows. R24 step 2 deferred.
- **EXPIRE audit row (S7)**: accepted gap. Documented in FR9.
- **Initiator deactivation during approval window (F16)**: not auto-revoked. Documented as accepted: "approval succeeds even if initiator is now deactivated; admin must revoke explicitly". TODO marker: `TODO(admin-vault-reset-deactivation): consider auto-revoke on deactivation`.
- **Synthetic audit row for legacy backfilled approvals (F8)**: NO LONGER APPLICABLE — round-2 NFR3 fix (S11 option c) revokes legacy in-flight rows instead of approving them, so no synthetic-approval rows exist.
- **`statusPending` legacy i18n key (F22)**: retained in TenantAdmin.json with a comment + TODO marker for cleanup in the next release; keeps i18n test exhaustive coverage stable while the dialog migrates to `statusPendingApproval`. **Anti-Deferral**: Worst case = stale unused string in 2 locale files. Likelihood = high (will be untouched until cleanup TODO fires). Cost-to-fix = 5 min in next minor release. Acceptable.

### Risks (revised)

| Risk | Mitigation |
|------|------------|
| Initiator-self-approval bypass via TOCTOU on `auth().user.id` | DB CAS WHERE `initiatedById: { not: actor.id }` is the load-bearing guard (S5). App-level pre-check is advisory only. |
| Encrypted token leaked from a corrupt `KeyProvider` key | Domain-separated AAD (`"admin-reset-token-v1"\x00${tenantId}:${resetId}:${targetEmailAtInitiate}`) prevents cross-subsystem substitution (S1). |
| Email-channel token disclosure window (S3) | Effective TTL post-approval = 60 min (F13). Email box compromise still defeats this; documented as residual risk requiring step-up auth in a future PR. |
| KeyProvider rotation during 24h window bricks pending rows (S4) | Decrypt-before-CAS ordering (F7); operator runbook drains pending resets before rotation. |
| Session-invalidation fails partially | Existing helper SELECT → DELETE → tombstone ordering preserved. |
| Multi-tenant session resurrection (F3+S2) | `invalidateUserSessions(... { allTenants: true })` extension covers cross-tenant. |
| Backfilled in-flight legacy rows bypass dual approval (S8) | Migration auto-revokes in-flight rows + emits SYSTEM-actor audit row per row (NFR3 round-2 fix + S17 round-3 fix). No operator drain needed. |
| Email change race during approval window (S9) | `targetEmailAtInitiate` snapshot + AAD binding; approve refuses on email change (FR12). |
| Manual test plan drift | R35 enforced. |

### Citations referenced in the plan / threat model

- **NIST SP 800-63B-4** (Memorized secret reauthentication after credential change) — informs FR7. Section number unverified in this environment; do NOT rely on the specific section as authoritative — flag `citation unverified — please confirm before merging` (R29). The security argument for FR7 stands on attack-vector reasoning (post-credential-rotation, prior sessions are stale-by-policy) WITHOUT spec authority.
- **OWASP ASVS 5.0** does not specify dual-admin approval for vault reset; the requirement is internally driven, NOT spec-driven.

## User operation scenarios

### Scenario 1: Happy path

Tenant has OWNER (Alice), ADMIN-A (Bob), ADMIN-B (Carol), MEMBER (Dave).

1. Bob navigates to Settings → Tenant → Members → Dave → "Reset Vault". Confirms.
2. Reset record created in `pending_approval` status. Carol receives in-app notification + email "Reset for Dave awaits your approval". Dave receives nothing.
3. Carol opens Settings → Tenant → Members → Dave → History → sees pending row → clicks "Approve" → types `APPROVE` → confirms.
4. Approve endpoint succeeds. `expiresAt` reset to `now + 60min`. Dave receives in-app + email with reset URL.
5. Dave opens the URL within 60 minutes, types `DELETE MY VAULT`, confirms. `executeVaultReset()` runs, sessions in ALL tenants Dave belongs to are invalidated. Dave is redirected to dashboard, hits 401, lands on sign-in.

### Scenario 2: Self-approval blocked

1. Bob initiates. Bob tries to approve.
2. App-level pre-check returns 403 (advisory). If bypassed, CAS WHERE returns count=0 → 409. Audit logs the attempt.

### Scenario 3: Race — two approvers click simultaneously

1. Carol and Alice both click Approve at the same moment from separate tenant connections.
2. CAS races. One returns count===1, other count===0 → 409. Email + notification fires once (winner-side).

### Scenario 4: Expired without approval

1. Bob initiates. Carol does not approve. 24h passes.
2. Approve endpoint returns 409 (CAS WHERE includes `expiresAt: { gt: now }`). Email never sent.

### Scenario 5: Compromised admin (audit + revoke flow)

1. Attacker compromises Bob. Initiates reset for Dave.
2. Carol gets pending-approval notification — sees a reset she did not expect, contacts Bob out-of-band, revokes. Dave receives no notification (F2: pending revoke is silent to target).
3. Audit log captures INITIATE + REVOKE rows for incident response.

### Scenario 6: Multi-device target

1. Approve lands. Dave has 3 browsers signed in across 2 tenants. Executes from one.
2. `invalidateUserSessions(... { allTenants: true })` deletes all 3 Session rows + tombstones cache. All 3 browsers hit 401 within `TOMBSTONE_TTL_MS`.

### Scenario 7: Target email changed during approval window

1. Bob initiates. `targetEmailAtInitiate` snapshot stored.
2. Dave changes their account email (legitimate or attacker-controlled).
3. Carol attempts approve. Email-snapshot guard fires; 409 `RESET_TARGET_EMAIL_CHANGED`. Bob must re-initiate with a fresh snapshot.
