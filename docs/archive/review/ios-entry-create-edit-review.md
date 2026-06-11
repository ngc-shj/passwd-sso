# Plan Review: ios-entry-create-edit
Date: 2026-06-11
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings
- **F1 (Major)**: `saveEntry` rewritten body needs `cacheData`, contradicting "keep exact existing signature". Resolve by making `VaultViewModel` own `cacheData` internally (set in `loadFromCache`, refreshed after writes). → ADOPTED (C3).
- **F2 (Major)**: C4 `keyVersion` plumbing chain incomplete — must enumerate `UnlockResult`, `VaultUnlocker:146`, both `AppState.vaultUnlocked` construct sites (real + DEBUG), the match at RootView:52, `VaultListView`, `EntryDetailView`/`EntryForm`, and `DebugVaultLoader.LoadedState`. → ADOPTED (C4).
- **F3 (Major)**: `createE2EPasswordSchema` requires `keyVersion >= 1`; `CacheEntry.keyVersion`/DEBUG default 0 → 422. Guard `max(1, keyVersion)` / DEBUG supplies ≥1. → ADOPTED (C4).
- **F4 (Minor)**: `VaultUnlockerTests` must assert `result.keyVersion == unlockData.keyVersion` with a DISTINCT value (e.g. 7) to prove threading, not hardcoding. → ADOPTED (C4).
- **F5 (Major)**: 3 existing `VaultViewModelTests` calling `saveEntry(detail:overview:)` break on signature change. Must be migrated. → ADOPTED (C3/C6).
- **F6 (Major)**: The extension PUT sends the LIVE vault `keyVersion`, not the entry's stored version. **The plan's "reuse the entry's own keyVersion" was wrong**: iOS re-encrypts with the current in-memory vault key, so it MUST send the live `keyVersion` (+ `aadVersion: 1`). DECRYPT of the existing blob uses the entry's STORED aadVersion (handles legacy `aadVersion: 0`); RE-ENCRYPT uses live keyVersion + aadVersion 1 (upgrades legacy entries). → ADOPTED (C3/C4) — corrects a real bug.
- **F7 (Minor)**: Plan claimed byte-identical create shape to the extension; the extension writes `notes: ""` while the plan writes `null`. Both decode fine. → DOC FIX (C2).
- **F8 (Major)**: Optimistic `allSummaries` prepend after `runSync` duplicates the entry once `loadFromCache` re-runs. Refresh `allSummaries` from the sync's fresh `cacheData` instead of manual prepend. → ADOPTED (C3).

## Security Findings
- **S1 (Critical, escalate:false)**: `decodeVoidResponse` accepts only 200/204; POST returns 201 → every create throws. Plan already specifies extending to 200/201/204; add a regression test that 200/204 still pass. → ADOPTED (C1).
- **S2 (Critical, escalate:false)**: No post-create verification that the server-returned `id` equals the locally-generated `entryId` used for the AAD. A mismatch = permanent silent decrypt failure (entry vanishes). `createEntry` must decode the 201 response and assert `id == entryId`. → ADOPTED (C1/C3).
- **S3 (Major)**: keyVersion not threaded → create sends hardcoded 1. Duplicate of F2/F6. → ADOPTED (C4).
- **S4 (Major)**: Execution ordering — enabling the edit UI (C5) before the lossy `EntryEditForm.save()` is rewritten (C2/C3) ships the corruption. Enforce order C2→C3→C5; C6 removes the lossy path. → ADOPTED (C5/C6).
- **S5 (Major)**: `EntryPlaintext` encodes flat `"totpSecret"` not `"totp":{secret}` — confirms the builder must own all blob construction. → ADOPTED (C2/C6 forbidden-pattern).
- **S6 (Minor)**: `UUID().uuidString.lowercased()` correct for Prisma uuid column; covered by S2's id-equality check. → ADOPTED (C1).
- **S7 (Minor, [Adjacent]→Functionality)**: Verify `TOTPCodeView` tap-to-copy routes through `copySecurely`. Pre-existing in an unchanged file. → TODO marker (verify during impl).
- **S8**: `passwordHistory` preservation — confirmed clean, no concern.
- **S9 (Minor)**: No standalone `*-manual-test.md` artifact (R35 Tier-1). → ADOPTED (create artifact).

## Testing Findings
- **T1 (Major)**: 201 regression — add explicit 200/201/204 + 4xx test cases to C1. → ADOPTED (C1). (dup of S1)
- **T2 (Major)**: The C3 round-trip test (decrypt PUT body → tags survive) is not implementable without a `CacheData` seed fixture. Add `seedCache(...)` test helper that encrypts real plaintext into a `CacheEntry`. → ADOPTED (C3 testing).
- **T3 (Major)**: C2 case 3 must assert `XCTAssertNotNil(detail)` AND `detail.tags == ["work"]` AND `detail.password == <new>` — not just non-nil. → ADOPTED (C2).
- **T4 (Major)**: `UnlockResult.keyVersion` field — existing field-by-field tests pass vacuously; the new assertion is mandatory + distinct value. → ADOPTED (C4). (dup of F4)
- **T5 (Major)**: C2 case 9 Bool fidelity must inspect raw JSON / `as? Bool` (JSON `1` decodes to Swift `true`, masking the NSNumber-bool pitfall). → ADOPTED (C2).
- **T6 (Minor)**: C3 `createEntry` test must assert `entryType == "LOGIN"` and `aadVersion == 1` in the POST body. → ADOPTED (C3).
- **T7 (Minor)**: C6 must enumerate `VaultViewModelTests` (not only `EntryEncrypterTests`) as an `EntryPlaintext`/`OverviewPlaintext` consumer to migrate/delete. → ADOPTED (C6).
- **T8 (Minor)**: C2 case 8 must check raw `"username":null` (NSNull), not just `EntryBlobDecoder` round-trip (which maps both null and "" to ""). → ADOPTED (C2).
- **T9 (Minor, [Adjacent]→Functionality)**: legacy `aadVersion: 0` entries — resolved by F6: decrypt with stored aadVersion, re-encrypt with aadVersion 1. Add a test case. → ADOPTED (C3).

## Adjacent Findings
- S7-A → Functionality: `TOTPCodeView` clipboard copy hygiene (pre-existing). TODO(ios-entry-create-edit): verify during impl.
- T9-A → Functionality: legacy aadVersion 0 upgrade-on-edit — folded into C3/F6.

## Recurring Issue Check
### Functionality expert
R1 n/a, R2 n/a, R3 applicable (AppState.vaultUnlocked sites — F2), R4 n/a, R5 n/a, R6 n/a, R7 n/a, R8 n/a, R9 n/a, R10 n/a, R11 n/a, R12 n/a, R13 n/a, R14 n/a, R15 n/a, R16 n/a, R17 applicable (PersonalEntryBlobBuilder — C6), R18 n/a, R19 applicable (saveEntry tests — F5), R20 n/a, R21 n/a (plan phase), R22 applicable (=R17), R23 n/a, R24 n/a, R25 n/a, R26 n/a, R27 n/a, R28 n/a, R29 n/a, R30 n/a, R31 n/a, R32 n/a, R33 n/a, R34 applicable (EntryEditForm is the buggy file being fixed; no missed sibling), R35 n/a, R36 n/a, R37 n/a.

### Security expert
R1-R37 as above; additionally RS1 n/a (no credential compares), RS2 n/a (server route already rate-limited; no new route), RS3 clean (server Zod validates; client id is system UUID), RS4 clean (no PII in plan).

### Testing expert
R1-R37 as above; RT1 applicable (201 mock-reality — T1), RT2 verified (all recommended tests unit-testable in XCTest), RT3 no finding, RT4 n/a (no concurrency tests), RT5 no finding (tests call production primitives directly).

## Disposition
All Critical + Major findings ADOPTED into the plan (round 2 below). No findings skipped. No escalation to Opus required (both Criticals have unambiguous fixes).
