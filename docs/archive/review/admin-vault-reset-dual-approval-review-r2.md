# Plan Review: admin-vault-reset-dual-approval (Round 2)
Date: 2026-04-30T08:00:00+09:00
Review round: 2

## Changes from Previous Round
Round-1 findings F1, F2, F3+S2, F4+F9, F5+T3, F6, F7+S4, F10, F11, F12, F13, F14, F15, F17, T1, T2, T4, T5, T6, T7, T10, T11, T12, S5, S6, S7, S9 resolved via plan rewrite. F8/F16 documented as accepted-deferred with anti-deferral format. S1 fix introduced regression S10 (Critical, escalate=true) — AAD format change would break decryption of all existing OAuth ciphertexts; resolved in this round by reverting S1 fix and using per-caller AAD-shape distinction instead.

## Functionality Findings

### F18 Minor — RESOLVED in this round
- Fix applied: `invalidateUserSessions` now uses a discriminated union `{ tenantId } | { allTenants: true }` for compile-time mutual exclusivity.

### F19 Minor — RESOLVED
- Fix applied: FR5 now requires JSDoc on `EXECUTE_TTL_MS` citing S3 mitigation rationale.

### F20 Major — RESOLVED
- Same fix as F18 — discriminated union enforces `{ tenantId, allTenants: true }` is uncompilable.

### F21+S11 Major — RESOLVED via NFR3 redesign
- Fix applied: backfill rule changed from "auto-approve in-flight rows" to "auto-revoke in-flight rows" (option c). NO operator-script step required. Migration is correct-by-construction. The `scripts/drain-pending-vault-resets.sh` reference (which was a phantom citation per S11) is removed.

### F22 Minor — Documented as accepted with Anti-Deferral
- Existing `statusPending` i18n key kept in `TenantAdmin.json` with TODO marker for next-release cleanup. **Anti-Deferral**: Worst case = stale unused string. Likelihood = high. Cost-to-fix = 5 min in next minor release. Acceptable.

### F23 Minor — RESOLVED
- Fix applied: step 4.5 now keeps `expiresAt` in initiate audit metadata; only redundant `pendingApproval: true` flag is dropped.

## Security Findings

### S10 Critical (escalate: true) — RESOLVED via S1 redesign
- escalate: true (orchestrator independently confirms severity — undetectable in unit tests, first symptom is production OAuth refresh failure).
- escalate_reason: undetectable in unit tests; first symptom is production OAuth refresh failure for every existing tenant.
- Fix applied: §"Crypto helper architecture" rewritten. The domain-prefix + NUL approach is dropped. Cross-subsystem substitution defense is achieved via per-caller AAD-shape distinction (account-token = `${provider}:${providerAccountId}`, admin-reset = `${tenantId}:${resetId}:${targetEmailAtInitiate}`), with each caller building its own AAD. Account-token AAD bytes remain byte-for-byte identical to legacy production. Mandatory legacy-fixture regression test added (test 11.1 `account-token-crypto.test.ts` legacy fixture).

### S11 Major — RESOLVED
- Same as F21.

### S12 Major — RESOLVED
- Fix applied: FR5 + step 5.8 CAS data clause now use `expiresAt = min(createdAt + 24h, now + EXECUTE_TTL_MS)` capping total lifetime at 24h.

### S13 Minor — RESOLVED (documentation fix)
- Fix applied: §"Crypto helper architecture" point 4 now states "AAD bytes are opaque (never re-parsed)" with explicit RFC 5322 §3.4.1 note. The "delimiter-safe" claim is dropped.

### S14 Minor — RESOLVED
- Fix applied: step 7 now returns generic `RESET_NOT_APPROVABLE` 409 to user-facing channel; distinct `RESET_TOKEN_DECRYPT_FAILED` cause is logged server-side and recorded in audit metadata only.

## Testing Findings

### N1 Major — RESOLVED
- Fix applied: response-shape schema block now includes `targetEmailAtInitiate: string`.

### N2 Major — RESOLVED
- Fix applied: step 11.1 now requires `tenant-reset-history-dialog.test.tsx` covering all 5 statuses × 2 actor relationships, with R26 disabled-cue assertion.

### N3 Major — RESOLVED
- Fix applied: step 11.2 self-approval CAS test now MUST bypass app-level pre-check (call CAS directly OR mock `auth()` to expose the CAS guard), preventing false-pass on the route's app-level 403.

### N4 Minor — Documented (precedent reference correction)
- Plan now mentions `pepper-dual-version.integration.test.ts` as the CAS-race precedent. Implementation will verify the existing test's exact pattern (advisory lock vs `SKIP LOCKED`) at impl time. **Anti-Deferral**: Worst case = test references wrong precedent. Likelihood = low (impl-time grep will catch). Cost-to-fix = 0 if pattern matches, 1-2h if a new advisory-lock helper is needed. Acceptable.

### N5 Minor — RESOLVED
- Fix applied: step 2.5 now states "~23 occurrences" (corrected from round-1's 17) with a `git grep` post-refactor verification step.

### N6 Minor — RESOLVED
- Fix applied: step 11.1 confirms `notification-messages.test.ts` exists at `src/lib/notification/notification-messages.test.ts` and the action is "extend the existing exhaustive-coverage assertion" (not "verify or create").

### N7 Minor — RESOLVED
- Fix applied: step 11.1 adds an "Approve route AAD-binding test" that exercises the AAD path (decryption fails when `targetEmailAtInitiate` is mutated post-initiate), confirming FR12's AAD binding is load-bearing rather than only the email-snapshot pre-check.

## Adjacent Findings (continuing from round 1)

- F8: removed (no longer applicable — backfill no longer creates synthetic-approval rows).
- F16: continued accepted with TODO marker.

## Quality Warnings
None new.

## Recurring Issue Check

### Functionality expert
- R1-R35: see round-1 review; all status updates moved into ROUND-2 disposition above.

### Security expert
- R3 (pattern propagation): S13 RESOLVED.
- R17 (existing utility reuse): S10 RESOLVED (no AAD migration of existing ciphertexts needed).
- R22 (perspective inversion): S10 RESOLVED (no AAD reformat for existing consumers).
- R24 (additive nullable + backfill): S11 RESOLVED (backfill no longer auto-approves).
- R29 (external standard citation): plan still flags NIST as unverified; phantom `scripts/drain-pending-vault-resets.sh` citation is now removed (S11 fix).

### Testing expert
- RT1, RT2, RT3: see round-1 review; updates per-finding above.
