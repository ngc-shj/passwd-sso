# Plan Review: passkey-signin-client-token-cascade
Date: 2026-09-29
Review round: 1

## Changes from Previous Round
Initial review. Local-LLM pre-screen: (1) the constant keeps its file location, because `constants/auth/extension-token.ts` already hosts the iOS constants and a file rename would only churn imports (skipped); (2) the new `issueAutofillToken` lock is now marked NEW (applied).

## Functionality Findings
- **F-func-1 [Major, DESIGN, R29/R57]** — C3 presence aggregation over the filtered row set is not the `getFamilyPresenceAt` rule. For an iOS family, the presence write sits on the 24 h access row. Once that row expires while the refresh row lives on, a filtered `MAX(lastPresenceAt)` falls back to `familyCreatedAt`, and the cap can evict a recently used device. **Resolved**: membership comes from active rows, and presence comes from the unfiltered `getFamilyPresenceAt`. Tie-break is `familyId`.
- **F-func-2 [Minor, PROSE, R29]** — The C1 forbidden regex did not match the real code, because of the trailing comma. **Resolved**: the regex was corrected and checked with `grep -Pzo` against the current `route.ts` (it matches).
- **F-func-3 [Minor, DESIGN, R40]** — `RevokedFamily` lacked `rowsRevoked`, so the audit payload would diverge from `revokeExtensionTokenFamily`. **Resolved**: `rowsRevoked` added, with one `updateMany` per family.

## Security Findings
No findings. The reviewer re-derived every member set (`session.create`, `invalidateUserSessions`, `extensionToken.create`, `PASSKEY_REAUTH`), read all six explicit recovery routes, and confirmed that `userId` and `cnfJkt` are server-derived and proven by DPoP at both exchange routes (the supersede cannot cross principals). AutoFill stays bounded by auth, rate limit and revoke-priors. The note to the user: "sign out everywhere" is not one-click for API / MCP / delegation / operator tokens. That is pre-existing and not a plan defect.

## Testing Findings
- **F-test-1 [Major, DESIGN, RT5]** — The C1 session cap had no real-DB race test. **Resolved**: `session-concurrency-cap.integration.test.ts` added, with a contention lower bound and a lock-disabled red proof.
- **F-test-2 [Major, DESIGN, RT4]** — The C3 concurrency test asserted only an upper bound. **Resolved**: it now asserts more than 3 families created and at least one `active_family_cap` revocation before the ≤ 3 check.
- **F-test-3 [Major, PROSE]** — The C2 integration test was underspecified. **Resolved**: the mock boundary (from `verify-authentication-assertion.test.ts`), the fixtures, and the precedent gap are named, with a deviation-log requirement if it is descoped.
- **F-test-4 [Major, R19]** — Three route tests hard-code `EXTENSION_TOKEN_REVOKE_REASON`. **Resolved**: all three are listed (this also covers the functionality expert's Adjacent note).
- **F-test-5 [Minor, RT3]** — Cap fixtures hard-code 3. **Resolved**: they derive from the constant.

## Adjacent Findings
- Functionality → Testing: stale `PASSKEY_REAUTH` mock literals. Merged into F-test-4.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R3, R4, R5, R9, R12, R17, R22, R25, R30, R31, R34, R35, R42, R48, R49, R50, R52 and R54: checked-ok. R19: Adjacent (F-test-4). R29: F-func-1, F-func-2. R40: F-func-3. R43: security scope. R57: folded into F-func-1. All other rules through R57: N/A.

### Security expert
R3, R4, R5, R9, R12, R29, R34, R36, R38, R42, R43 (audit coverage widens), R48, R49 and R50: checked. R53: N/A (value unchanged, unit re-scoped). All other rules through R57: N/A. RS2: checked (all issuance routes are rate limited). RS5: checked (`cnfJkt` is server-derived). RS1, RS3, RS4 and RS6: N/A.

### Testing expert
R17, R22, R29, R42 and R48: checked. R19: F-test-4. R7: N/A. All other rules through R57: N/A or out of scope. RT1, RT2, RT6, RT7, RT8, RT9, RT10 and RT11: checked. RT3: F-test-5. RT4: F-test-2. RT5: F-test-1.

---

# Round 2
Date: 2026-09-29

## Changes from Previous Round
Applied the Round-1 resolutions: C3 presence ordering via unfiltered `getFamilyPresenceAt` plus a `familyId` tie-break; `rowsRevoked`; corrected C1 regex; expanded Testing strategy.

## Functionality Findings
- **F-func-4 [Minor, PROSE, R40]** — The zero-row supersede case was unspecified, so a first connect could emit `rowsRevoked: 0`. **Resolved**: Step 1 finds candidate families first and drops any family whose count is 0.
- Verified sound: `getFamilyPresenceAt(tx: Prisma.TransactionClient, …)` is callable inside the issuance tx; the N+1 is bounded to ≤ 4; the `session.create`, `extensionToken.create`, `PASSKEY_REAUTH` and `EXTENSION_TOKEN_MAX_ACTIVE` member sets were re-derived; R57 has a total order; R52 is a subset population.

## Security Findings
No findings. `lastPresenceAt` is written only by `/api/vault/unlock/verify`, on the presenting row, and needs the DPoP key and the vault authHash, so a user cannot steer eviction onto another device. `familyId` is a server `randomUUID()`. The `@simplewebauthn` mock is test-only. Cross-tenant supersede is ruled out because `resolveUserTenantIdFromClient` rejects multi-active membership.

## Testing Findings
- **F2-test-1 [Major, DESIGN, RT2/RT4]** — The C1 lower bound was unobservable, because eviction hard-deletes rows. **Resolved**: the test counts evictions by the absence of digests it chose itself.
- **F2-test-2 [Major, DESIGN, RT2/RT4]** — The C3 reason is only in `audit_outbox` while the workers are stopped. **Resolved**: the test counts distinct `family_id` values including revoked rows, and reads the reason from `audit_outbox.payload`.
- **F2-test-3 [Major, DESIGN, RT2]** — The F-func-1 ordering fix had no pin. **Resolved**: cases added for an iOS family with an expired access row and a live refresh row, and for the tie-break.
- **F2-test-4 [Major, DESIGN, RT4]** — The AutoFill lock had no concurrency test. **Resolved**: N concurrent mints leave exactly one active row, and the lock-disabled variant fails.

## Recurring Issue Check
### Functionality expert
R3, R4, R5, R9, R12, R17, R22, R29, R31, R34, R36, R38, R42, R43, R48, R49, R50, R52 and R57: checked-ok. R40: F-func-4. All others: N/A.
### Security expert
R19, R29, R40, R42, R43 and R57: re-verified. RS5: re-verified. All others: Round-1 dispositions stand.
### Testing expert
R3, R4, R5, R9, R12, R17, R19, R22, R25, R29, R34, R42, R48, R49, R50 and R52: checked-ok. R40: adjacent (F2-test-1). R57: F2-test-3. RT1, RT3, RT5–RT11: checked. RT2: F2-test-1, F2-test-2. RT4: F2-test-1, F2-test-2, F2-test-4.

## Saturation call
Not saturated. Round 2 produced DESIGN-labelled Major findings (test-adequacy of acceptance criteria), so condition 3 fails. Round 3 follows.

---

# Round 3
Date: 2026-09-29

## Changes from Previous Round
F-func-4 applied (supersede omits zero-count families). F2-test-1..4 applied (observable lower bounds, ordering pins, AutoFill concurrency).

## Functionality Findings
No findings within scope.
- **F3-adj-1 [Major, DESIGN, R57, Adjacent]** — Pre-existing: Web-session eviction orders by `id asc`, but `Session.id` is `uuid(4)`, so "evict the oldest" is arbitrary. C1 extracts this code, and C2 routes passkey sign-ins through it. Verified in `prisma/schema.prisma` (Session `@default(uuid(4))`) and `auth-adapter.ts` (`orderBy: { id: "asc" }`). **Resolved in scope** (memory: a defect found mid-task is in scope): C1 orders by `createdAt asc, id asc`, and an ordering regression test was added.

## Security Findings
No findings. The find-then-revoke split runs under the per-user advisory lock. A cross-actor race that makes this path's `updateMany` hit 0 rows is audited by the actor that actually flipped the rows. `PROBE_NO_LOCK` does not exist in `src`.

## Testing Findings
- **F3-test-1 [Major, DESIGN, RT4]** — The sibling token integration tests mock `@/lib/audit/audit`. Copying that mock would keep `logAuditAsync` from writing to the outbox. **Resolved**: the C3 file must not mock `@/lib/audit/audit`.

## Recurring Issue Check
### Functionality expert
R29, R40, R48, R52 and R57: re-verified. R57: F3-adj-1. Others: Round-2 dispositions stand.
### Security expert
R29, R40, R43 and R57: re-verified. RS2 and RS5: stand. Others: Round-2 dispositions stand.
### Testing expert
RT4: F3-test-1. R19: adjacent (the audit-mock convention). Others: Round-2 dispositions stand.

## Saturation call
Not saturated. F3-adj-1 changes the C1 design (eviction order), so Round 4 follows.

---

# Round 4
Date: 2026-09-29

## Changes from Previous Round
C1 eviction order is now `createdAt asc, id asc` (F3-adj-1), with an ordering regression test. The C3 file must not mock `@/lib/audit/audit` (F3-test-1).

## Functionality Findings
No findings. Verified:
- `auth-adapter.ts` was the only bare `orderBy: { id: "asc" }` in `src`. Every other site already uses `[{ createdAt: "asc" }, { id: "asc" }]`.
- `maxConcurrentSessions` is bounded to 1..100 (`validations/common.ts`), so the sort cost does not change.

## Security Findings
No findings. `createdAt` is DB-default only, and no creator accepts it from the caller.

## Testing Findings
No findings. Verified:
- The superuser client can seed `Session` rows with explicit `id` and `createdAt`.
- Unmocked `logAuditAsync` reaches the outbox with no Redis dependency: `tenantId` is passed explicitly, and `audit-logger.ts` builds its own pino instances rather than importing `@/lib/logger`.
- The emit is post-commit, so `refuseIfInsideRlsContext` does not fire.

## Recurring Issue Check
R57 and RT2/RT4/RT5: re-verified and resolved. All other dispositions: Round 3 stands.

## Exit
All three experts returned "No findings" in Round 4. Every contract is `locked`. No Carried-Forward Plan Findings.
