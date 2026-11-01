# Code Review: ios-sync-team-failure-isolation
Date: 2026-11-02
Review round: 1

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
HostSyncServiceTests 18/18, full suite 872 tests, 0 failures.

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
- P4 team-list failure goes on personal-only -> `testRefreshTeamKeys_transientTeamsError_doesNotWipeExistingKeys`.
- P5 directory built from the unfiltered list -> `testRunSync_oneTeamFetchNotFound_personalAndOtherTeamsStillSync`.
- P6 entry loop throws on any error (the original bug) -> both 404 cells.
