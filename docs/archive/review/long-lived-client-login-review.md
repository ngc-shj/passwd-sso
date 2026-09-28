# Plan Review: long-lived-client-login
Date: 2026-09-28
Review round: 1

## Changes from Previous Round
Initial review. Local-LLM pre-screen findings (revoke-reason set, refresh single-flight, C10 delivery member-set, C12 line reference) were fixed before Round 1.

## Functionality Findings
- F1 [Major, design] `checkAuth(scope)` accepts session auth (authOrToken tries session first, no scope on that branch) — C2's "session rejected" was unenforced. **Merged with S2** (perspective convergence). Resolved: explicit `auth.type === "session"` → 401 in C2.
- F2 [Major, design] Proxy enforcement is `BEARER_RULES`, not `BEARER_BYPASS_ROUTE_SUMMARY` (doc-only) — new route would be unreachable. Resolved: C2 adds the `BEARER_RULES` entry + `API_PATH.VAULT_UNLOCK_VERIFY` + proxy tests.
- F3 [Major, design] No authHash primitive in extension or iOS. Resolved: new functions in `extension/src/lib/crypto.ts` and `ios/Shared/Crypto/KDF.swift`, golden vector shared across web/extension/iOS.
- F4 [Major, design] iOS constant rename cascades to `mobile/token` + `mobile/token/refresh` routes and tests; `IssueIosTokenParams` lacks idle/absolute/presence; `refreshIosToken` has no tenant read. Resolved in C8.
- F5 [Major, design] New audit actions unregistered (enum, migration, 6 coverage tests, i18n). Resolved by design change: no new `AuditAction`; reuse `VAULT_UNLOCK_FAILED`, `EXTENSION_TOKEN_FAMILY_REVOKED`, `MOBILE_TOKEN_REVOKED` with `metadata.reason`.
- F6 [Major, design] `WrappedKeyStore` protocol conformers in tests not listed. Resolved: three conformers named in C7.
- F7 [Minor, prose] Wrong grants-manifest path. Resolved (`scripts/checks/db-grants-manifest.json`).
- F8 [Minor, prose] C3 member-set carve-out incomplete (bridge code, favicon). Resolved: all non-members named.

## Security Findings
- S1 [Major, design] C2 would make account lockout reachable by a token holder without the passphrase (walk-up DoS up to the 24 h tier; shared rate key also lets it exhaust web unlock). Resolved by design change: C2 does not call `recordFailure`/`resetLockout`; `checkLockout` read-only; per-family limiter `rl:vault_unlock_verify:${familyId}`; extension sends no failure notice. **User-facing change**: earlier discussion said failures would count toward lockout — reversed here, reported to the user.
- S2 [Major, design] = F1 (merged). Also: C2 lacked a Control class line. Resolved.
- S3 [Minor, design] C11 plain token readable by any trusted extension context (incl. offscreen) without a declared control class. Resolved: control class + accepted exposure stated in C11 (wrapping impossible because SW-death survival is the requirement; DPoP compensates).
- S4 [Minor, prose] iOS presence is biometric-ACL-gated, not passphrase-gated. Resolved: FR4 reworded; C12 docs must state the iOS ceiling is the absolute cap for daily Face ID users. Security expert's verification that change-passphrase keeps authHash stable and rotate-key revokes client tokens is folded into C7.

## Testing Findings
- T1 [Critical, design] C4 race test would pass vacuously. Resolved: deterministic 4-step sequence + red-proof (adding `revokedAt: null` filter must redden it).
- T2 [Critical, design] No tests for the extension background C2 consumer. Resolved: background.test.ts cases listed. (ACCOUNT_LOCKED branch removed by S1 — verify failures are non-blocking.)
- T3 [Major, design] `mobile-token.test.ts` imports removed constants. Resolved: listed as rewrite.
- T4 [Major, design] Refresh route tested in two trees with independent session mocks. Resolved: both files listed.
- T5 [Major, design] `session-storage.test.ts` encodes the inverted contract. Resolved: the three cases named for replacement.
- T6 [Major, design] Forbidden patterns have no CI gate. **Disposition — Accepted (not a defect in this plan)**: in this skill the forbidden-pattern list is the Phase 2/3 diff-conformance grep, not a claimed CI control; the plan now says so explicitly (R49 honesty). The load-bearing invariants are structurally enforced instead: C1 by deleting the inline compare (single implementation) and by the golden-vector tests; C3 by the C4/C3 unit + integration tests that fail if an issuance site bypasses the cap; C11's "never on disk" by the session-storage tests asserting `chrome.storage.local.set` is never called with the token. Anti-Deferral: worst case = a future PR re-adds an inline compare; likelihood low (one helper, reviewed routes); cost to add three new check scripts with self-tests ≈ a day, disproportionate to the residual risk. Testing expert may contest in Round 2.
- T7 [Major, design] C10 client override untested. Resolved: extension alarm test + `AutoLockServiceTests` case.
- T8 [Major, design] FR1 manual-only. Resolved: real-DB integration test (no `sessions` row) → `verifiable-CI`; M2 kept as smoke.

## Adjacent Findings
None raised.

## Quality Warnings
None (manual dedup; Ollama merge not used this round).

## Recurring Issue Check
### Functionality expert
R1 F3 · R2 no issue · R3 no issue · R4 N/A · R5 no issue · R6 N/A · R7 N/A · R8 no issue · R9 no issue · R10 no issue · R11 N/A · R12 F5 · R13 N/A · R14 no issue (table-level grants) · R15 no issue · R16 N/A · R17 no issue · R18 F2 · R19 F6 · R20 N/A · R21 N/A · R22 N/A · R23 N/A · R24 no issue · R25 no issue · R26 no issue · R27 N/A · R28 N/A · R29 F7, F8 · R30 N/A · R31 N/A · R32 N/A · R33 N/A · R34 N/A · R35 no issue · R36 N/A · R37 N/A · R38 no issue · R39 no issue · R40 no issue · R41 F3 · R42 F2, F4, F6 · R43 Adjacent (security) · R44–R47 N/A · R48 F1 · R49 no gap in scope · R50–R57 N/A

### Security expert
R1–R6 not triggered · R7 N/A · R8–R13 not triggered · R14 noted (C9) · R15–R17 not triggered · R18 noted (C2) · R19 not triggered · R20 N/A · R21 N/A · R22 not triggered · R23 N/A · R24 noted · R25 S3 · R26 N/A · R27 not triggered · R28 N/A · R29 not triggered · R30 N/A · R31–R34 not triggered · R35 noted · R36–R37 not triggered · R38 noted (terminal fail-closed transitions) · R39 verified (C7 zeroing) · R40–R41 not triggered · R42 verified (C3 member-set) · R43–R44 not triggered · R45–R47 N/A · R48 verified (C1) · R49 S2, S3 · R50–R51 N/A · R52 noted, not triggered · R53 N/A · R54–R55 not triggered · R56–R57 N/A
RS1 verified (timingSafeEqual) · RS2 S1 · RS3 verified (Zod strict) · RS4 N/A · RS5 N/A · RS6 N/A

### Testing expert
R1–R2 not triggered · R3 T3/T4 · R4–R16 N/A or not triggered · R17 T6 · R18 N/A · R19 T3, T4, T5 · R20–R24 N/A · R25 T5 · R26–R34 N/A · R35 partial (T7/T8) · R36–R47 N/A · R48 addressed by design · R49–R57 N/A
RT1 T5 · RT2 not triggered · RT3 T3 · RT4 T1 · RT5 not triggered · RT6 T3 (inverse) · RT7 T6 · RT8 not triggered · RT9 N/A · RT10 not triggered · RT11 N/A

---

# Review round 2 (2026-09-28)

## Changes from Previous Round
All Round 1 findings applied; security-driven design change (C2 no longer feeds lockout), no new AuditAction values, BEARER_RULES entry, authHash primitives + golden vector, test-rewrite lists.

## Functionality Findings
- Round-1 F1–F8 verified resolved. Self-correction by the expert: iOS already has `deriveAuthKey` (`ios/Shared/Crypto/KDF.swift`); only the SHA-256 step is new — the plan already scoped it that way.
- G1 [Major, design] iOS family revokes go through the shared `revokeExtensionTokenFamily`, which always emits `EXTENSION_TOKEN_FAMILY_REVOKED`; plan claimed `MOBILE_TOKEN_REVOKED`. Resolved: plan now states the shared helper/action for both; `PRESENCE_EXPIRED` reason listed (also R2-S2).
- G2 [Major, design] C2's C3 recompute cannot tell iOS access vs refresh rows apart (no purpose column) → could stretch the 24 h access TTL. Resolved by removing the recompute: C2 writes only `lastPresenceAt`; presence takes effect at the next rotation (C4 MAX + C3). `presenceUntil` removed from the response.
- G3 [Minor, design] `VAULT_UNLOCK_FAILED` UI detail reads `metadata.attempts`; client-token rows have none. **Accepted**: row renders without the detail line (existing `typeof` guard); noted in C12. Anti-Deferral: worst case = a less informative audit row; cost of a render branch is small but adds UI scope the user did not ask for.

## Security Findings
- Round-1 S1–S4 verified resolved; multi-family guess multiplication bounded (families require step-up to mint); C2 is a weaker oracle than the existing offline path.
- R2-S1 [Minor, design] Cache deletion keyed on any 401. Resolved: only `{ valid: false }` 401 deletes; token-layer 401s keep it; XCTest both.
- R2-S2 [Minor, prose] `PRESENCE_EXPIRED` missing from `EXTENSION_TOKEN_REVOKE_REASON`. Resolved.

## Testing Findings
- Round-1 T1–T5, T7, T8 verified resolved.
- T6-contest [Major, design] Structural-enforcement claim held for C11 but not C1/C3; repo has cheap precedent. **Round-1 disposition withdrawn**; resolved: `check-crypto-domains.mjs` Check G (authHash compare containment) + new `check-client-token-expiry.mjs` (lexical-with-context, self-test, pre-pr + static-checks), both declared `best-effort tripwire`.
- NF1 [Major, design] C2 `ACCOUNT_LOCKED`/429 branches untested. Resolved: route acceptance (locked → limiter not consumed, compare not run, row unchanged) + one consumer case per response.
- NF2 [Major, design] Golden vector duplicated in three tests. Resolved: frozen `scripts/checks/auth-hash-golden-vectors.json` + Check F.
- NF3 [Major, design] No XCTest for cache eviction. Resolved.
- NF4 [Minor, prose] Duplicate bullet. Resolved.
- NF5 [Minor, prose] IP-restriction hedge. Resolved: already keyed off token-row tenant; tenant-policy source moves to token tenant; acceptance added.

## Recurring Issue Check
### Functionality expert
R1 no new issue · R2–R11 no issue/N/A · R12 no coverage gap (G1 is usage) · R13–R17 N/A · R18 BEARER_RULES verified · R19 conformers verified · R20–R23 N/A · R24 no issue · R25 no issue · R26–R28 N/A · R29 G1, G3, self-correction on F3 · R30–R41 N/A · R42 G1, G2 · R43 Adjacent · R44–R47 N/A · R48 checked · R49 G1 (filed under R42) · R50–R57 N/A
### Security expert
R1–R6 not triggered · R7 N/A · R8–R13 not triggered · R14 noted · R15–R17 not triggered · R18 verified · R19 not triggered · R20–R21 N/A · R22 not triggered · R23 N/A · R24 noted · R25 verified · R26 N/A · R27 not triggered · R28 N/A · R29 not triggered · R30 N/A · R31–R34 not triggered · R35 noted · R36–R37 not triggered · R38 noted · R39 verified · R40–R41 not triggered · R42 verified + R2-S2 · R43–R44 not triggered · R45–R47 N/A · R48 verified · R49 verified · R50–R51 N/A · R52 not triggered · R53 N/A · R54–R55 not triggered · R56–R57 N/A · RS1 verified · RS2 verified · RS3 verified · RS4–RS6 N/A
### Testing expert
R1 not triggered · R2 NF2 · R3 not triggered · R4–R16 N/A · R17 T6-contest · R18 N/A · R19 not triggered · R20–R24 N/A · R25 not triggered · R26–R34 N/A · R35 not triggered · R36–R47 N/A · R48 addressed · R49 noted · R50–R57 N/A · RT1 not triggered · RT2 not triggered · RT3 NF2 · RT4 not triggered · RT5 not triggered · RT6 not triggered · RT7 T6-contest · RT8 not triggered · RT9 N/A · RT10 not triggered · RT11 N/A

---

# Review round 3 (2026-09-28)

## Changes from Previous Round
G1/G2/G3, R2-S1/S2, T6-contest, NF1–NF5 applied (C2 writes only lastPresenceAt; shared revoke helper for iOS; CI gates F/G + check-client-token-expiry).

## Functionality Findings
- G1/G2 verified; extension alarm timing confirmed unaffected by removing the C2 recompute. Check F and the new expiry gate verified feasible against existing precedent.
- H1 [Major, design] iOS `verifyUnlock` had no refresh ladder; the 24 h access token is usually expired at the next day's Face ID unlock, so presence would silently fail in the common case. Resolved: shared `performAuthedPOST` mirroring `performAuthedGET`; XCTest for expired-access → refresh → verify.
- H2 [Major, design] `rotate-key/route.ts` already has an inline salt + `timingSafeEqual` compare; Check G's premise was false. Resolved: C1 member-set derived by command, rotate-key migrates to `compareVaultAuthHash`.

## Security Findings
- Tenant-move escape and presence-revival investigated; neither reachable.
- R3-N1 [Minor, prose] C5's reliance on the deactivated-member check + single-active-membership invariant unstated. Resolved: stated in C5.

## Testing Findings
- Round-2 items verified.
- NF6 [Major, design] New gate's self-test location/exemption file not pinned to `check-gate-selftest-coverage.sh` convention. Resolved.
- NF7 [Minor, design] iOS presence-expiry acceptance did not assert audit action/reason. Resolved.

## Recurring Issue Check
### Functionality expert
R1–R2 no issue · R3 H1 · R4–R28 no issue/N/A · R29 H2 · R30–R40 N/A · R41 H1 · R42 H2 · R43–R48 no new issue · R49 H2 (filed under R42) · R50–R57 N/A
### Security expert
R1–R6 not triggered · R7 N/A · R8–R13 not triggered · R14 noted · R15–R17 not triggered · R18 verified · R19 not triggered · R20–R21 N/A · R22 not triggered · R23 N/A · R24 noted · R25 verified · R26 N/A · R27 not triggered · R28 N/A · R29 not triggered · R30 N/A · R31–R34 not triggered · R35 noted · R36–R37 not triggered · R38 noted · R39 verified · R40–R41 not triggered · R42 verified · R43–R44 not triggered · R45–R47 N/A · R48 verified · R49 R3-N1 · R50 verified · R51 N/A · R52 investigated, sound · R53 N/A · R54–R55 not triggered · R56–R57 N/A · RS1–RS3 verified · RS4–RS6 N/A
### Testing expert
R1–R16 not triggered/N/A · R17 NF6 · R18–R28 N/A/not triggered · R29 not triggered · R30–R47 N/A · R48 addressed · R49 noted · R50–R57 N/A · RT1–RT6 not triggered · RT7 NF6 · RT8 not triggered · RT9 N/A · RT10 not triggered · RT11 N/A

---

# Review round 4 (2026-09-28)

## Changes from Previous Round
H1 (iOS performAuthedPOST ladder), H2 (rotate-key → compareVaultAuthHash; member-set by command), NF6, NF7, R3-N1 applied.

## Functionality Findings
No findings. rotate-key migration verified as a mechanical swap (route limiter kept; it never had lockout — wording tightened in C1).

## Security Findings
No findings. rotate-key timing-safety preserved; TokenRefreshCoordinator serializes the new caller.
- [Adjacent] Minor, design: a status-only ladder would refresh+retry on a `{ valid: false }` 401. Resolved: ladder keyed on token-layer error codes; XCTest asserts one request on mismatch.

## Testing Findings
- NF8 [Major, design] C1 acceptance and Check G red-proof covered only unlock/route.ts after H2 added rotate-key. Resolved: both routes' tests named; red-proof fixture for each file.

## Recurring Issue Check
### Functionality expert
R1–R57 no issue / N/A
### Security expert
R1–R6 not triggered · R7 N/A · R8–R13 not triggered · R14 noted · R15–R17 not triggered · R18 verified · R19 not triggered · R20–R21 N/A · R22 not triggered · R23 N/A · R24 noted · R25 verified · R26 N/A · R27 not triggered · R28 N/A · R29 not triggered · R30 N/A · R31–R34 not triggered · R35 noted · R36–R37 not triggered · R38 noted · R39 verified · R40–R41 not triggered · R42 verified · R43–R44 not triggered · R45–R47 N/A · R48 verified (C1 now sole adjudicator for all three sites) · R49 verified · R50 verified · R51 N/A · R52 investigated, sound · R53 N/A · R54–R55 not triggered · R56–R57 N/A · RS1 verified · RS2 verified · RS3 verified · RS4–RS6 N/A
### Testing expert
R1–R16 not triggered/N/A · R17 NF8 · R18–R28 N/A/not triggered · R29 not triggered · R30–R41 N/A/not triggered · R42 not triggered · R43–R47 N/A · R48 addressed · R49 noted · R50–R57 N/A · RT1–RT6 not triggered · RT7 NF8 · RT8 not triggered · RT9 not triggered · RT10 not triggered · RT11 N/A

---

# Review round 5 (2026-09-28)

## Changes from Previous Round
NF8 (both compare routes in C1 acceptance / Check G red-proof), C1 rotate-key wording, iOS ladder scoped to token-layer 401s.

## Functionality Findings
- I1 [Major, design] `MobileAPIClient` never parses 401 bodies, so "skip the ladder on `{ valid: false }` 401" and "delete cache only on hash mismatch" were not buildable from a mirror of `performAuthedGET`. Resolved by changing C2's contract: hash mismatch returns `200 { verified: false }`; 401 from C2 always means a token/DPoP failure. `performAuthedPOST` becomes a straight mirror; cache deletion keys on `verified: false`.

## Security Findings
Not run this round (no security-relevant change in round-4→5 diff beyond what round 4 reviewed).

## Testing Findings
No findings (NF8 and the ladder scoping verified).

## Recurring Issue Check
### Functionality expert
R1–R2 no issue · R3 I1 · R4–R40 no issue/N/A · R41 I1 · R42–R57 no new issue
### Testing expert
R1–R57 not triggered/N/A · RT1–RT11 not triggered/N/A (RT7 re-checked)

---

# Review round 6 (2026-09-28)

## Changes from Previous Round
I1 resolved by contract change: C2 mismatch → `200 { verified: false }`.

## Functionality Findings
- J1 [Major, prose] / J2 [Major, design] — same as RF2 / RF1 (stale 401-as-mismatch narrative; extension consumer test list missing the mismatch case). Resolved; 401 now logged as token failure.

## Security Findings
- R6-S1 [Major, design] `200` for a wrong hash hides guessing from status-based infra monitoring, while app-level lockout notification is unreachable on this path by design (S1). Resolved by a second contract change: mismatch → `422 AUTH_HASH_MISMATCH` (new error code, status unique on the route) — keeps status-only client branching (I1) and 4xx visibility. Cross-route status difference (web 401 vs C2 422) documented in C12; audit stream is the unified signal.

## Testing Findings
- RF1 [Major, design] extension consumer test list lacked the mismatch case. Resolved.
- RF2 [Minor, prose] stale narrative. Resolved.

## Recurring Issue Check
### Functionality expert
R1–R2 no issue · R3 N/A · R4–R28 no issue/N/A · R29 J1 · R30–R41 N/A/no new issue · R42 J2 · R43–R57 no new issue
### Security expert
R1–R47 unchanged/not triggered · R48 R6-S1 · R49 R6-S1 · R50–R57 N/A/not triggered · RS1 N/A · RS2 verified · RS3–RS6 not triggered/N/A
### Testing expert
R1–R57 not triggered/N/A except R3 (RF1/RF2) · RT1–RT11 not triggered/N/A

---

# Review round 7 (2026-09-28)

## Changes from Previous Round
R6-S1 resolved: C2 mismatch → `422 AUTH_HASH_MISMATCH`; RF1/RF2/J1/J2 applied.

## Findings
- Security R7-N1 / Testing RF3 / Functionality K1 [Minor, prose] — same finding: "422 used by no other code" is false (`MCP_CLIENT_LIMIT_EXCEEDED: 422`). Resolved: C2 says 422 is unique among this route's responses; any 422-rate alert must be path-scoped (C12).
- All experts verified: `performAuthedGET`'s default branch throws `serverError(status:)` with the real status (422 reachable); i18n coverage and error-code completeness tests enforce the new code.

## Recurring Issue Check
### Functionality expert
R1–R28 no issue/N/A · R29 K1 · R30–R57 no issue/N/A
### Security expert
R1–R28 not triggered/N/A · R29 R7-N1 · R30–R47 not triggered/N/A · R48 verified resolved · R49 verified resolved · R50 verified · R51–R57 N/A/not triggered · RS1 N/A · RS2 verified · RS3–RS6 not triggered/N/A
### Testing expert
R1–R57 not triggered/N/A except R29 (RF3) · RT1–RT11 not triggered/N/A (RT7 re-checked)

## Saturation call (Phase 1 exit)
- Rounds completed: 7 (≥ 2).
- Open Critical/Major: none (every Critical/Major from rounds 1–6 is reflected in the plan; none carries an Anti-Deferral disposition — T6's round-1 "Accepted" was withdrawn in round 2 and fixed).
- Round-7 findings: one Minor, labelled `prose` by all three experts, resolved.
- Remaining findings: none. Carried-forward plan findings: none.
- Observation: rounds 4–7 found defects introduced by the previous round's fixes (NF8, I1, R6-S1, K1), not design defects in the original contracts — the saturation pattern.
