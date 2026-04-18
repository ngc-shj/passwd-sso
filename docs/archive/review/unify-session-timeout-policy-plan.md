# Plan: Unify Session Timeout Policy

**Branch**: `feature/unify-session-timeout-policy`
**Design reference**: [docs/security/session-timeout-design.md](../../security/session-timeout-design.md)

## Project Context

- **Type**: web app + browser extension (shared codebase) + service (SaaS)
- **Test infrastructure**: unit (vitest) + integration (real Postgres via `npm run test:integration`) + CI/CD (GitHub Actions). Extension has its own unit tests.
- **Session control surfaces affected**: Auth.js session (web cookie), team policy override, browser extension bearer token, tenant policy (authoritative).

## Objective

Make tenant policy the single source of truth for session lifetime across all surfaces (web session, team scope, browser extension), eliminate the hidden 8-hour Auth.js cap, rename the team session field to have matching semantics with tenant, and clamp Passkey/WebAuthn sessions to NIST 800-63B AAL3 ceilings automatically.

The final design is documented in [session-timeout-design.md](../../security/session-timeout-design.md). This plan implements that design.

## Requirements

### Functional

1. **Tenant policy** exposes four non-nullable session-lifetime fields:
   - `sessionIdleTimeoutMinutes` (default 480, range 1-1440)
   - `sessionAbsoluteTimeoutMinutes` (default 43200, range 1-43200)
   - `extensionTokenIdleTimeoutMinutes` (default 10080, range 1-43200)
   - `extensionTokenAbsoluteTimeoutMinutes` (default 43200, range 1-43200)

2. **Team policy** exposes two nullable session-lifetime fields mirroring tenant:
   - `sessionIdleTimeoutMinutes` (nullable, ≤ tenant value at write time)
   - `sessionAbsoluteTimeoutMinutes` (nullable, ≤ tenant value at write time)
   - Legacy `maxSessionDurationMinutes` is REMOVED (absolute semantics are preserved via `sessionAbsoluteTimeoutMinutes`).

3. **Session record** gains a `provider` field that identifies the authentication method used to establish the session (`google`, `nodemailer`, `webauthn`, `saml`, etc.).

4. **Resolver** computes effective idle/absolute values as `min(tenant, ...teams.filter(non-null))` on every `auth()` call. AAL3 clamp is applied when `session.provider === "webauthn"`: `idle ≤ 15 min`, `absolute ≤ 12h`.

5. **Auth.js `session.maxAge`** constant (`8 * 60 * 60`) is removed from `src/auth.ts`. The adapter's `createSession` and `updateSession` compute `expires` from the resolved policy per user.

6. **Extension token TTL** is driven by tenant policy instead of a hardcoded `EXTENSION_TOKEN_TTL_MS`:
   - Access token `expiresAt` = `now + extensionTokenIdleTimeoutMinutes`.
   - Token family (see below) expires at `familyCreatedAt + extensionTokenAbsoluteTimeoutMinutes`. Refresh is rejected past this point even if the access token is still within the idle window.
   - Refresh flow reuses the existing `/api/extension/token/refresh` path but enforces the absolute cap.

7. **Extension token family tracking**: add a minimal `familyId` + `familyCreatedAt` to `ExtensionToken` so the absolute cap is enforceable. Refresh creates a new token row in the same family; revocation of a family revokes all rows.

8. **Migration** backfills existing tenants with null session fields to the new defaults (`480`/`43200`/`10080`/`43200`). Team `maxSessionDurationMinutes` is migrated: if not null, it is copied to `sessionAbsoluteTimeoutMinutes` (same semantics). Team `sessionIdleTimeoutMinutes` is left null (inherit tenant).

### Non-functional

- Zero downtime: the migration is additive first (new fields + backfill), then a subsequent commit removes the old team column. This allows CI to run a rolling deployment without a schema-code version mismatch window.
- Backwards compatibility for callers of the team policy API: the GET response includes both `maxSessionDurationMinutes` (deprecated, set to the absolute value) and the new fields for one release cycle. PATCH accepts either but canonicalizes to the new fields.
- Browser extension compatibility: existing extension builds must continue to work against the new server. The extension reads `expiresAt` from the token issuance response (already does), so a shorter server-driven TTL is transparent. Longer TTLs simply mean the extension refreshes less often.
- Session cookie lifetime semantics (verified against `@auth/core/lib/actions/session.js`): under Auth.js database strategy, the cookie `Max-Age` is bound to the static `session.maxAge` config value (set once at sign-in) and is NOT re-derived per-user on each `updateSession`. The authoritative expiry is the DB `session.expires` column, which Auth.js checks on every `getSessionAndUser` call — expired DB rows are deleted and the session is cleared. Consequence: the cookie may outlive the server-side session briefly in the browser's cookie jar, but this is not a security concern because the server always validates against DB. We therefore set `session.maxAge` config to the policy ceiling (30d) and let the adapter compute per-user DB `expires` — the enforcement is server-authoritative.

## Technical Approach

### Schema changes

1. **Tenant** gains four new columns; existing `sessionIdleTimeoutMinutes` is flipped from nullable to non-null after backfill.
2. **TeamPolicy** gains `sessionIdleTimeoutMinutes` + `sessionAbsoluteTimeoutMinutes` (both nullable). `maxSessionDurationMinutes` remains in schema for one release, marked `@deprecated` in the Prisma schema comment, then removed in a follow-up migration.
3. **Session** gains `provider String?` column (nullable for existing rows; every new row sets it).
4. **ExtensionToken** gains `familyId String` + `familyCreatedAt DateTime` columns. Existing rows are backfilled with `familyId = id`, `familyCreatedAt = createdAt`.

### Resolver

New module `src/lib/session-timeout.ts`:

```
resolveEffectiveSessionTimeouts(userId, sessionProvider): {
  idleMinutes: number;
  absoluteMinutes: number;
}
```

Responsibilities:
- Fetch tenant and user's team policies (with the existing 60s cache).
- Compute `min(tenant, ...teams.filter(non-null))` for both axes.
- If `sessionProvider === "webauthn"`, clamp `idleMinutes = min(idleMinutes, 15)` and `absoluteMinutes = min(absoluteMinutes, 720)`.
- Return.

`getStrictestSessionDuration()` is deleted in the same commit.

### Auth.js adapter integration

- `src/auth.ts`: set `session.maxAge = 43200 * 60` (30 days — the policy ceiling per the design doc's `sessionAbsoluteTimeoutMinutes` max). This becomes the outer bound for the cookie; the DB row is the authoritative expiry. `updateAge: 30` stays — it throttles how often `updateSession` runs.
- `auth-adapter.ts createSession`: after Auth.js calls createSession with its default `expires`, the adapter reads the resolved policy and overrides `expires = new Date(now + idleMinutes * MS_PER_MINUTE)`. At create time `createdAt === now`, so the absolute bound does not apply yet. Cookie `Max-Age` is NOT overridden (see Non-functional above — bound by config ceiling, DB is authoritative).
- `auth-adapter.ts updateSession`: replace the existing idle check (reads tenant.sessionIdleTimeoutMinutes directly) and team-duration check (calls getStrictestSessionDuration) with a single call to `resolveEffectiveSessionTimeouts`. Check both axes:
  - Idle exceeded: `now - lastActiveAt > idleMinutes * MS_PER_MINUTE` → delete session, return null.
  - Absolute exceeded: `now - createdAt > absoluteMinutes * MS_PER_MINUTE` → delete session, log `SESSION_REVOKE` audit (reason: `tenant_absolute_session_duration_exceeded`), return null.
  - Otherwise: update `expires = new Date(Math.min(now + idleMinutes * MS_PER_MINUTE, createdAt.getTime() + absoluteMinutes * MS_PER_MINUTE))` AND `lastActiveAt = now`. This correctly models the absolute axis as non-rolling while the idle axis rolls.

### Extension token integration

- `src/lib/extension-token.ts issueExtensionToken`: read `extensionTokenIdleTimeoutMinutes` from the tenant, set `expiresAt = now + idleTimeout`. New field `familyId` = new UUID for first issuance, or parent's `familyId` for refresh. `familyCreatedAt` = new timestamp for first issuance, or parent's for refresh.
- `src/app/api/extension/token/refresh/route.ts`: before issuing a new token, compute `now - familyCreatedAt`. If exceeds `extensionTokenAbsoluteTimeoutMinutes`, reject with `EXTENSION_TOKEN_FAMILY_EXPIRED` and revoke the family.
- Revocation: `revokeExtensionTokenFamily(familyId, userId, tenantId, reason)` — new helper. Accepts explicit userId/tenantId from callers so the audit event can be scoped without an extra DB fetch. Internally calls `extensionToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } })` then emits audit. Called on refresh replay detection, on user "sign out everywhere", on passkey re-auth, and on user delete cascade.
- `EXTENSION_TOKEN_TTL_MS` constant deleted. `EXTENSION_TOKEN_MAX_ACTIVE = 3` retained (independent throttle against token-issuance abuse).

### Session provenance

- `auth-adapter.ts createSession` accepts a `provider` via `AsyncLocalStorage` (reuse `sessionMetaStorage`). Auth.js provides the provider in the `signIn` callback — we store it in the async store the same way we store IP/UA today.
- **Implementation note (ALS mutation pattern)**: `sessionMetaStorage.run(meta, ...)` is called once at route-handler entry (`src/app/api/auth/[...nextauth]/route.ts:46`). The `signIn` callback runs inside this scope but cannot replace the stored value mid-flow (ALS does not allow that). Instead, we extend the `SessionMeta` interface with an optional `provider?: string | null` field and the signIn callback does `const meta = sessionMetaStorage.getStore(); if (meta) meta.provider = params.account?.provider ?? null;`. `createSession` reads the same object via `sessionMetaStorage.getStore()`. This relies on ALS returning the same object reference within the async chain (standard Node.js behavior).
- `src/app/api/auth/passkey/verify/route.ts` `tx.session.create({ data: { ..., provider: "webauthn" } })` — explicitly sets the provider (does not go through Auth.js, so sessionMetaStorage is not in effect here).
- Backfill migration sets existing `Session.provider` to `NULL` (not "unknown"). Resolver treats NULL as non-AAL3 — existing sessions use the non-clamped policy until natural expiry.
- **Security boundary**: the `provider` value is set ONLY by server-side code: (a) the `signIn` callback via `params.account?.provider` (provided by Auth.js after OAuth/OIDC exchange — not user-controlled), and (b) the passkey verify route via a literal string constant. No request headers, query params, or body fields feed into this value. Any future authentication entry point MUST also source `provider` from trusted server-side state, not from request input — this is a security invariant. Cited: [OWASP ASVS 5.0 V7.2 (Fundamental Session Management Security)](https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x16-V7-Session-Management.md#v72-fundamental-session-management-security), [NIST SP 800-63B Rev 4 §5.1 (Session Bindings)](https://pages.nist.gov/800-63-4/sp800-63b.html).
- **Post-migration AAL3 degradation window**: existing sessions that were Passkey-established before this deploy have `provider = NULL` → non-AAL3 resolver path → stay under the looser tenant policy until their next natural expiry (up to `sessionAbsoluteTimeoutMinutes`, default 30d). This is a one-time migration artifact, NOT a compliance violation per [NIST SP 800-63B-4 §2.3.3 (AAL3 Reauthentication)](https://pages.nist.gov/800-63-4/sp800-63b.html) — reauthentication requirements apply to new sessions. Tenant admins with strict AAL3 requirements may invoke "sign out everywhere" post-deploy as a mitigation. This trade-off is accepted to avoid disrupting active users. Document in `CHANGELOG.md` and release notes.

### UI changes

- **TenantSessionPolicyCard**: replace the "disabled/enabled" toggle pattern for idle with a plain required-number input. Add three new input rows: session absolute, extension idle, extension absolute. Group the four into two logical sections: "Web session" and "Browser extension". Add help text that states "max N days; WebAuthn sessions use stricter AAL3 limits".
- **TeamPolicySettings**: remove the single `maxSessionDurationMinutes` input; add `sessionIdleTimeoutMinutes` (optional) + `sessionAbsoluteTimeoutMinutes` (optional) with help text "leave blank to inherit tenant default; must be ≤ tenant value".
- **i18n**: delete `maxSessionDurationMinutes` / `maxSessionDurationHelp` keys. Add keys for the six new fields (en + ja). Update the existing `idleTimeoutHelp` text to drop "disabled" language.

## Known Call Sites (Pre-implementation Inventory)

Verified via grep at plan time. Every site below is in scope.

### `EXTENSION_TOKEN_TTL_MS` usages (3 files, all must be removed)
- [src/lib/constants/extension-token.ts:25](../../../src/lib/constants/extension-token.ts#L25) — definition
- [src/lib/constants/index.ts:75](../../../src/lib/constants/index.ts#L75) — re-export
- [src/lib/extension-token.ts:8](../../../src/lib/extension-token.ts#L8), [src/lib/extension-token.ts:147](../../../src/lib/extension-token.ts#L147) — issuance
- [src/app/api/extension/token/refresh/route.ts:8](../../../src/app/api/extension/token/refresh/route.ts#L8), [src/app/api/extension/token/refresh/route.ts:59](../../../src/app/api/extension/token/refresh/route.ts#L59) — refresh
- All tests importing the constant — must be updated or removed.

### `8 * 60 * 60` usages
- [src/auth.ts:217](../../../src/auth.ts#L217) — the only occurrence in `src/`. Verified via grep. No tests reference the literal value today.

### `session.delete` / `session.deleteMany` call sites (must preserve extension-token lifecycle coherence)
- [src/lib/auth-adapter.ts:277](../../../src/lib/auth-adapter.ts#L277) — concurrent-session eviction on createSession. Does NOT touch extension tokens (correct — eviction is session-specific, extension survives).
- [src/lib/auth-adapter.ts:388](../../../src/lib/auth-adapter.ts#L388), [src/lib/auth-adapter.ts:455](../../../src/lib/auth-adapter.ts#L455), [src/lib/auth-adapter.ts:472](../../../src/lib/auth-adapter.ts#L472) — adapter's own session deletion paths. No extension coupling needed — adapter is session-only.
- [src/app/api/sessions/[id]/route.ts:58](../../../src/app/api/sessions/[id]/route.ts#L58) — single-session revoke. Extension survives (correct — user may still want extension working).
- [src/app/api/sessions/route.ts:99](../../../src/app/api/sessions/route.ts#L99) — "sign out everywhere except current." **Must also revoke extension tokens** — current behavior leaves them alive, which is a latent bug exposed by this plan. Update to call `invalidateUserSessions()` subset or a new `revokeAllExtensionTokensForUser()` helper.
- [src/lib/user-session-invalidation.ts:19](../../../src/lib/user-session-invalidation.ts#L19) — `invalidateUserSessions()`. Already revokes `extensionToken` rows via `updateMany({ data: { revokedAt: now } })`. With family tracking, this still works: refresh cannot succeed when every row in a family is revoked. **No change required**. Confirmed by inspection.
- [src/app/api/auth/passkey/verify/route.ts:104](../../../src/app/api/auth/passkey/verify/route.ts#L104) — passkey verify deletes any prior sessions for the user. Extension tokens should also be invalidated here to maintain credential-freshness invariant: a passkey re-auth revokes all prior bearer tokens. Explicit change.

### Session-creation call sites (must set `provider` consistently)
- [src/lib/auth-adapter.ts:237](../../../src/lib/auth-adapter.ts#L237) `createSession()` — called by Auth.js for Google OIDC, SAML (via Jackson OIDC bridge), and Magic Link (nodemailer). Provider is captured via `sessionMetaStorage` async context.
- [src/app/api/auth/passkey/verify/route.ts:107](../../../src/app/api/auth/passkey/verify/route.ts#L107) `tx.session.create()` — custom flow; explicitly sets `provider: "webauthn"`.
- No other session-creation sites exist in `src/`. Verified via grep for `session.create` and `sessionToken:` with `create`.

### Prisma type exposure
- Adding columns to `Tenant`, `TeamPolicy`, `Session`, `ExtensionToken` triggers Prisma Client regeneration (`prisma generate`). DTO types (`TenantPolicyDto`, `TeamPolicyDto`) and derived form state types used in the UI must be updated in lockstep — listed explicitly per file in the UI step below.

## Cache Invalidation Contract

The existing `invalidateTenantPolicyCache(tenantId)` invalidates the access-restriction cache on tenant policy PATCH. The new resolver `resolveEffectiveSessionTimeouts` uses the **existing** `src/lib/team-policy.ts` team policy cache (via `getTeamPolicy`) and a new named cache owned by `src/lib/session-timeout.ts`.

Named cache + invalidator (defined in `src/lib/session-timeout.ts`):
- Cache keyed by `userId`, TTL 60s, max-size 10_000 (same pattern as existing `sessionDurationCache`).
- Each cache entry stores `{ idleMinutes, absoluteMinutes, tenantId, expiresAt }`. The `tenantId` field enables bulk invalidation by tenant.
- `invalidateSessionTimeoutCache(userId)` — single-user invalidation; O(1).
- `invalidateSessionTimeoutCacheForTenant(tenantId)` — bulk invalidation: iterate the Map and delete entries where `entry.tenantId === tenantId`. O(n) in cache size, acceptable at 10k ceiling and 60s TTL. Called on tenant PATCH.

Invalidation points (must be wired in the same PR):
- `PATCH /api/tenant/policy` — call `invalidateSessionTimeoutCacheForTenant(tenantId)` alongside existing `invalidateTenantPolicyCache(tenantId)`.
- `PATCH /api/teams/[teamId]/policy` — call `invalidateSessionTimeoutCacheForTenant(team.tenantId)` alongside the existing team-policy invalidation. (Per-user invalidation is too granular for team policy changes.)
- Team membership change (add/remove member) — call `invalidateSessionTimeoutCache(userId)` for the affected user. This was implicit in the old `sessionDurationCache` (also keyed by userId) but should be made explicit in the team-member route.

## Implementation Steps

1. **Validations**: Add constants `SESSION_ABSOLUTE_TIMEOUT_MIN=1`, `SESSION_ABSOLUTE_TIMEOUT_MAX=43200`, `EXTENSION_TOKEN_IDLE_MIN=1`, `EXTENSION_TOKEN_IDLE_MAX=43200`, `EXTENSION_TOKEN_ABSOLUTE_MIN=1`, `EXTENSION_TOKEN_ABSOLUTE_MAX=43200` to `src/lib/validations/common.ts`. The existing `SESSION_IDLE_TIMEOUT_MIN = 1` / `SESSION_IDLE_TIMEOUT_MAX = 1440` (at common.ts:157-158) is REUSED as-is for both tenant and team idle fields — do NOT duplicate. Add unit tests for the new constants.

2. **Schema migration (additive)**: `prisma/migrations/YYYYMMDDHHMMSS_unify_session_timeout_policy/migration.sql`. DDL ordering per table:

   **tenants** (existing `session_idle_timeout_minutes` is nullable; 3 new columns default-populated):
   ```sql
   -- New columns get NOT NULL DEFAULT inline (safe because default covers all existing rows)
   ALTER TABLE tenants
     ADD COLUMN session_absolute_timeout_minutes INTEGER NOT NULL DEFAULT 43200,
     ADD COLUMN extension_token_idle_timeout_minutes INTEGER NOT NULL DEFAULT 10080,
     ADD COLUMN extension_token_absolute_timeout_minutes INTEGER NOT NULL DEFAULT 43200;
   -- Existing column: backfill NULL before NOT NULL flip
   UPDATE tenants SET session_idle_timeout_minutes = 480 WHERE session_idle_timeout_minutes IS NULL;
   ALTER TABLE tenants
     ALTER COLUMN session_idle_timeout_minutes SET NOT NULL,
     ALTER COLUMN session_idle_timeout_minutes SET DEFAULT 480;
   ```

   **team_policies**:
   ```sql
   ALTER TABLE team_policies
     ADD COLUMN session_idle_timeout_minutes INTEGER,
     ADD COLUMN session_absolute_timeout_minutes INTEGER;
   -- Carry semantics from old field (absolute, createdAt-based)
   UPDATE team_policies SET session_absolute_timeout_minutes = max_session_duration_minutes
     WHERE max_session_duration_minutes IS NOT NULL;
   -- Column max_session_duration_minutes is KEPT in schema with @deprecated comment this release;
   -- deleted in the post-release cleanup migration (step 12).
   ```

   **sessions**:
   ```sql
   ALTER TABLE sessions ADD COLUMN provider VARCHAR(64);
   -- Left NULL for existing rows; resolver treats NULL as non-AAL3 (see Session provenance section)
   ```

   **extension_tokens**:
   ```sql
   ALTER TABLE extension_tokens
     ADD COLUMN family_id UUID,
     ADD COLUMN family_created_at TIMESTAMPTZ(3);
   -- Backfill from the row's own id/createdAt so existing tokens form single-row families
   UPDATE extension_tokens SET family_id = id, family_created_at = created_at
     WHERE family_id IS NULL;
   ALTER TABLE extension_tokens
     ALTER COLUMN family_id SET NOT NULL,
     ALTER COLUMN family_created_at SET NOT NULL;
   CREATE INDEX extension_tokens_family_id_revoked_at_idx
     ON extension_tokens (family_id, revoked_at);
   ```

   **RLS**: No role grant changes required — new columns on existing tables inherit existing table-level grants. Verified against `prisma/init/*.sql` for `passwd_app` / `passwd_outbox_worker` role scope (R14).

   **Env safety**: No `current_database()` references needed (migration does not touch database names or role names). No hardcoded env values (R15).

3. **Resolver**: Write `src/lib/session-timeout.ts` with `resolveEffectiveSessionTimeouts(userId, sessionProvider)`. Full unit tests covering: no-teams, one-team-with-null, one-team-stricter, multi-team-min, AAL3 clamp for webauthn, tenant floor when all team values null.

4. **Auth.js integration**: Update `src/auth.ts` to keep `maxAge = 30 * 24 * 60 * 60` (outer ceiling, never authoritative). Update `auth-adapter.ts createSession` + `updateSession` to call resolver and override `expires`. Delete `getStrictestSessionDuration` from `team-policy.ts`. Update `auth-adapter.test.ts`: remove assertions on the 8h constant, add assertions for resolver-based expiry.

5. **Session provenance wiring**: Extend `sessionMetaStorage` async context with `provider`. Populate it in the `signIn` callback in `auth.ts` via `params.account?.provider`. Pass it through to `createSession`. Set `provider = "webauthn"` in passkey verify route.

6. **Tenant policy API + UI**: Extend `PATCH /api/tenant/policy` validation (all four session/extension fields: reject null, reject non-integer, reject value < min or > max). `updateData` wiring for the new fields. Update GET response. Update `tenant-session-policy-card.tsx` with new inputs. Update i18n keys.

   **Cascade clamp on tenant-value lowering** (Scenario 6): when the PATCH lowers `sessionIdleTimeoutMinutes` or `sessionAbsoluteTimeoutMinutes`, the same transaction:
   1. Queries `team_policies` joined to `teams` on the same tenantId, selecting rows where the corresponding column exceeds the new tenant value.
   2. `UPDATE team_policies SET ... = <new tenant value>` for each match.
   3. Emits one `TEAM_POLICY_CLAMPED_BY_TENANT` audit event per affected team with metadata `{ previousValue, newValue, field, tenantId }`.

   Scope query: `prisma.teamPolicy.findMany({ where: { team: { tenantId: membership.tenantId }, [field]: { gt: newValue } } })`. Transaction MUST use `isolationLevel: "Serializable"` (same pattern as `createSession` concurrent-session eviction at `auth-adapter.ts:300`) to prevent TOCTOU with concurrent team admin PATCHes (R5).

   Register the new audit action alongside `EXTENSION_TOKEN_FAMILY_REVOKED` (step 8): `src/lib/constants/audit.ts` additions for `TEAM_POLICY_CLAMPED_BY_TENANT`, with tenant-scoped labels and webhook event group membership. Update i18n `AuditLog.json` and action-group enumeration tests (R12).

   Invalidate `invalidateSessionTimeoutCache(tenantId)` (see Cache Invalidation Contract) after commit. Add route tests including cascade-clamp scenario.

7. **Team policy API + UI**: Remove `maxSessionDurationMinutes` from validation/updateData/GET response. Add `sessionIdleTimeoutMinutes` + `sessionAbsoluteTimeoutMinutes` (both nullable).

   **Validation** (per field; reject before any DB write):
   - `value === null` → accept (inherit tenant)
   - `Number.isInteger(value) === false` → 400
   - `value < 1` → 400 (reject 0, negative)
   - `value > tenant.{correspondingField}` → 400 with a descriptive message ("exceeds tenant cap of N minutes"). Requires reading tenant value in the PATCH handler before commit.

   Update `team-policy-settings.tsx`. Update i18n keys (delete `maxSessionDurationMinutes` + `maxSessionDurationHelp`; add six new keys for tenant-idle, tenant-absolute, extension-idle, extension-absolute, team-idle, team-absolute; en + ja). If repo has an i18n key-parity test, update it; if not, add one asserting `keys(en) === keys(ja)` for `TenantAdmin.json` and `TeamPolicy.json` (R12/T4).

   Add route tests including: reject 0, reject negative, reject non-integer, reject > tenant, accept null.

8. **Extension token**: Extend `issueExtensionToken` to read tenant policy for TTL and compute family fields. Extend `/api/extension/token/refresh` with family-absolute check + new error code. Add `revokeExtensionTokenFamily(familyId, reason)` helper. Update `EXTENSION_TOKEN_INVALID` error-code enum with `EXTENSION_TOKEN_FAMILY_EXPIRED`. Delete `EXTENSION_TOKEN_TTL_MS` constant. Update tests: `extension-token.test.ts`, `extension/token/refresh/route.test.ts`.

   **Audit logging** (R12/S4): `revokeExtensionTokenFamily` must emit `EXTENSION_TOKEN_FAMILY_REVOKED` audit event with metadata `{ reason: "family_expired" | "replay_detected" | "sign_out_everywhere" | "passkey_reauth", familyId, rowsRevoked }` scoped to the affected user via `logAuditAsync`. Register the new action:
   - `src/lib/constants/audit.ts`: add to `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, `AUDIT_ACTION_GROUPS_PERSONAL[SESSION]`, `TENANT_WEBHOOK_EVENT_GROUPS` if applicable.
   - i18n: add label keys in `messages/*/AuditLog.json` (en + ja).
   - Tests: update audit-action enumeration tests.

9. **Bearer-token invalidation on session revoke**: Two call sites need updating (per Known Call Sites section):
   - `src/app/api/sessions/route.ts` DELETE ("sign out everywhere except current") — add extension-token revocation for the user.
   - `src/app/api/auth/passkey/verify/route.ts` (passkey re-auth) — add extension-token revocation so a passkey event refreshes all bearer credentials.
   Implementation: extract the extension-revocation snippet from `invalidateUserSessions()` into a reusable `revokeAllExtensionTokensForUser(userId, tenantId)` helper, call from both sites. `invalidateUserSessions()` itself is unchanged (already revokes extension tokens via `updateMany`).

10. **Documentation**: Update [policy-enforcement.md](../../security/policy-enforcement.md) table: remove `maxSessionDurationMinutes` row, add rows for the six new fields with enforcement location. Cross-link [session-timeout-design.md](../../security/session-timeout-design.md) from the new `README.md` entry (already done).

11. **Integration test**: Add `src/__tests__/db-integration/session-timeout.integration.test.ts` covering: (a) tenant-only policy resolution, (b) team override, (c) AAL3 clamp via webauthn provider, (d) session deletion on absolute-exceed, (e) extension refresh rejection past family absolute.

12. **Post-release cleanup migration**: A second, separate migration removes `team_policies.max_session_duration_minutes`. Shipped in the release AFTER the one that lands this plan, so an in-place rollback of this release still has the column.

## Testing Strategy

### Unit

- `src/lib/session-timeout.test.ts` — resolver: no teams, one team null, one team set, multiple teams, AAL3 clamp for webauthn provider, non-webauthn provider no clamp, NULL provider no clamp, NaN/negative guards (defense-in-depth), cache hit/miss.
- `src/lib/auth-adapter.test.ts` — updated:
  - createSession overrides expires to `now + idle` (not 30d default).
  - updateSession deletes on idle exceed; updateSession deletes on absolute exceed AND emits `SESSION_REVOKE` audit.
  - **Absolute-boundary off-by-one** (T2): a session with `createdAt + absolute === now - 1s` is deleted; a session with `createdAt + absolute === now + 1s` survives and has `expires` set to `now + min(idle, 1s)`.
  - updateSession computes `expires = min(now + idle, createdAt + absolute)` (verify against fixtures covering idle-stricter and absolute-stricter cases).
  - Remove all assertions that reference the removed 8h constant.
- `src/lib/extension-token.test.ts` — new: `familyId`/`familyCreatedAt` populated on issue; refresh creates sibling in same family; refresh past absolute rejected (off-by-one at the boundary); `revokeExtensionTokenFamily` emits audit event.
- `src/__tests__/api/tenant/tenant-policy.test.ts` — updated: new fields validated; reject negative / zero / > max / non-integer; reject null after flip; accept valid values; GET response includes new fields. Add cascade-clamp test (T5): PATCH lowers tenant, two teams (one exceeds, one null) — verify only the exceeding team is clamped and audit event emitted.
- `src/__tests__/api/teams/team-policy.test.ts` — updated: new fields validated; reject 0/negative/non-integer; reject value > tenant's value with descriptive error; accept null; legacy `maxSessionDurationMinutes` removed from API (both GET and PATCH 400 if sent).
- `src/app/api/extension/token/refresh/route.test.ts` — updated: family expiry rejection returns `EXTENSION_TOKEN_FAMILY_EXPIRED`; audit event emitted.
- UI test: `tenant-session-policy-card.test.tsx` — renders four required inputs (no "disabled" toggle), posts PATCH with correct payload, displays "WebAuthn sessions use stricter AAL3 limits" help text.
- UI test: `team-policy-settings.test.tsx` — two optional inputs, ≤ tenant constraint hint, null default indicates "inherit tenant".
- i18n parity test: `keys(en/TenantAdmin.json) === keys(ja/TenantAdmin.json)`; same for `TeamPolicy.json` and `AuditLog.json` (T4).

### Integration (real DB)

- `src/__tests__/db-integration/session-timeout.integration.test.ts`:
  - (a) Tenant-only policy resolution — seeds tenant at defaults, no team; resolver returns tenant values.
  - (b) Team override — seeds tenant with 43200/43200, team with 60/240; resolver for user in team returns (60, 240).
  - (c) AAL3 clamp for webauthn — seeds tenant at 30d/30d; session with `provider = "webauthn"`; resolver returns (15, 720).
  - (d) Absolute-exceed deletion — seeds session with `createdAt = now - 13h`, tenant absolute = 12h; call updateSession; assert session row deleted and SESSION_REVOKE audit emitted.
  - (e) Extension refresh rejection past family absolute — seeds token family with `familyCreatedAt = now - 8d`, tenant extension absolute = 7d; POST refresh returns `EXTENSION_TOKEN_FAMILY_EXPIRED` and audit emitted.
  - **(f) Migration backfill** (T3) — apply the migration on a seed DB with a tenant having `session_idle_timeout_minutes = NULL`, a team with `max_session_duration_minutes = 720`, an extension_token row with NULL `family_id`. Post-migration assertions: tenant has 480 (backfilled), new columns at defaults; team has `session_absolute_timeout_minutes = 720` (copied); extension_token has `family_id = id`, `family_created_at = created_at`.
  - **(g) Cascade clamp concurrency** (T5) — baseline: tenant at 43200, teamA at 720, teamB null. Call tenant PATCH lowering to 240 — verify teamA clamped to 240, teamB unchanged, one audit event per affected team. Run under Serializable isolation; ensure concurrent teamA PATCH does not corrupt state.
- `src/__tests__/db-integration/helpers.ts` — update to include new required fields when seeding tenants/teams.

### Manual / E2E

- Sign in via Google OIDC, verify DB `session.expires ≈ now + tenant default idle`. Then wait past idle window, trigger an authenticated request; verify redirect to signin. Cookie lingering past session in browser is expected (see Non-functional).
- Sign in via Passkey, verify `session.provider = "webauthn"` and DB expires clamped to ≤ 15 min idle / ≤ 12h absolute even if tenant allows 30d.
- Tenant admin changes tenant idle to 30 min. Existing active session with `lastActiveAt > 30 min` ago → on the user's NEXT HTTP activity, Auth.js calls `updateSession`, the adapter deletes the DB row, and the user is redirected to signin. Note: if the user's tab is idle (no requests), deletion happens on the next activity — it is NOT a scheduled job.
- Team admin sets team absolute to 4h on tenant with 30d; team members get signed out ≤4h after their session `createdAt`.
- Extension: issue token, use it 2h later — still works. Refresh token 8 days after family creation on a 7-day tenant — rejected with family-expired error, extension clears stored token.

## Considerations & Constraints

### Known risks

- **Session cookie Max-Age drift**: If `updateSession` recomputes `expires` on every heartbeat (every 30s per `updateAge`), the cookie's Max-Age extends. This is correct (rolling) behavior for `idle`, but the `absolute` cap is NOT rolling — we must reject when `createdAt + absolute < now`, regardless of current expires. Enforced in the resolver + updateSession check.
- **Migration order with existing sessions**: Existing Session rows have `provider = NULL`. Those fall into the "non-AAL3" path (no clamp) — safe default. New sessions get provider set.
- **Team admin can only tighten, not loosen**: The `≤ tenant value` constraint prevents a team admin from granting longer sessions than the tenant allows. Enforced server-side on PATCH.
- **AAL3 clamp applies only to webauthn-established sessions**: A user who has a passkey but signs in via Google gets the non-AAL3 policy for that session. This is correct by NIST's definition — AAL is a property of the authentication event, not the user.
- **Extension token family size**: With max 3 active tokens + refresh rotation, a family accumulates rows over the absolute window. Quantified: over 30d absolute, with idle TTL default 7d, a family rotates ~30/7 × 3 = ~13 rows per user. At 10k users: ~130k rows. Table growth is bounded and well within Postgres performance range. Likelihood of pressure: low. Cost to fix: medium (scheduled job). Deferred to a follow-up issue; this PR adds the `(family_id, revoked_at)` index now for cheap lookup and future pruner support. `TODO(unify-session-timeout-policy): add family row pruner if monitoring shows growth.`
- **Rollback**: If the rollout hits a blocker, the additive migration in step 2 is safe to keep in place; code changes can be reverted independently. The cleanup migration in step 12 is shipped in a later release, so it never ships in the same release as this plan.

### Out of scope

- MCP / SA / API key / JIT token TTL changes (governed separately; no conflict with this plan).
- Vault auto-lock (`vaultAutoLockMinutes`) — client-side timer for vault encryption state, separate concern.
- Extension-side local-unlock/biometric timeout — orthogonal defense, lives in extension codebase.
- Concurrent-session limit (`maxConcurrentSessions`) — separate tenant field, no change here.
- Account lockout settings — separate.

## User Operation Scenarios

### Scenario 1: Tenant admin first-time configuration

A tenant admin navigates to Settings → Session Policy. They see:
- Web session idle timeout: 480 min (prefilled)
- Web session absolute timeout: 43200 min (prefilled)
- Browser extension idle timeout: 10080 min (prefilled)
- Browser extension absolute timeout: 43200 min (prefilled)
- Help text on each field; no "disabled" toggle.

They lower web idle to 60 min. Save succeeds. An existing session whose `lastActiveAt` is older than 60 min is signed out at the user's next HTTP activity that triggers `updateSession`. Note: `updateAge: 30` is a throttle on how often `updateSession` may run, NOT a scheduled heartbeat — an idle tab without HTTP activity does not self-expire until the user interacts.

### Scenario 2: Team admin stricter override

A team admin of the "Finance" team navigates to Team → Security Policy. They see two optional inputs:
- Session idle timeout (inherit: tenant 60 min)
- Session absolute timeout (inherit: tenant 43200 min)

They set team absolute to 240 min (4h). Server validates: 240 ≤ 43200 (tenant value) → OK. Team members' sessions are signed out 4h after `createdAt`, regardless of activity.

### Scenario 3: Passkey sign-in (AAL3)

A user signs in via Passkey. The session's `provider = "webauthn"`. On every `auth()` call, the resolver clamps effective idle to 15 min and effective absolute to 12h, even though the tenant policy allows longer. On the user's next HTTP activity after 15 min idle OR past the 12h absolute boundary, the session is deleted and the user is redirected to signin. This is not configurable.

### Scenario 4: Extension refresh past absolute

A user's extension was authorized 7 days ago. Tenant `extensionTokenAbsoluteTimeoutMinutes = 10080` (7 days). The access token expires every 8 hours (tenant idle), and the extension refreshes silently. On the first refresh attempt after day-7, the server returns `EXTENSION_TOKEN_FAMILY_EXPIRED`. The extension clears its stored token and prompts the user to re-authorize via the web app.

### Scenario 5: Sign out everywhere

A user (e.g., after losing a device) clicks "Sign out everywhere" in settings. The endpoint deletes all Session rows for that user AND revokes all extension token families. Next time the extension tries to refresh, it gets `EXTENSION_TOKEN_FAMILY_EXPIRED` immediately.

### Scenario 6: Tenant lowers tenant value below team value

A tenant admin lowers tenant `sessionAbsoluteTimeoutMinutes` from 43200 to 240. A team currently has `sessionAbsoluteTimeoutMinutes = 720`. Because the team value must be ≤ tenant, the team value becomes invalid.

Decision: **cascade clamp on write**. When tenant value is lowered, team values exceeding it are clamped to the new tenant value in the same transaction. The transaction uses Serializable isolation (per step 6) to prevent TOCTOU with a concurrent team admin PATCH. An audit log entry `TEAM_POLICY_CLAMPED_BY_TENANT` is emitted for each affected team. Team admins see a notification banner on their next visit.

(Alternative considered: reject the tenant write if any team exceeds. Rejected because it would make tenant admin policy tightening contingent on team admins' cooperation — wrong power hierarchy.)
