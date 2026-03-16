# Code Review: full-codebase-review
Date: 2026-03-17
Review round: 1

## Changes from Previous Round
Initial review — full codebase review of ~180k lines, 1100 files.

## Functionality Findings

### F-C1 [Critical] Vault unlock permanently fails after passphrase change
- **File:** `src/app/api/vault/change-passphrase/route.ts` lines 100-112
- **Problem:** `masterPasswordServerHash`/`masterPasswordServerSalt` are never updated during passphrase change. After a change, `POST /api/vault/unlock` compares the new passphrase's authHash against the old stored hash and always fails, incrementing the lockout counter.
- **Verified:** `setup/route.ts` (lines 121-124) and `rotate-key/route.ts` (lines 90-93) correctly compute and store new server hash/salt. `change-passphrase/route.ts` omits this entirely.
- **Fix:** Require client to send `newAuthHash` in the change-passphrase payload. Compute and store new `masterPasswordServerHash`/`masterPasswordServerSalt`.

### F-C2 [Critical] Vault unlock permanently fails after recovery-key recovery
- **File:** `src/app/api/vault/recovery-key/recover/route.ts` lines 182-205
- **Problem:** Same root cause as F-C1. The `handleReset` step stores new vault wrapping data and verifier but leaves `masterPasswordServerHash`/`masterPasswordServerSalt` pointing to the old passphrase's hash.
- **Fix:** Require client to send `newAuthHash` in the reset payload. Compute and store new server hash/salt.

### F-M1 [Major] Team member removal deletes tenant-level SCIM external ID mapping
- **File:** `src/app/api/teams/[teamId]/members/[memberId]/route.ts` line 193
- **Problem:** `scimExternalMapping.deleteMany` with `resourceType: "User"` deletes the user's SCIM mapping at the tenant level when they are removed from a single team. SCIM User mappings are tenant-scoped identity records. Removing a team membership should not destroy the user's IdP linkage. Next SCIM sync will fail to reconcile this user.
- **Fix:** Remove `scimExternalMapping.deleteMany` from team-member DELETE handler.

### F-M2 [Major] Auto-purge of trashed entries orphans blob-store attachments
- **File:** `src/app/api/passwords/route.ts` lines 66-76
- **Problem:** `passwordEntry.deleteMany` cascades to delete `Attachment` DB rows but does not call `blobStore.deleteObject()` for externally-stored blob data, causing permanent storage leaks.
- **Fix:** Fetch attachment blob references before purging entries, call `blobStore.deleteObject` for each. Alternatively, move auto-purge to the maintenance endpoint with proper cleanup.

### F-M3 [Minor] FILE share metadata accessible without consuming view count
- **File:** `src/app/api/share-links/[id]/content/route.ts` lines 82-98
- **Problem:** For FILE shares, the content endpoint returns metadata (sendName, sendFilename, sendSizeBytes) without incrementing viewCount. By design (view = download), but allows unlimited metadata enumeration.
- **Assessment:** Downgraded to Minor — metadata is needed for download UI display. The download route correctly increments viewCount.

## Security Findings

### S-M1 [Major] Non-timing-safe auth hash comparison
- **File:** `src/app/api/vault/unlock/route.ts` line 93, `src/app/api/vault/rotate-key/route.ts` line 85
- **Problem:** `computedHash !== user.masterPasswordServerHash` uses JavaScript string comparison (not constant-time). `timingSafeEqual` is available in the crypto module but not used here.
- **Mitigation:** SHA-256 computation dominates timing; account lockout limits attempts.
- **Fix:** Use `timingSafeEqual` from `node:crypto` for all credential hash comparisons.

### S-M2 [Major] SSRF via DNS rebinding on webhook delivery
- **File:** `src/lib/webhook-dispatcher.ts` line 103, `src/app/api/teams/[teamId]/webhooks/route.ts`, `src/app/api/tenant/webhooks/route.ts`
- **Problem:** Webhook URL validation at registration checks the hostname string, but DNS rebinding allows an attacker to register a legitimate external hostname that later resolves to an internal IP (127.0.0.1, 169.254.169.254). No post-DNS-resolution IP validation exists.
- **Mitigation:** Requires admin access to register webhooks; `redirect: "error"` prevents redirect-based SSRF.
- **Fix:** Add DNS pre-resolution with private IP blocklist before making the HTTP request.

### S-m1 [Minor] CSP nonce cookie missing `Secure` flag
- **File:** `src/proxy.ts` line 337-341
- **Problem:** The `csp-nonce` cookie omits the `secure` flag, unlike the session cookie which correctly uses `useSecureCookies`.
- **Fix:** Add `secure: isHttps` to the nonce cookie options.

### S-m2 [Minor] `assertOrigin` missing on vault unlock/change-passphrase/rotate-key
- **File:** `src/app/api/vault/unlock/route.ts`, `src/app/api/vault/change-passphrase/route.ts`, `src/app/api/vault/rotate-key/route.ts`
- **Problem:** `assertOrigin()` is applied to reset/admin-reset/recovery but not unlock/change-passphrase/rotate-key. Inconsistent defense-in-depth coverage.
- **Fix:** Apply `assertOrigin()` to these three routes for consistency.

### S-m3 [Minor] `allowDangerousEmailAccountLinking` unrestricted without domain config
- **File:** `src/auth.config.ts` line 34
- **Problem:** When `GOOGLE_ALLOWED_DOMAINS` is not configured, `allowDangerousEmailAccountLinking: true` allows any Google account to link to existing accounts by email.
- **Fix:** Set `allowDangerousEmailAccountLinking: false` when `allowedGoogleDomains.length === 0`.

## Testing Findings

### T-C1 [Critical] wrapSecretKey/unwrapSecretKey have no tests
- **File:** `src/lib/crypto-client.ts` — `wrapSecretKey`, `unwrapSecretKey`, `computeAuthHash`, `createVerificationArtifact`, `verifyKey`
- **Problem:** Core client-side vault operations have zero test coverage. Only `deriveWrappingKey`/`deriveWrappingKeyWithParams` are tested.
- **Fix:** Add roundtrip tests for wrap/unwrap, tampered ciphertext rejection, computeAuthHash determinism, verification artifact roundtrip.

### T-C2 [Critical] Coverage thresholds never enforced in CI
- **File:** `vitest.config.ts` lines 37-41, `.github/workflows/ci.yml` line 97
- **Problem:** Coverage thresholds defined in vitest.config.ts are never executed in CI (CI runs `npm test` not `npm run test:coverage`).
- **Fix:** Change CI test step to `npm run test:coverage` or add a separate coverage job.

### T-M1 [Major] Travel Mode API routes have no tests
- **Source:** `src/app/api/travel-mode/{route,enable/route,disable/route}.ts`
- **Fix:** Add route tests for auth, success, and DB mutation assertions.

### T-M2 [Major] WebAuthn authenticate/verify route has no tests
- **Source:** `src/app/api/webauthn/authenticate/verify/route.ts`
- **Fix:** Add tests for auth, rate limit, Redis unavailable, challenge verification.

### T-M3 [Major] Directory-sync API routes have no tests
- **Source:** `src/app/api/directory-sync/{route,[id]/route,[id]/run/route,[id]/logs/route}.ts`
- **Fix:** Add route-level tests with auth guards and sync engine mocking.

### T-M4 [Major] `createMockPrisma` helper is dead code with broken `$transaction` contract
- **File:** `src/__tests__/helpers/mock-prisma.ts`
- **Problem:** Never called in any test file. The Proxy-based `$transaction` returns a new `vi.fn()` on every access, making mock configuration silently ineffective.
- **Fix:** Remove the helper entirely or fix the Proxy handler to cache functions.

### T-M5 [Major] Coverage include list omits critical files
- **File:** `vitest.config.ts` lines 16-35
- **Problem:** `account-lockout.ts`, `crypto-client.ts`, `crypto-emergency.ts`, `crypto-aad.ts`, `crypto-recovery.ts`, `proxy.ts` are not in `coverage.include`.
- **Fix:** Add missing critical files to coverage configuration.

### T-m1 [Minor] Proxy session cache test hardcodes constant
- **File:** `src/__tests__/proxy.test.ts` line 455
- **Problem:** `SESSION_CACHE_MAX = 500` hardcoded instead of imported.
- **Fix:** Import from `@/lib/validations/common.server`.

## Adjacent Findings
None — all findings were within scope boundaries.

## Resolution Status

### Round 1 Fixes Applied

#### F-C1 / F-C2 [Critical] — REJECTED (False Positive)
- **Reason:** `authHash` is derived from `secretKey` via HKDF, NOT from the passphrase. Since `secretKey` is unchanged during passphrase change and recovery, `authHash` and `masterPasswordServerHash` remain valid. Only `rotate-key` changes `secretKey` and correctly updates the server hash.

#### F-M1 [Major] Team member removal deletes SCIM mapping — FIXED
- **Action:** Removed `scimExternalMapping.deleteMany` from team-member DELETE handler
- **Modified file:** `src/app/api/teams/[teamId]/members/[memberId]/route.ts`

#### F-M2 [Major] Auto-purge orphans blob-store attachments — FIXED
- **Action:** Added blob-store cleanup before cascade delete (only for external blob backends)
- **Modified file:** `src/app/api/passwords/route.ts`

#### S-M1 [Major] Non-timing-safe auth hash comparison — FIXED
- **Action:** Replaced `!==` with `timingSafeEqual` from `node:crypto`; added null guard for nullable fields
- **Modified files:** `src/app/api/vault/unlock/route.ts`, `src/app/api/vault/rotate-key/route.ts`

#### S-M2 [Major] SSRF via DNS rebinding on webhook delivery — FIXED
- **Action:** Added `assertPublicHostname()` with DNS pre-resolution and private IP blocklist (RFC 1918, loopback, link-local, cloud metadata)
- **Modified file:** `src/lib/webhook-dispatcher.ts`

#### S-m1 [Minor] CSP nonce cookie missing Secure flag — FIXED
- **Action:** Added `secure: isHttps` to nonce cookie options
- **Modified file:** `src/proxy.ts`

#### S-m2 [Minor] assertOrigin missing on vault routes — FIXED
- **Action:** Applied `assertOrigin()` to unlock, change-passphrase, and rotate-key
- **Modified files:** `src/app/api/vault/unlock/route.ts`, `src/app/api/vault/change-passphrase/route.ts`, `src/app/api/vault/rotate-key/route.ts`

#### S-m3 [Minor] allowDangerousEmailAccountLinking unrestricted — FIXED
- **Action:** Set `allowDangerousEmailAccountLinking` to `allowedGoogleDomains.length > 0`
- **Modified file:** `src/auth.config.ts`

#### Lint warnings (3) — FIXED
- Removed dead code `mockPipeline` from `rate-limit.test.ts`
- Replaced `<img>` mock with `<span data-src>` in `member-info.test.tsx`

#### Testing findings (T-C1, T-C2, T-M1–M5) — DEFERRED
- Test coverage additions and CI config changes are separate tasks; not addressed in this security-focused review round.
