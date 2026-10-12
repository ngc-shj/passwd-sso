# Code Review: vault-lock-epoch
Date: 2026-10-13
Review round: 1

## Changes from Previous Round
Initial review of `206e223db`. Three fresh expert sub-agents did a full-diff review, running the code in scratch copies.

## Findings and resolution

### Security
| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| F1 | Major | The `swFetch` epoch assert ran before `swFetchAuthenticated`'s DPoP signing await, so a write or the passkey replace-DELETE could still be sent after a lock. | `swFetchAuthenticated(..., beforeSend)` now runs the check after signing, immediately before `fetch`. `swFetch` passes `assertFresh` on all three sends, and `recordUnlockPresence` passes its epoch check. Tested by holding `signDpopProof` (T3). |
| F2 | Minor | A lock in `fetchAndDecryptTeamBlob` returned `null`, reported as FETCH_FAILED. | Asserted before each post-await `return null`. Tests: team COPY_PASSWORD (team-key and item-key paths). |
| F3 | Minor | `startKeepalive` awaited `ensureOffscreen` after the caller's check, so the keepalive could restart after a lock. | `startKeepalive(isStillWanted)` rechecks after the await. Tested. |
| F4 | Minor | UNLOCK's abort arms after the commit left the committed state in place. | `abandonCommittedUnlock` rolls back its own commit, guarded by `unlockCommitSeq` so a later unlock is not cleared. Two tests. |

### Functionality
| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| F1 | Minor | On the team path, `VaultLockedError` escaped `performAutofillForEntry`, and a context-menu fill across a lock left a stuck failure badge. | The team fetch maps to `lockedResult`, and the context menu does not notify for VAULT_LOCKED. Tested at the context-menu unit and click levels. |
| F2 | Minor | The badge guard sat after the post-await `""` writes. | The guard now runs right after `isOwnAppPage`. Tested, including `""`. |
| F3 | Minor | The now-working team-key retry refetched once per undecryptable entry. | It now refetches once per key version per call. Tested (exactly one refetch). |

### Testing
| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| T1 | Major | Most members lacked the lock → re-unlock variant. With the epoch check weakened to `!encryptionKey`, the suite stayed green. | `it.each(INTERRUPTIONS)` adds a re-unlock as `user-2` for A2, A5, A6 (all seven delivery paths), A7, A8, A9, A10, A11 and A19. Each was red-proven against the weakened mutant. |
| T2 | Major | The `discardRestoredSession` bump had no test. | Test added: a mismatched restored binding and an unlock held at `verifyKey`. It goes red without the bump. |
| T3 | Major | The swFetch hold was not on the last await (`signDpopProof`). | `signDpopProof` holds for the SAVE_LOGIN POST, both 401 retries and the unlock-verify POST. Each send site was red-proven. |
| T4 | Minor | A9 had an unneeded sleep, a stale comment and an unspecific hold. | Fixed. |
| T5 | Minor | D2 omitted the guards that no test reaches. | D2 now names its sites by subject and records the defence-in-depth guards. |
| T6 | Minor | An unfired `holdNextCall` leaked into later tests. | The previous implementation is restored when the hold fires and at test end. The `helpers-deferred.test.ts` red-proof was run against the old helper. |

## Recurring Issue Check
### Security expert
- R42: the member set was re-derived; it found the `swFetchAuthenticated` and `startKeepalive` sinks.
- R43: clean.
- R49: F1's comments overstated the protection; corrected by the fix.
- All others: n/a.

### Functionality expert
- R3: F1 and F2.
- R10: OK.
- R38: OK.
- R39: OK.
- R42: OK.
- R43: OK.
- All others: n/a.

### Testing expert
- R42: T2.
- RT7: T1, T2 and T3.
- RT8 / RT10: OK.
- RT11: T6.
- R29: D2 line drift; fixed in T5.
- All others: OK or n/a.

## Environment Verification Report
- VE1 (Chrome manual: unlock → lock → unlock quickly; normal fill, copy, save and passkey flows): `blocked-deferred` to the user before merge, per plan VE1.
- Unit tests: 1734 passed under seeds 1, 2, 7, 13 and 42. tsc and the build pass.
