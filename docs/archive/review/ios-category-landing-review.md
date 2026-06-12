# Plan Review: ios-category-landing

Date: 2026-06-13
Review round: 1 (functionality / security / testing, 3 parallel expert sub-agents)

## Changes from Previous Round
Initial review, grounded against post-#552 `origin/main`.

## Functionality Findings
- **F1/F2 [Major] — `EntryBlobDecoder.summary` real signature is `summary(plaintext:entryId:teamId:)`, 4 call sites; `entryType`/`isFavorite` are `CacheEntry` metadata, not in the overview blob.** **Resolved** → C1 threads defaulted `entryType`/`isFavorite` params through the signature; only `VaultViewModel.decryptOverview` passes them (the 3 AutoFill call sites keep defaults).
- **F3/T2 [Major] — Codable migration risk over-stated: `VaultEntrySummary` is never persisted** (rebuilt from `CacheEntry`). **Resolved** → C1 drops the migration hedge; real concern is `CacheEntry.isFavorite: Bool?` (JSON-backward-compatible).
- **F4 [Major] — `filterFavoritesOnly` reconcile under-specified; audit shows zero external callers.** **Resolved** → C4 removes the dead placeholder (single favorites path).
- **F5 [Minor] — `VaultCategory` × `filterTeamId` composition.** **Resolved** → personal-only; `filterTeamId` stays nil; category filters on top of `filteredSummaries`.
- **F6 [Minor]** — stale `CacheEntry` line ref. **Resolved** (verified 594-639).
- Confirmed: all 8 entry-type raw values exist server-side; Trash/Watchtower deferral correct (server filters archived/trashed; no iOS Watchtower client).

## Security Findings
- **S1 [Minor] — `isFavorite` is server-visible metadata, same posture as the shipped `entryType`; encrypted at rest in the cache.** **Resolved (accepted)** → documented in Considerations; no new exposure.
- **S2 [Minor] — screen-recording overlay must apply to the new landing/category views.** **Resolved** → C4 mandates the overlay on `VaultCategoryListView` (and the in-place grid lives inside `VaultListView`, which already overlays).
- **S3 [Minor] — category labels must not leak raw type identifiers; add a compiler-enforced label.** **Resolved** → C2 `EntryTypeCategory.localizedLabel` (String(localized:)); forbidden raw `entryType == "` comparisons.
- RS4: no PII in the plan doc.

## Testing Findings
- **T1 [Major] = F1; T2 [Major] = F3.** Resolved as above.
- **T3 [Major] — no `.all` parity baseline test.** **Resolved** → C4 acceptance adds VM `.all`-parity + search-compose tests.
- **T4/RT1 [Major] — test fixtures (`CacheEntry`/summary builders) need the new fields.** **Resolved** → C4 testing note; new optional/defaulted fields keep existing labeled-init call sites compiling; fixtures updated where a test needs `isFavorite`/`entryType`.
- **T5/RT3 [Minor] — test raw type strings should use `EntryTypeCategory.rawValue`.** **Resolved** → C3 tests use the enum rawValue.
- **T6/RT2 [Minor] — nav-ownership move not unit-testable.** **Resolved by design** → the in-place landing AVOIDS the ownership move entirely (lower regression surface); manual checklist covers layout.

## Resolution Summary
All Critical/Major findings reflected in the revised plan. The biggest correction was architectural: round-1
assumed a NavigationStack/toolbar ownership move (high regression surface) — the revised plan builds the
landing **in-place** inside `VaultListView`, eliminating that risk. No findings deferred. Phase-3 review
verifies the implemented diff.

## Recurring Issue Check (consolidated)
R3/R17/R22 propagation (summary signature + 4 call sites enumerated) · R12 enum consumers (`EntryTypeCategory` total `from`) ·
R19 new fields (summary/CacheEntry — labeled inits with defaults; fixtures updated) · R25 persist/hydrate
(`CacheEntry.isFavorite: Bool?` optional, hydrate-tolerant; summary not persisted) · R8 UI consistency
(grid follows native Passwords pattern). RS4 no PII. RT1 mock-reality (fixtures), RT2 testability (pure
`matches`/`categoryCounts`; layout manual), RT3 shared constants (enum rawValue). Others N/A.
