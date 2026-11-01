# Code Review: ios-sync-team-failure-isolation
Date: 2026-11-02
Review round: 4 (final)

Issue `#989`. No plan file: a bug fix scoped by the issue (out-of-scope item SC2 of
`team-tenant-departure-plan.md`). Project: iOS app, XCTest on a macOS simulator host.

## Changes from Previous Round
Initial review of `c23e1a1b8` (per-team catch in `HostSyncService.performSync`,
`isTeamScopedFailure` with a `default: true` arm).

## Functionality Findings
- F1 [Major] `default: return true` sent errors that are not `MobileAPIError` down the
  skip path: keychain and DPoP-signer failures once the device locks mid-sync hit every
  remaining team, so the cache was rewritten personal-only.
- F2 [Major] 5xx (502/503/504 gateway errors in particular) were team-scoped: an outage
  starting during the team loop dropped the teams fetched in it.
- F3 [Major] `refreshTeamKeys` skipped every error other than auth/passkey, then rewrote
  the whole key set: a network drop during the key loop erased team keys. A second,
  divergent classifier for the same question (R48).
- F4 [Major] A transient `GET /api/teams` failure went on with no teams and wrote a cache
  without any team entries (only keys/directory were protected).
- F5 [Minor] The team directory kept a team that answered 404.

## Security Findings
No findings. The change shortens how long a departed team's entries and key stay on
the device (the 404 path drops them on this sync instead of keeping the whole previous
cache). Seed "default: true is fail-open" rejected for security: the server can already
return `200 []`; the effect is availability. Raised as an Adjacent Minor (server-wide
5xx/403 drops all teams) — merged into F1/F2.

## Testing Findings
- T1 [Major] The classifier was tested on a hand-picked list; 8 inputs reaching
  `default: true` unasserted; no compile-time exhaustiveness.
- T2 [Minor] The 404 test's personal fixture was empty.
- T3 [Minor] The 404 test asserted a count, not which entries were cached.
- T4 [Minor] No test where every team answers 404.
- T5 [Minor] The transport test proved "no rewrite" only through the counter.
- T6 [Minor] The transport test reused the 404 test's team names.

## Adjacent Findings
- Security → Functionality: server-wide 5xx/403 (merged into F1/F2; 403 kept
  team-scoped — the team route answers 403 only for that team's IP policy or the
  member's permission, `team-auth.ts`).
- Testing → Functionality: exhaustive switch (adopted with T1).

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R3: F3, F4 (skip-vs-fail decided at three sites). R12: F1. R38: OK. R42: F1 (error
  set derived from `performAuthedGET`/`validAccessToken`/`buildDPoPProof`/`performHTTP`).
  R48: F3, F4. R49: the docstring promised more than the code did (F1, F2, F4).
### Security expert
- R3: OK (single call site; key loop already per-team). R12: OK. RS1, RS2, RS5, RS6: N/A.
  RS3: OK (typed decode). RS4: OK (synthetic ids).
### Testing expert
- R12/R42: T1. R19: N/A. RT1: OK (fixture and 404 body match the server route).
  RT2: OK. RT3: OK. RT4: N/A. RT5: OK. RT6: OK. RT7: OK (red-proved). RT8: T5.
  RT9: N/A. RT10: T1, T4. RT11: OK.

## Environment Verification Report
`verified-local`: `xcodebuild test` on z1mn-island (iPhone 15 Pro simulator) —
HostSyncServiceTests 19/19 + VaultViewModelTests 20/20, full suite 874 tests, 0 failures
(round 2).

## Resolution Status
- F1, F2, T1: `isTeamScopedFailure` is an allowlist with an exhaustive switch over
  `MobileAPIError`: team-scoped = `serverError(403|404)`, `notFound`,
  `teamKeyNotDistributed`, `DecodingError`; everything else (any non-`MobileAPIError`,
  401, 429, 5xx, transport, session, cancellation) fails the sync. A new enum case
  does not compile until classified.
- F3: the key loop classifies the member-key fetch with the same function; key
  material that does not unwrap still skips only that team.
- F4: a team-list failure fails the sync (previous cache, keys and directory kept);
  `teamsAuthoritative` is gone.
- F5: a team answering 404 is left out of the directory and the key set.
- T2-T6: the 404 test caches a personal entry and asserts the cached ids; a test where
  every team answers 404; transport and 503 cases assert no cache file and an unchanged
  counter; neutral fixture names; the classifier test covers every `MobileAPIError` case
  and a keychain `NSError`.
- Pre-screen: the "best-effort; never fails the personal sync" comment is rewritten.

### Red-proofs (scratch copy on the build host -> the cell that reddened)
- P1 key loop skips every error -> `testRefreshTeamKeys_memberKeyNetworkError_failsSyncAndKeepsKeys`
  (and the existing passkey cell).
- P2 non-`MobileAPIError` classified team-scoped -> `testIsTeamScopedFailure_classifiesEveryError`.
- P3 5xx team-scoped -> `testRunSync_teamFetchFailureNotScopedToTeam_failsSyncWithoutWriting`.
- P4 team-list failure goes on personal-only -> the team-list failure cell (renamed in round 2, T11).
- P5 directory built from the unfiltered list -> `testRunSync_oneTeamFetchNotFound_personalAndOtherTeamsStillSync`.
- P6 entry loop throws on any error (the original bug) -> both 404 cells.

## Round 2

### Changes from Previous Round
Incremental review of `f010e4a2c`. F1-F5 and T1-T6 resolved. No Critical; Security
confirmed usable access to a kept team key stays capped at 15 minutes after the last
successful sync on every read path (`TeamEntryDecryptor.teamKeyMaxAge`), so failing
the sync on more errors does not extend a removed member's access (R43).

### Findings
- S1 [Minor] Expired wrapped team keys stayed at rest across failed syncs (unusable,
  but kept on disk longer than main did).
- FUNC-R2-1 [Minor] The team directory was saved before the key loop could fail the
  sync, leaving it ahead of the unwritten cache and keys.
- FUNC-R2-2 [Minor] A comment claimed a 404 always drops the team's key; not on the
  no-ECDH path (R49).
- FUNC-R2-3 [Minor, widened by this branch] A sync failing after a confirmed create or
  save was reported as "Could not save"; a retried create duplicated the entry. This
  branch added triggers (team-list, 5xx, member-key transport failures).
- T7 [Major] The 403-vs-404 split of `isMembershipGone` was untested.
- T8 [Major] The key loop's skip on key material that does not unwrap was untested.
- T9 [Minor] The not-scoped test accepted any non-team-scoped error.
- T10 [Minor] No positive control for the cache file on the success path.
- T11 [Minor] A renamed behaviour kept its old test name.

### Resolution Status
- S1: `performSync` prunes team keys past the staleness window on every exit
  (`pruneExpiredTeamKeys`), keeping fresh ones.
- FUNC-R2-1: the directory is persisted after the key loop (and on the no-ECDH /
  malformed-ECDH returns), so a failed sync leaves it as it was.
- FUNC-R2-2: comment states the key set drops the team when keys are refreshed.
- FUNC-R2-3: `VaultViewModel.refreshAfterConfirmedWrite` (shared by create and save)
  does not report the refresh sync's failure; the next sync surfaces session or
  passkey problems. No other write path syncs after a confirmed write.
- T7: `testIsMembershipGone_onlyWhenNotAMember`; the 404 sync test adds a team
  answering 403 that keeps its directory entry and has no cached entries.
- T8: the two-team key test adds a team whose key material is bound to another team
  and is skipped.
- T9: each case asserts its own error (by case and URL error code).
- T10: the 404 test asserts the cache file exists.
- T11: renamed to `testRunSync_teamListError_failsSyncAndKeepsKeys`; it also seeds an
  expired key and asserts only the fresh one remains (S1).

### Red-proofs (scratch copy on the build host -> the cell that reddened)
- Q1 directory saved before the key loop -> `testRefreshTeamKeys_memberKeyNetworkError_failsSyncAndKeepsKeys`.
- Q2 expired keys kept unless all are expired -> `testRunSync_teamListError_failsSyncAndKeepsKeys`.
- Q3 403 counted as departed -> `testIsMembershipGone_onlyWhenNotAMember`, the 404 sync test.
- Q4 key material that does not unwrap fails the sync -> `testRefreshTeamKeys_oneTeamNotDistributed_otherTeamWritten`.
- Q5 create surfaces the refresh sync's failure -> `testCreateEntry_syncFailsAfterConfirmedWrite_doesNotThrow`.

## Round 3

### Changes from Previous Round
Incremental review of `6f83bff65`. Security: no findings (the prune keeps exactly
what the read side accepts — same `<= teamKeyMaxAge` predicate; passkey state is
recorded by `MobileAPIClient` before it throws and sessions are enforced server-side,
so not surfacing the post-write refresh failure weakens nothing). No Critical/Major
from functionality.

### Findings
- F-R3-1 [Minor] The directory could still land ahead of a cache whose write failed
  after the key loop; the comment overclaimed (R49).
- F-R3-2 [Minor] After a confirmed write whose refresh sync fails, the list keeps the
  pre-write state with no notice.
- A-R3-1 [Minor] `CredentialResolver` repeated the 15-minute literal; the prune's
  safety relies on it equalling `TeamEntryDecryptor.teamKeyMaxAge` (R48).
- T12 [Major] The directory save on the ECDH path was untested (three call sites).
- T13 [Major] The post-write refresh's list reload was unpinned.
- T14 [Minor] Pruning on a successful sync was untested.
- T15 [Minor] `clearTeamKeysIfAllStale` was subsumed by the prune; its tests no
  longer pinned it.
- T16 / A-R3-2 [Minor] The create test had no control that the refresh sync failed.
- T17 [Minor] `saveEntry`'s refresh-failure path was untested.
- T18 [Minor] Stale docstring; the round-1 record cited a renamed test.

### Resolution Status
- F-R3-1, T12: the directory is saved in `performSync` after the cache is written and
  the counter advanced — one site, with the cache it labels.
  `testRunSync_cacheWriteFails_directoryNotSaved` pins it; the two-team ECDH test asserts
  every membership is labelled, saved once.
- A-R3-1: `CredentialResolver` defaults to `TeamEntryDecryptor.teamKeyMaxAge`.
- T15: `clearTeamKeysIfAllStale` removed; the no-ECDH and malformed-ECDH returns leave
  the set to the prune (their tests now pin the prune).
- T13, T16, T17: save tests for the refresh failing and succeeding (list rebuilt);
  the create test asserts the team list was asked for and no cache was written.
- T14: `testRunSync_success_prunesOnlyExpiredTeamKeys`.
- T18: docstring and round-1 record corrected.
- F-R3-2: Accepted.
  - Anti-Deferral check: the change needed is a new UI notice (product copy and UX),
    not a fix of the refresh itself.
  - Worst case: the list shows pre-write values until the next sync (foreground
    return, pull-to-refresh, or background sync); the write is on the server.
    Re-editing from the stale view overwrites the fields with the user's input.
  - Likelihood: needs a confirmed write followed immediately by a sync failure.
  - Cost to fix: low code, but it is a user-facing behaviour change outside `#989`.
    Before this branch the same case showed "Could not save" and a retried create
    duplicated the entry.

### Red-proofs (scratch copy on the build host -> the cell that reddened)
- R1 directory saved before the cache write -> `testRunSync_cacheWriteFails_directoryNotSaved`.
- R2 directory never saved -> the two-team ECDH test and the 404 sync test.
- R3 no prune -> `testRunSync_success_prunesOnlyExpiredTeamKeys`, the team-list failure
  test, and both all-stale tests (no-ECDH, malformed ECDH).
- R4 save surfaces the refresh failure -> both save tests.
- R5 refresh never reloads the list -> `testSaveEntry_syncSucceeds_reloadsListFromFreshCache`.

Full suite: 878 tests, 0 failures.

## Round 4

### Changes from Previous Round
Incremental review of `6b226cfa6`. Security: no findings (the prune deletes a superset
of what the all-stale clear did; a corrupt store is handled as before; the AutoFill
resolver's only production call site takes the shared default). Functionality: no
Critical/Major. All remaining findings are Minor and in tests.

### Findings
- F-R4-1 / T19 [Minor] The malformed-ECDH test still named the removed function.
- F-R4-2 [Minor] No test pinned the directory save without an ECDH key.
- T20 [Minor] The cache-write test accepted any `EntryCacheError`, not the write step's.
- T21 [Minor] The malformed-ECDH branch keeping fresh keys was unpinned.
- T22 [Minor, optional] The prune's `<=` boundary and the resolver default's coupling
  to the shared constant have no behavioural pin.
- T23 [Minor] The save refresh-failure test did not assert the list keeps its state.

### Resolution Status
- F-R4-1, T19, T21: the malformed-ECDH test seeds a fresh and an expired key and asserts
  only the fresh one remains; renamed `testRefreshTeamKeys_malformedECDH_keepsFreshKeysPrunesExpired`.
  Red-proved: clearing the set in that branch reddens it.
- F-R4-2: the no-ECDH fresh-set test records the directory (saved once, every team).
- T20: `catch EntryCacheError.ioError`.
- T23: asserts the list still shows the pre-write title.
- T22: Accepted.
  - Anti-Deferral check: pinning the exact boundary needs a clock injected into
    `HostSyncService`, a production seam added only for a test.
  - Worst case: a future edit flips `<=` to `<`, pruning a key exactly at 15:00 that a
    reader would still accept for that instant. The next sync re-derives it.
  - Likelihood: low; both sides read `TeamEntryDecryptor.teamKeyMaxAge`, so the values
    cannot drift.
  - Cost to fix: a clock parameter on `HostSyncService.init` and its call sites.

### Tightening-only skip — Round 4
Findings applied directly (no Round 5 review):
- F-R4-1/T19, F-R4-2, T20, T21, T23 — `ios/PasswdSSOTests/HostSyncServiceTests.swift`,
  `ios/PasswdSSOTests/VaultViewModelTests.swift` — test-only.
Justification: every finding is within the round-3 fix scope, test code or wording
only (no production change), and changes no security boundary.

## Summary
Four rounds. Full iOS suite on the simulator host: 878 tests, 0 failures. Every fix
red-proved (P1-P6, Q1-Q5, R1-R5, and the round-4 T21 mutation).
