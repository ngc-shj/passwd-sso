# Plan: OAuth account-token AAD scope & decrypt-failure auditing

Date: 2026-05-01
Status: approved direction — ready for implementation branch
Triangulated by: functionality / security / testing experts

## Issues under review

### #1 — Expand AAD on OAuth account-token encryption

- File: `src/lib/crypto/account-token-crypto.ts:43-45` (`buildAad`)
- Current AAD bytes: `provider:providerAccountId`
- **Decision: expand to `userId:provider:providerAccountId`** (offline cutover migration)

### #2 — Audit event on decrypt failure in `getAccount()`

- File: `src/lib/auth/session/auth-adapter.ts:447-509`
- Current behavior: `onFieldError` → `logger.warn(...)`, field returned as `null`
- **Decision: emit audit event on `refresh_token` decrypt failure; sanitize `err.message`** (`access_token`/`id_token` policy still open — see Open questions)

---

## Triangulated synthesis

### Issue #1: AAD scope expansion — **decision: expand AAD to include `userId`**

The three experts initially diverged; the user's final call resolves to the security view, refined.

**Why expand** (essence):
- AAD's role is to bind ciphertext to its **semantic security context**, not to enforce row uniqueness (DB constraints already do that).
- The ciphertext's meaning is "*this user's* credential at *this provider*". Local identity (`userId`) IS the security context — it is currently absent from AAD, so the AAD doesn't reflect what the row means.
- Vector A (DB-write attacker pivots `accounts.user_id` to redirect a long-lived `refresh_token`) is structurally enabled by this gap. Adding `userId` to AAD turns a silent pivot into a GCM auth failure.

**Why the "operational footgun" objection is reversed**:
- A legitimate `userId` change on an OAuth account row IS a silent identity reassignment of credentials. Carrying the encrypted token across that change is **the wrong security default**, not a feature.
- Forcing the affected user to re-OAuth on identity-rebinding events (SCIM re-parent, tenant merge, user merge) is the *correct* security model. Current behavior (silent carry) is the bug.

**Why `tenantId` is NOT included**:
- `@@unique([provider, providerAccountId])` is global, so cross-tenant ciphertext substitution is structurally impossible. `tenantId` adds zero security gain; including it only inflates AAD bytes.

**Final AAD shape**:

```text
psoenc1:<v>:<base64url(iv || tag || ct)>   AAD = `<userId>:<provider>:<providerAccountId>`
```

**Threat vectors closed by this change**:
- Vector A (userId pivot): **closed** — GCM auth fails after `userId` change.
- Vector B (cross-tenant substitution): already structurally impossible.
- Vector C (backup-restore replay): partially closed when historical `userId` differs.

**Migration approach: NONE — dev phase**:
- Project is pre-production. No migration script, no `psoenc2:` sentinel, no transition window required.
- Existing dev DB rows encrypted under old AAD will fail GCM auth on next read → `onFieldError` returns `null` → user re-OAuths in dev → row is rewritten under new AAD. Acceptable.
- Lock-in comment in `account-token-crypto.ts:22-25` (`AAD bytes here MUST remain byte-for-byte identical to pre-refactor`) is now stale and will be replaced/removed as part of this change.
- When the project reaches production, a migration plan must be re-introduced before any subsequent AAD change.

---

### Issue #2: Decrypt-failure auditing — **all three agree, do it**

Severity: **Major**. The three experts converge:

| Perspective | Stance |
|---|---|
| Functionality | Per-field severity: `refresh_token` ≫ `access_token` ≈ `id_token`. `refresh_token` decrypt failure causes user-visible degradation (forced re-auth via Auth.js `RefreshAccessTokenError`). |
| Security | 4 distinct failure modes (key drift, storage corruption, AAD mismatch, ciphertext replacement) are all funneled to `logger.warn` today — security ops cannot distinguish adversarial from benign. OWASP A09 (Logging & Monitoring Failures) angle. *ASVS section reference is unverified — confirm before citing in commit.* |
| Testing | Mock infrastructure already in place (`vi.mock("@/lib/audit/audit", ...)` at line 76); minimal mock changes required. Concrete test cases enumerated. |

**Proposed change**:
1. Add `AUDIT_ACTION.OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE` to `src/lib/constants/audit/audit.ts`. Register in the appropriate group (read existing groupings at implementation time — security-anomaly / auth-failure groups are candidates).
2. **Audit dispatch by failure type, NOT by field**:
   - GCM auth tag failure (AAD/ciphertext tampering, the only adversarial signal) → audit emit (regardless of field).
   - Key version not found / envelope parse error → warn-log only (operational benign).
   - Field name (refresh_token / access_token / id_token) is included in the audit metadata, but is NOT the dispatch key. Per-field bar would generate false positives on key-drift events, which fire across all fields uniformly.
3. **Sanitize `err.message`** — replace `err instanceof Error ? err.message : String(err)` with a fixed marker (e.g., `"AEAD authentication failed"`) plus `err?.constructor?.name`, so crypto-library internals never reach the log sink. (Adjacent finding from functionality expert.)
4. **Avoid timing oracle** — emission must be async (`logAuditAsync`, not `await logAudit`), matching the pattern at `auth-adapter.ts:358` in `createSession`.
5. **Avoid nested `withBypassRls`** — `getAccount` runs inside `withBypassRls`. `logAuditAsync` internally calls `withBypassRls`; if the call is inside the wrapped block, the AsyncLocalStorage context conflicts (see comments at `auth-adapter.ts:260-263`). Capture failure info inside the block, emit audit after the block returns — mirroring the `createSession` eviction-info pattern at lines 262-266 and 350-384.

---

## Adjacent findings

| # | Finding | Status |
|---|---|---|
| A1 | `err.message` forwarded verbatim to log sink may leak crypto internals (auth-adapter.ts:488) | **Valid** — fold into Issue #2 fix (sanitize). |
| A2 | "Missing `updateAccount` adapter method means token refresh doesn't persist" | **Invalid as stated** — Auth.js v5 `@auth/core` Adapter interface does NOT define `updateAccount` (verified at `node_modules/@auth/prisma-adapter/node_modules/@auth/core/adapters.d.ts:311-371`). Token refresh in database-session strategy doesn't auto-persist; this is by design, not a bug in this code. **Implication for Issue #2**: this strengthens the case for auditing `refresh_token` decrypt failures — since the stored `refresh_token` is the only one Auth.js will ever use until the next OAuth re-link, its decryption failure is permanently terminal for that account. |

---

## Test strategy (testing expert)

### Issue #1 (only if user chooses to adopt)

Place new tests in **`src/lib/crypto/account-token-crypto.test.ts`** (new file, real AES-GCM, no mocks):

- Round-trip with expanded AAD: encrypt + decrypt with same `(userId, provider, providerAccountId)` returns plaintext.
- **Tamper `userId`**: encrypt with `userId="u-1"`, decrypt with `userId="u-2"` → must throw GCM auth failure.
- **Cross-row substitution**: encrypt for account A, decrypt as account B → throws.
- **Old AAD ciphertext + new AAD reader**: must throw distinctly (not silently produce garbage).

In `auth-adapter.test.ts:1155` (`decrypts encrypted tokens to plaintext (round-trip with linkAccount)`):
- Update the mock `findFirst` return to include the new fields used by AAD (`userId`, etc.) and verify decrypt still produces plaintext. This is the **wiring test** that catches buildAad / call-site drift.

### Issue #2 (must-have)

In `auth-adapter.test.ts` `describe("getAccount")`:

- `refresh_token` decrypt failure → `mockLogAudit` called with `expect.objectContaining({ action: AUDIT_ACTION.OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE, metadata: expect.objectContaining({ field: "refresh_token", provider, providerAccountId }) })`.
- `access_token` decrypt failure → assert exact behavior (audit or warn-only) per design choice.
- All three fields fail → assert audit call count (1 vs 3) per design choice.
- Successful decrypt → `mockLogAudit` NOT called.
- Partial failure: corrupt `refresh_token`, valid `access_token`/`id_token` → returned account has `refresh_token: undefined` AND others decrypted (regression bar).

**Sub-agent red-flag checklist** (if implementation is delegated):
1. `expect(mockLogAudit).toHaveBeenCalled()` without `toHaveBeenCalledWith` — passes vacuously.
2. Mocking `decryptAccountTokenTriple` directly instead of supplying a `psoenc1:0:zzzz...` corrupt ciphertext — tests the mock, not wiring.
3. Missing `await` on `adapter.getAccount!(...)` — Prisma mock is async; assertion may fire before callback.
4. Forgetting that `vi.clearAllMocks()` runs only once per `beforeEach` — assertions on call count must be placed after the only adapter call in the test.

---

## Resolved decisions (dev-phase, finalized)

| Topic | Decision |
|---|---|
| AAD shape | `userId:provider:providerAccountId` (no tenantId) |
| Migration | None (dev phase). Existing dev rows fail decrypt → user re-OAuths |
| Sentinel | Keep `psoenc1:`. No `psoenc2:` introduction — dual-format coexistence has no value here |
| Audit dispatch | By failure TYPE (GCM auth tag fail), not by field name |
| `access_token` / `id_token` | NOT separately audited. Same dispatch rule applies |
| `err.message` | Sanitize to fixed marker + `err.constructor.name` |
| Audit emit position | Outside `withBypassRls` block (capture inside, emit outside) |
| Audit action grouping | Defer to implementation phase (read existing groups) |
| PR cadence | Single PR after both phases land on branch |

---

## Implementation Checklist

### Files to modify

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE` to `enum AuditAction` (line 847+). Run `npm run db:migrate` to generate migration. |
| `src/lib/constants/audit/audit.ts` | Add `AUDIT_ACTION.OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE`. Register in `AUDIT_ACTION_VALUES` array AND `AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.AUTH]` group (alongside `EXTENSION_TOKEN_EXCHANGE_FAILURE`). Tenant-level visibility deferred. |
| `src/lib/crypto/account-token-crypto.ts` | (a) Update `AccountTokenAad` type to add `userId`. (b) Update `buildAad` to include userId. (c) Update lock-in comment (line 22-25) — note dev-phase context. (d) Extend `DecryptTripleOptions.onFieldError` signature OR introduce a typed error class so callers can dispatch on failure type without parsing `err.message`. |
| `src/lib/auth/session/auth-adapter.ts` | (a) `linkAccount` (line 224-231): pass `userId` in AAD. (b) `getAccount` (line 474-494): pass `userId` in AAD; capture decrypt-failure info inside `withBypassRls`; emit `logAuditAsync` outside the block; sanitize log fields. |
| `src/lib/auth/session/auth-adapter.test.ts` | Update existing round-trip test (line 1155) to include `userId` in mock `findFirst`. Add new tests for audit emission. |
| `src/lib/crypto/account-token-crypto.test.ts` | NEW FILE — real AES-GCM tamper / cross-row tests. |
| `scripts/migrate-account-tokens-to-encrypted.ts` | Update AAD construction (line 81-84) to include userId. Script is no longer functionally needed (dev phase) but must compile. Alternative: drop legacy plaintext path and the script entirely (call out in deviation log). |

### Shared utilities to reuse (no reimplementation)

- `logAuditAsync` from `@/lib/audit/audit` — fire-and-forget audit emission.
- `AUDIT_ACTION`, `AUDIT_SCOPE`, `AUDIT_TARGET_TYPE` from `@/lib/constants` — reuse existing taxonomy; add new action only.
- `withBypassRls` + `BYPASS_PURPOSE.AUTH_FLOW` — already in use; pattern for emitting audit AFTER bypass block: see `createSession` (auth-adapter.ts:262-266 capture, 350-384 emit).
- `encryptWithKey` / `decryptWithKey` / `parseEnvelope` from `@/lib/crypto/envelope` — do NOT reimplement.
- `getCurrentMasterKeyVersion` / `getMasterKeyByVersion` from `@/lib/crypto/crypto-server` — already used; AAD change is independent of key versioning.
- `logger` from `@/lib/logger` — keep using for warn-level non-adversarial failures.

### Patterns to follow consistently

- Audit emission outside `withBypassRls` (createSession pattern).
- Fire-and-forget via `logAuditAsync` (not `await logAudit`).
- Log-field sanitization: never forward `err.message` verbatim from crypto operations.
- Const-object + derived type for new enumerated actions ([feedback_const_object_for_string_literals]) — but only if multiple new constants are added; one new action joins the existing object.

### Implementation order on branch (commits)

1. `feat: emit audit event on OAuth account-token GCM auth failure` — Phase #2 (Issue #2 fix). Includes new AUDIT_ACTION, dispatch logic, sanitization, test cases. **Issue #1 changes NOT in this commit.**
2. `feat: bind userId to AAD on OAuth account-token at-rest encryption` — Phase #1 (Issue #1 fix). Type change, call-site updates, new unit test file, adapter round-trip mock update.

(Splitting commits by phase aids review and bisect; both ship in the same PR.)

### Mandatory pre-PR

- `npx vitest run`
- `npx next build`
- `scripts/pre-pr.sh` per [feedback_run_pre_pr_before_push]
