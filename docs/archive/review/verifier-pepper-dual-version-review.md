# Plan Review: verifier-pepper-dual-version

Date: 2026-04-29
Review round: 4

## Changes from Previous Round

Round 3 raised 9 findings (Major 5 / Minor 4); all addressed. Round 4 verifies fixes and surfaces 9 new findings (Major 5 / Minor 4) — primarily around:
- Audit scope mismatch for `VERIFIER_PEPPER_MISSING` (F15/S18)
- Mock factory updates not explicit in test instructions (T19, T22)
- Conversion blanket-rule produces wrong reason (T21)
- Missing test for `handleVerify` MISSING_PEPPER_VERSION audit emit (T20)
- `sends/file.test.ts` mock instruction is misleading (T23)

## Functionality Findings (Round 4)

**[F15] Major (new in round 4): `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` placement is dead filter for personal-scope emits**
- Tenant audit-logs endpoint filters `WHERE scope IN [TENANT, TEAM]`. Five of the six emit sites use `personalAuditBase` → `scope = PERSONAL`, so they never appear in the tenant audit dashboard despite being in TENANT[ADMIN] group.
- Fix applied: §"Audit scope for VERIFIER_PEPPER_MISSING" added — ALL emit sites use `tenantAuditBase` (TENANT scope). The action is removed from `AUDIT_ACTION_GROUPS_PERSONAL[AUTH]` and stays only in `TENANT[ADMIN]`. Routes must SELECT `tenantId: true` to enable this. The user gets a generic 401; operator sees the gap in tenant dashboard.

**[F16] Minor (new in round 4): mock return-type under-specified for recover/travel-mode tests**
- Step 10d for `recover/route.test.ts` and `travel-mode.test.ts` says "3-arg mock update" but doesn't specify the boolean → VerifyResult conversion at the factory.
- Fix applied: Step 10d entries for both files now explicitly state mock factory updates with explicit `{ ok: client === stored }` return.

## Security Findings (Round 4)

**[S16] Minor (new in round 4): V1 shim naming-contract risk**
- The `resolveSecretName` shim is by name not by flag. Future `KeyName` additions could miss the exception.
- Fix applied: Step 3 shim code now includes a multi-line warning comment about not generalizing into a flag.

**[S17] (analyzed, no finding): V1 shim does NOT enable a downgrade attack beyond Risk-6**
- Confirmed: setting `passphraseVerifierVersion = 1` without also reverting the HMAC bytes results in verify failure. Attacker with DB write of both fields is already in full-takeover territory per Risk-6.

**[S18] Minor (new in round 4): `handleVerify` scope mismatch with stated operator-visibility**
- Same root cause as F15. Resolved by F15 fix (all emits use `tenantAuditBase`).

## Testing Findings (Round 4)

**[T19] Major (new in round 4): `recover/route.test.ts` mock factory at line 25 needs explicit update**
- Single module-level `vi.mock` covers both `handleVerify` and `handleReset`. Plan said "3-arg mock update for both paths" but didn't pinpoint the factory.
- Fix applied: Step 10d explicitly states "UPDATE the `vi.mock` factory at line 25" with the new signature.

**[T20] Major (new in round 4): no test for `handleVerify` MISSING_PEPPER_VERSION audit emit**
- The signature change to `handleVerify(data, userId, request)` exists for the audit-emit path, but no test verifies the audit fires.
- Fix applied: Step 10d adds NEW test for `recover/route.test.ts` that mocks `verifyPassphraseVerifier` to return MISSING_PEPPER_VERSION and asserts `logAuditAsync` with `tenantAuditBase` + `VERIFIER_PEPPER_MISSING` action.

**[T21] Major (new in round 4): pepper-failure test conversion uses wrong reason string**
- Step 10a blanket conversion `toBe(false)` → `{ ok: false, reason: 'WRONG_PASSPHRASE' }` would miscode the line 490-504 test (which tests pepper failure path = `MISSING_PEPPER_VERSION`).
- Fix applied: Step 10a now distinguishes by semantic intent — pepper-failure → MISSING_PEPPER_VERSION; hash mismatch → WRONG_PASSPHRASE.

**[T22] Minor (new in round 4): travel-mode mock factory updates at lines 18, 187 + mockReturnValue at 245, 293**
- Plan said "3-arg mock update + assertion" but didn't enumerate each `vi.fn`/`mockImplementation`/`mockReturnValue` location.
- Fix applied: Step 10d travel-mode bullet enumerates all 4 locations (lines 18, 187-189, 245, 293).

**[T23] Minor (new in round 4): `sends/file.test.ts` instruction misleading**
- Plan said "replace `hashAccessPassword: () => 'hashed-pw'`" but the file's mock factory doesn't currently include `hashAccessPassword` at all (existing tests don't exercise password-protected path).
- Fix applied: Step 10e instruction changed from REPLACE to ADD; also adds NEW test for `requirePassword: true` path.

## Adjacent Findings

(None new in Round 4.)

## Quality Warnings

(None — all findings cite concrete code references.)

## Recurring Issue Check

### Functionality expert
- All R1-R35: Round 1-3 status preserved; F15 closes a gap in R12 (group scope vs emit scope coherence).

### Security expert
- All R1-R35 + RS1-RS3: S16 documents a maintenance contract for the V1 shim; S17 confirms no new attack vector. S18 resolved by F15 fix.
- RS1, RS2, RS3: PASS.

### Testing expert
- T19-T23 close gaps in RT1 (mock-reality), R3 (test propagation), R12 (audit emit test coverage).
- RT1: now resolved by explicit factory update enumeration.
- RT2, RT3: PASS.
