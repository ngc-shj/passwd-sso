# Plan Review: security-control-verification
Date: 2026-07-17
Review rounds: 1-2

## Round 1 (initial, three experts) — all findings folded into the plan
Functionality: F1 (Critical, metadata-only PUT stale-write — 3-expert convergence), F2 (history
restore out-of-tx snapshot), F3 (409 envelope shape), F4 (bulk-import swallow), F5/F6 (Minor).
Security: F1 (converges func-F1), F2 (rotation lacks in-tx CAS / reset resurrection), F4
(user.delete cascade), F3/F5/F6/F7/F8/F9. Testing: F1 (RT5 entry points), F2 (RT7 per-lock),
F3 (RT4 loop), F4 (RT1 mock), F5 (RT8 loser side effects), F6 (RT4 barriers), F7-F10.
Resolution: see plan contracts C1-C11 (revised) and Round-1 detail preserved in git history of
this file's prior revision.

## Round 2 (incremental verification of Round-1 fixes)

### Functionality
- Confirmed good: F1 strip (schema optional, guard is not equal-only today — genuinely needed),
  F2 restore, F3 envelope (verified flat `{error: code}` + sharded ApiErrors.json), F5/F6.
- NEW func findings (fixed): (a) **lock-order audit under-derived** — `src/auth.ts:90-199`
  tenant-migration tx updates `users` then `passwordEntry`/History in one tx; a third member the
  "exactly two" claim missed. Verified it already locks users-first (compatible, no code change) —
  plan corrected to "three". (b) **F4 Consumer 4 inaccurate** — import client chunks and folds
  non-429 into `failedCount` without reading `body.error`; corrected walkthrough, re-unlock UX
  moved to SC3. (c) **error-code maps** — adding `KEY_VERSION_MISMATCH` forces `API_ERROR_STATUS`
  + `API_ERROR_I18N` (compile-gated); named as deliverable.

### Security
- Confirmed good: F4 (user.delete cascade — verified schema onDelete:Cascade, parent recompute
  user/team only, tenant Restrict excluded), F1, F3, F5, F6, F7, F8, F9, F6b (ambient-tx folding
  verified). F2 CAS correct for the decreased-version reset case.
- NEW security finding (fixed): **NEW-1 (Major)** — the `key_version != oldKeyVersion` CAS is not
  monotonic-unique across reset→re-setup; an old-passphrase-holding attacker can resurrect
  attacker-controlled wrapping over a freshly re-setup vault (keyVersion returns to 1). Fixed:
  CAS bound to `(keyVersion, vaultSetupAt)` tuple (route already reads `vaultSetupAt` pre-tx);
  T4 extended with sub-case T4b. R38 (fail-open supersession on key state) axis.

### Testing
- Confirmed good: F1 (entry points exist/importable, cache-rollback precedent real), F3 (loop),
  F4 (mock discrimination feasible — file already inspects tpl text + asserts order), F5, F8
  (scan widening), F9/F10, new C6-T4 and C11 (non-concurrent boundary tests, no witness needed).
- NEW testing findings (fixed): (a) **row-lock pg_locks predicate** — C6 T2 / C9a cited the
  advisory-lock T12.6c precedent for ROW-level waiters; corrected to
  `locktype IN ('transactionid','tuple') AND NOT granted` / `pg_blocking_pids`. (b) **T1 mis-map**
  — T1 is sequential (409 from comparison, not lock); RT7 table corrected so only T2/T3 prove
  `FOR SHARE`. (c) **C7 barrier unsound** — team re-read is plain `findUnique` (non-locking under
  read-committed); FOR-UPDATE-barrier dropped, primary mechanism is the ≥50-iter both-outcomes
  loop. (d) **C9a framing** — atomic conditional updateMany, no pre-read phase; write-write
  contention witnessable as tuple/transactionid locktype. (e) **C4 derivation grep** drifted from
  the widened scan scope; aligned + `user.delete` added.

## Adjacent Findings
test-F8 (C4 scan-scope) — resolved in C4.

## Quality Warnings
None — all findings carried file:line evidence.

## Recurring Issue Check
### Functionality (R1-R44)
Round 2: R3/R5/R17 (F1), R34 (F2 restore), R40/R41 (F4 consumer), R42 (lock-order auth.ts) all
triggered and resolved. Others not-triggered/N-A.
### Security (R1-R44 + RS1-RS6)
Round 2: R3, R6 (F4 cascade), R17, R38 (NEW-1 key-state supersession), R42 (parent-model
recompute), R43, RS3/RS5 triggered/resolved. CAS sound after tuple fix. Others OK.
### Testing (R1-R44 + RT1-RT9)
Round 2: RT4 (row-lock witness predicate + C7 barrier), RT5, RT7 (T1 mis-map), RT8, R42 (C4 grep
drift), R2, R33, R34 triggered/resolved. Others OK.

## Round 3 (focused convergence on round-2 deltas: tuple-CAS, witness predicate, C7/C9a, auth.ts, C4 grep)

### Security
- Confirmed good: auth.ts "three members" lock-order accurate (locks users-first, no cycle);
  tuple-CAS closes the reset→resetup case (vaultSetupAt collision only theoretical).
- **NEW SEC-R3-1 (Major, R42 self-application)**: the `(keyVersion, vaultSetupAt)` tuple is
  INVARIANT across a legitimate change-passphrase / recover-reset rewrap — both rewrite
  `encryptedSecretKey`+`accountSalt` without touching keyVersion/vaultSetupAt. So the NEW-1
  wrapping-hijack is reachable WITHOUT a reset: an old-passphrase-holding attacker's stale
  rotation clobbers a concurrent legitimate rewrap. Root cause: the discriminator was derived from
  the reset scenario, not the wrapping-write PRIMITIVE (four writers: setup, change-passphrase,
  recover, rotation). FIXED: CAS discriminator changed to include `account_salt` (moved by all
  four wrapping writers — verified); `accountSalt` added to the route's pre-tx select (was absent);
  T4b updated; T4c (rotation-vs-change-passphrase, no reset) added with RT7 kill-mutant (drop
  account_salt → T4c fails).

### Testing
- Confirmed all six round-2 corrections sound and non-vacuous (entry points, T1 map, C7 loop,
  C9a reframe, C4 grep, T4b). Three Low/Info refinements, all folded in:
  - test-F1: `pg_blocking_pids` promoted to PRIMARY row-lock witness (tuple locktype transient);
    `transactionid AND NOT granted` as fallback; advisory removed for row locks.
  - test-F2: C7 + C9a-fallback loops must assert `winCount>0 AND loserCount>0` explicitly with
    per-pair jitter (not "invariant held") — restated in both.
  - test-F3: C4 fixtures must prefix the primitive call (boundary regex misses column-0) —
    fixture-authoring note added.

## Round 4 (final convergence: account_salt discriminator completeness)
Security — **No findings.** Exhaustive enumeration of every `users` wrapping-column writer
reproduced exactly the four-writer set (setup, change-passphrase, recover, rotation) + reset→NULL;
`account_salt` is moved by all of them. Verified `generateAccountSalt()` = fresh 32-byte
`crypto.getRandomValues` per rewrap (`crypto-client.ts:275`), so change-passphrase-to-same-passphrase
does not degenerate the discriminator. EA-grant escrow writes target a different model (correctly
excluded). No reset/takeover/migration/worker path rewraps `users` wrapping while leaving
`accountSalt` fixed. CAS `(keyVersion, vaultSetupAt, accountSalt)` is COMPLETE; SEC-R3-1 fully
closed. R42/R38 satisfied. One implementation obligation (add `accountSalt: true` to the pre-tx
select) is stated in the plan and belongs to Phase 3 verification.

## Convergence status: CONVERGED
Four rounds. Finding severity/scope shrank monotonically (R1: 21 findings → R2: 3 → R3: 1 Major +
3 Low → R4: 0). All contracts C1-C11 locked. Recurring theme: R42 member-set derivation applied
recursively — the rotation CAS discriminator was re-derived each round from a wider primitive
(keyVersion → +vaultSetupAt → +accountSalt) until it covered the complete vault-wrapping-writer
set. Plan ready for Phase 2.
