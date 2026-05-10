# Code Review: rebalance-personal-passkey-session-aal2
Date: 2026-05-10T00:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings

### F2 [Critical] TypeScript build error: `RequireRecentSessionOptions` not exported
- File: `src/lib/auth/session/step-up.ts:11`
- Evidence: `tsc --noEmit` reports `error TS2724: '"@/lib/auth/session/step-up"' has no exported member named 'RequireRecentSessionOptions'`. Line 11 declares `type RequireRecentSessionOptions = {...}` (no `export`); `src/lib/auth/session/recent-current-auth-method.ts:8` imports it as `type RequireRecentSessionOptions`.
- Problem: The type alias is declared without `export`. The new `recent-current-auth-method.ts` consumer cannot resolve the type; production build (`npx next build`) will fail.
- Impact: Blocks deployment. The stale-session gate for operator token issuance is in a module that does not compile cleanly.
- Fix: Add `export` to line 11 of `step-up.ts`.

### F1 [Major] C1 invariant: global AAL3 clamp removal — bootstrap scope not made explicit
- File: `src/lib/auth/session/session-timeout.ts` (entire `applyAal3Clamp` removal); `src/lib/auth/session/auth-adapter.ts:579-580`
- Evidence: The diff removes `applyAal3Clamp` and accepts the `_sessionProvider` parameter unused. The plan-required helper `resolveSessionAssuranceContext` was never implemented (grep returned no results).
- Problem: C1 acceptance criteria says "the implementation makes the bootstrap-only scope explicit rather than inferring it from `provider` alone." Current implementation does neither — it removes the inference without adding any explicit bootstrap check. Deviation D1 acknowledges this widens scope.
- Impact: Mechanically safe today (passkey/verify route already enforces the bootstrap-tenant guard, so only bootstrap users produce `provider="webauthn"` sessions). Architectural risk: timeout resolver no longer carries tenant-type awareness; future non-bootstrap passkey flows would need to revisit this module.
- Fix: Either (a) implement `resolveSessionAssuranceContext` to re-introduce an explicit bootstrap check, or (b) add a comment in `session-timeout.ts` documenting that the safety invariant lives in `passkey/verify/route.ts` (the bootstrap guard), or (c) accept D1 as final and remove the now-dead `_sessionProvider` parameter from the resolver signature and all callers.

### F3 [Major] `passkeyVerifiedAt` initialization is split across sign-in route and auth-adapter
- File: `src/app/api/auth/passkey/verify/route.ts:99-102` vs `src/lib/auth/session/auth-adapter.ts:309-330`
- Evidence: `passkey/verify/route.ts` constructs the session row directly via `prisma.$transaction` and explicitly sets `passkeyVerifiedAt: verifiedAt`. The adapter's `createSession` does not initialize `passkeyVerifiedAt`. Two write sites for the same field.
- Problem: C2 invariant ("freshness is tied to the current session row") is satisfied by current behavior, but ownership is split. A future refactor consolidating passkey sign-in to use the adapter would silently break freshness initialization.
- Impact: Maintainability concern, no current bug.
- Fix: Add a comment in `passkey/verify/route.ts` documenting why initialization happens here rather than in the adapter; or extend `sessionMetaStorage` to carry `passkeyVerifiedAt` and initialize it in the adapter when provider is `"webauthn"`.

### F4 [Major] R12: reauth success uses `AUTH_LOGIN` audit action — no dedicated step-up action
- File: `src/app/api/auth/passkey/reauth/verify/route.ts:97-104`
- Evidence: The reauth verify route emits `AUDIT_ACTION.AUTH_LOGIN` with `metadata.trigger = "passkey_reauth"`. `AUDIT_ACTION_GROUPS_PERSONAL[AUTH]` does not include a dedicated reauth action.
- Problem: SIEM / audit consumers filtering by action code cannot distinguish a full sign-in from an in-session step-up reauth. Login-frequency anomaly detection will see false positives. Conversely, monitors looking for "no reauth events" miss step-ups.
- Impact: Audit traceability gap; compliance regression vs the intent of the C3 contract ("audit logs appropriate for a security-sensitive reauthentication event").
- Fix: Add `AUDIT_ACTION.AUTH_PASSKEY_REAUTH` (or `WEBAUTHN_STEP_UP`) to the Prisma enum and the `AUDIT_ACTION` constant object, register it in `AUDIT_ACTION_GROUPS_PERSONAL[WEBAUTHN]` (or the auth group), add the i18n label, and use it in the reauth verify route. Requires a Prisma migration.

### F5 [Minor] Dead constants `AAL3_IDLE/ABSOLUTE_TIMEOUT_MAX_MINUTES` with stale comment
- File: `src/lib/validations/common.ts:170-173`
- Evidence: Grep confirms no non-test source file imports the constants. Comment claims they are applied when `session.provider === "webauthn"` — that pattern was removed.
- Fix: Remove the constants and the stale NIST comment, or update the comment to reflect their reference-only status.

### F6 [Minor] `provider === "webauthn"` invariant not documented at usage site
- File: `src/lib/auth/session/recent-current-auth-method.ts:41`
- Evidence: Line 41 routes `provider === "webauthn"` to passkey verification without documenting the bootstrap-tenant invariant that makes this safe.
- Fix: Add a comment naming the upstream guard (`passkey/verify/route.ts` rejects non-bootstrap users).

### F7 [Minor] Stale comment in common.ts (overlaps F5/S3)
- File: `src/lib/validations/common.ts:171`
- Resolved together with F5.

## Security Findings

### S1 [Major] D1 global AAL3 clamp removal exceeds plan scope (overlaps F1)
- File: `src/lib/auth/session/session-timeout.ts`
- Evidence: D1 deviation log explicitly records the global removal. Tenant-admin passkey sessions previously clamped to 15 min/12 h now inherit tenant policy (up to 24 h idle / 30 d absolute).
- Compensating controls verified:
  - `requireRecentCurrentAuthMethod` on `operator-tokens` POST gates admin token creation.
  - `requireRecentSession` on `mcp-clients`, `scim-tokens`, `access-requests/approve`, `service-accounts/tokens` checks `session.createdAt` within 15 minutes.
  - Passkey sign-in is restricted to bootstrap-tenant users (SSO tenants rejected).
- Residual risk: Passkey-established sessions can remain valid for non-gated dashboard operations (vault read, entry list, extension use without bridge-code creation) for up to 24 h idle / 30 d absolute. Unattended authenticated browser session has a longer exposure window than the previous 15-min idle ceiling.
- escalate: false
- escalate_reason: Risk acknowledged in deviation log with accepted compensating controls. Design trade-off, not implementation error. Escalation not warranted unless threat model treats extended passkey dashboard sessions as unacceptable.
- Fix: Either restore an admin-role-based clamp for non-bootstrap admin passkey sessions, OR document the residual risk explicitly in `session-timeout-design.md` and confirm with the user that bootstrap-only personal scope is acceptable.

### S2 [Minor] AUTH_LOGIN reused for step-up events (overlaps F4)
- See F4.

### S3 [Minor] Stale NIST citation in common.ts (overlaps F5/F7)
- See F5. Note: The cited "NIST SP 800-63B-4 §2.3.3" was not independently verified; should be removed alongside the dead constants.

## Testing Findings

### T9 [Critical] R35 manual test plan absent
- Expected path: `docs/archive/review/rebalance-personal-passkey-session-aal2-manual-test.md`
- Evidence: File does not exist.
- Problem: This change involves auth flow changes (Tier-2): new Prisma migration touching session rows, new WebAuthn reauth ceremony (two new API routes + new client passkey flow), modified session timeout policy for existing passkey users, new UI dialogs across 6 components.
- Fix: Create a manual test plan with sections — Pre-conditions, Steps, Expected result, Rollback, Adversarial scenarios (Tier-2). Apply the two-filter rule: exclude items already covered by automated tests, include browser WebAuthn ceremony, freshness gate end-to-end, fresh-install migration ordering, and adversarial scenarios (replay, cross-user binding, redirect-style step-up UX).

### T2 [Major] "Reauth succeeds, server returns second stale" untested
- File: `src/components/settings/developer/operator-token-card.tsx:200-205`; `operator-token-card.test.tsx`
- Evidence: Production code branches on `errBody.error === API_ERROR.OPERATOR_TOKEN_STALE_SESSION` after a successful `reauthenticateWithPasskey()` and shows `t("reauthStillRequired")`. No test covers this path.
- Fix: Add a test simulating successful reauth followed by a second stale-session response; assert the "reauth still required" message appears.

### T3 [Major] `RecentSessionRequiredDialog` trigger branch never tested across 5 consumers
- Files: `api-key-manager.test.tsx`, `service-account-card.test.tsx`, `team-scim-token-manager.test.tsx`, `access-request-card.test.tsx`, `mcp-client-card.test.tsx`
- Evidence: All 5 files register the `RecentSessionRequiredDialog` mock with `data-testid="recent-session-dialog"` but no test triggers a `SESSION_STEP_UP_REQUIRED` response that would render `open=true`.
- Fix: Add a test per file that mocks `fetchApi` to return `SESSION_STEP_UP_REQUIRED` and asserts the dialog appears.

### T1 [Major] `provider: null` branch untested in `recent-current-auth-method.test.ts`
- File: `src/lib/auth/session/recent-current-auth-method.test.ts`
- Evidence: `Session.provider` is `String?` (nullable). Tests cover `"webauthn"` and `"google"` but not `null` (sessions created before the provenance migration).
- Fix: Add a test mocking `mockSessionFindUnique.mockResolvedValue({ provider: null })` and asserting the function falls back to `requireRecentSession`.

### T4 [Minor] Reauth route guard paths untested
- Files: `src/app/api/auth/passkey/reauth/options/route.test.ts`, `src/app/api/auth/passkey/reauth/verify/route.test.ts`
- Evidence: Unauthenticated path (`!session?.user?.id`), rate-limited path, and missing-session-token path on verify are not exercised.
- Fix: Add guard tests.

### T5 [Minor] Stale "AAL3 ceilings" test description
- File: `src/lib/auth/session/session-timeout.test.ts:102`
- Evidence: `it("does not clamp bootstrap passkey sessions to AAL3 ceilings", ...)` retains AAL3 terminology after the clamp removal.
- Fix: Rename to e.g. `"applies standard tenant policy for webauthn sessions (no clamping)"`.

### T6 [Minor] `canPasskeySignIn: false` path untested (operator-token-card)
- File: `src/components/settings/developer/operator-token-card.test.tsx`
- Evidence: All stale-session tests set `canPasskeySignIn: true`. The `RecentSessionRequiredDialog` branch (no passkeys → falls through to sign-in dialog) is never exercised.
- Fix: Add a test with `canPasskeySignIn: false` asserting the dialog appears.

### T7 [Minor] `withBypassRls` mock signature drift (RT1)
- Files: 5 new test files
- Evidence: Real signature is `withBypassRls<T>(prisma, fn, purpose: BypassPurpose)` (3 args); mocks use 2-arg `(_prisma, fn) => fn()`.
- Pre-existing pattern in older tests; not new regression but inherited into new files.
- Fix: Optional — extend mock to 3-arg form for new files.

### T10 [Minor] `sessionRow === null` (DB miss) distinct from no-cookie path, untested
- File: `src/lib/auth/session/recent-current-auth-method.test.ts`
- Evidence: Existing 401 test exercises no-cookie path (`getSessionToken` early exit), not the `if (!sessionRow)` branch with valid cookie + DB miss.
- Fix: Add `mockSessionFindUnique.mockResolvedValue(null)` test with valid cookie request.

## Adjacent Findings
None.

## Quality Warnings
- S1 originally cited "NIST SP 800-63B-4 §2.3.3" — citation not independently verified; reframed to scope-of-change rather than spec compliance.

## Pre-existing-in-changed-file (R-rule scope)

### P1 [Pre-existing] `verify/route.test.ts:268` TS2769 overload error
- File: `src/app/api/auth/passkey/verify/route.test.ts:268`
- Evidence: Same shape error exists on main at line 256 (file shorter on main). Predates this branch.
- Per Pre-existing-in-changed-file rule, this is in scope because the file appears in the diff.
- Fix recommended: Type the destructure as `(args: unknown[]) => (args[0] as { action: string }).action === "SESSION_REVOKE_ALL"` or attach a typed mock signature to `mockLogAudit` at hoist time.
- Anti-Deferral note: User decision required — fixing pre-existing test types may pull in scope unrelated to this PR.

## Recurring Issue Check

### Functionality expert
- R3 (passkeyVerifiedAt propagation): Checked — 2 write sites, 1 read site, complete
- R4 (audit dispatch gap): Finding F4
- R7 (E2E phantom-match): Checked — no new aria-* attributes that risk phantom matches
- R10 (circular imports): Checked — no cycle introduced
- R12 (enum/action coverage): Finding F4
- R29 (citation accuracy): Stale NIST reference flagged in F5/S3
- R37 (i18n internal jargon): Checked — clean

### Security expert
- R3: PASS
- R5/R9 transactions: PASS — verify+update in single tx, audit outside (outbox)
- R12: Finding F4/S2
- R14/R16 RLS bypass: PASS — `check-bypass-rls.mjs` updated correctly
- R24 migration additive: PASS — nullable column, no default
- R25 persist/hydrate: PASS
- R29: Flagged (stale citation in common.ts)
- R31: PASS — no destructive ops
- R34: Not found
- RS1 timing-safe: PASS
- RS2 rate limiter: PASS — both reauth endpoints rate-limited per userId
- RS3 input validation: PASS — Zod at boundary
- RS4 PII in artifacts: PASS

### Testing expert
- R1 prod→test pairing: PASS
- R7 E2E phantom-match: PASS
- R19 mock alignment: PASS (T7 minor drift in pre-existing pattern)
- R35 manual test plan: Finding T9 — FAIL (artifact missing)
- RT1 mock-reality: Minor (T7)
- RT2 testability: PASS
- RT3 named constants: PASS
- RT4 race-test guard: N/A (no concurrency tests in this diff)
- RT5 call path: PASS

## Resolution Status

### F2 [Critical] `RequireRecentSessionOptions` not exported — Fixed
- Action: Added `export` to type alias.
- Modified file: `src/lib/auth/session/step-up.ts:11`

### T9 [Critical] R35 manual test plan absent — Fixed
- Action: Created Tier-2 manual test plan with 7 scenarios (clamp removal, inline reauth + retry, replay rejection, cross-user binding rejection, pre-migration session fallback, non-bootstrap regression, fresh-install migration).
- Modified file: `docs/archive/review/rebalance-personal-passkey-session-aal2-manual-test.md` (new)

### F1 / S1 [Major] D1 deviation invariant not documented — Fixed
- Action: Added invariant block to `resolveEffectiveSessionTimeouts` doc-comment naming the upstream bootstrap guard and the recent-passkey-verification step-up path. Kept `_sessionProvider` parameter for forward compatibility.
- Modified file: `src/lib/auth/session/session-timeout.ts:30-50`

### F3 [Major] `passkeyVerifiedAt` initialization split-ownership — Fixed
- Action: Added inline comment in passkey/verify route documenting why initialization lives here (not in adapter), the C2 invariant for updateSession, and the dedicated reauth path for refresh.
- Modified file: `src/app/api/auth/passkey/verify/route.ts:120-133`

### F4 / S2 [Major] Reauth audit action reused `AUTH_LOGIN` — Fixed
- Action: Added `AUTH_PASSKEY_REAUTH` enum value to Prisma schema + new migration; registered in `AUDIT_ACTION` const + `AUDIT_ACTION_VALUES` + `AUDIT_ACTION_GROUPS_PERSONAL[AUTH]`; added i18n labels (en/ja); switched reauth verify route to emit the new action.
- Modified files: `prisma/schema.prisma:856`, `prisma/migrations/20260510145100_add_audit_action_passkey_reauth/migration.sql` (new), `src/lib/constants/audit/audit.ts:20,200,392`, `messages/en/AuditLog.json:21`, `messages/ja/AuditLog.json:21`, `src/app/api/auth/passkey/reauth/verify/route.ts:99`

### F5 / F7 / S3 [Minor] Dead constants and stale NIST citation — Fixed
- Action: Removed `AAL3_IDLE_TIMEOUT_MAX_MINUTES` / `AAL3_ABSOLUTE_TIMEOUT_MAX_MINUTES` and the stale §2.3.3 comment.
- Modified file: `src/lib/validations/common.ts:170-173` (removed)

### F6 [Minor] `provider === "webauthn"` invariant not documented at usage — Fixed
- Action: Added bootstrap-tenant invariant block to `requireRecentCurrentAuthMethod` doc-comment naming the upstream guard.
- Modified file: `src/lib/auth/session/recent-current-auth-method.ts:12-24`

### T1 [Major] `provider: null` branch untested — Fixed
- Action: Added two tests — DB-miss-with-valid-cookie path and `provider: null` (pre-provenance-migration) fallback.
- Modified file: `src/lib/auth/session/recent-current-auth-method.test.ts:80-103`

### T2 [Major] "Reauth succeeds, server returns second stale" untested — Fixed
- Action: Added test covering successful reauth followed by a second stale-session response, asserting `reauthStillRequired` message.
- Modified file: `src/components/settings/developer/operator-token-card.test.tsx:359-401`

### T3 [Major] `RecentSessionRequiredDialog` trigger branch untested in 5 components — Fixed
- Action: Updated 5 tests previously asserting `toast.error("sessionStepUpRequired")` (the old main behavior) to instead assert `getByTestId("recent-session-dialog")` and that no toast fires.
- Modified files: `src/components/settings/developer/api-key-manager.test.tsx`, `service-account-card.test.tsx`, `mcp-client-card.test.tsx`, `access-request-card.test.tsx`, `src/components/team/security/team-scim-token-manager.test.tsx`

### T4 [Minor] Reauth route guard paths untested — Fixed
- Action: Added unauthenticated, missing-session-cookie, and rate-limited tests for reauth options + verify.
- Modified files: `src/app/api/auth/passkey/reauth/options/route.test.ts:117-151`, `src/app/api/auth/passkey/reauth/verify/route.test.ts:166-227`

### T5 [Minor] Stale "AAL3 ceilings" test description — Fixed
- Action: Renamed to `"returns tenant policy for webauthn sessions (no AAL3-style clamp post D1)"`.
- Modified file: `src/lib/auth/session/session-timeout.test.ts:102`

### T6 [Minor] `canPasskeySignIn: false` branch untested — Fixed
- Action: Added test asserting `RecentSessionRequiredDialog` opens (NOT passkey reauth dialog) when stale-session occurs and the user has no passkey.
- Modified file: `src/components/settings/developer/operator-token-card.test.tsx:359-388`

### T7 [Minor] `withBypassRls` 2-arg → 3-arg signature alignment (RT1) — Fixed
- Action: Updated all 5 new test files to use the real 3-arg signature `(_prisma, fn, _purpose) => fn()`.
- Modified files: `src/lib/auth/session/step-up.test.ts:37`, `recent-current-auth-method.test.ts:50`, `src/lib/auth/webauthn/recent-passkey-verification.test.ts:44,97`, `src/app/api/auth/passkey/reauth/options/route.test.ts:78`, `src/app/api/auth/passkey/reauth/verify/route.test.ts:85`

### T10 [Minor] DB-miss-with-valid-cookie path distinct from no-cookie — Fixed
- Action: Covered by the same edit as T1 (added explicit test case).
- Modified file: `src/lib/auth/session/recent-current-auth-method.test.ts:85-93`

### P1 [Pre-existing] verify/route.test.ts:268 TS2769 overload error — Fixed
- Action: Replaced the broken `[arg]: [{ action: string }]` destructure tuple type with `(args: unknown[]) => (args[0] as { action: string }).action`.
- Modified file: `src/app/api/auth/passkey/verify/route.test.ts:267-269`

### Auxiliary fix: API_ERROR count test
- Action: Updated the structural-invariants test from 146 → 147 to account for `SA_INVALID_SCOPE` introduced earlier in this branch.
- Modified file: `src/lib/http/api-error-codes.test.ts:121`

## Verification
- `bash scripts/pre-pr.sh`: 15/15 passed (lint, tsc, vitest, next build, all `check:*` gates).
- Affected test counts: 63 unit tests + 76 component tests pass against the post-merge state.

