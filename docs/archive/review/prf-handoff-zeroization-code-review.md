# Code Review: prf-handoff-zeroization
Date: 2026-05-31
Review round: 1 (resolved)

## Changes from Previous Round
Initial code review of the committed implementation (10b57884). Three expert
agents reviewed `git diff main...HEAD`. Functionality and Security returned No
findings; both mutation-tested the ownership-transfer model. Testing returned
one Low (dead test scaffolding), now fixed.

## Functionality Findings
**No findings.** Verified: ownership transfer correct in both producers (every
exit either stashes-then-nulls or wipes exactly once — no leak, no double-wipe);
`result.responseJSON` read correctly after the destructure→`result` restructure;
consumer `secretKey` zeroization on its own error paths not regressed; outer
`finally` touches only `prfOutput`; `prfOutput` guaranteed non-null entering the
try; `pending?.prfOutput.fill(0)` optional chaining safe; `hexEncode` removed
from producers, `hexDecode` correctly retained in vault-context.

## Security Findings
**No findings.** The refactor strictly increases zeroization coverage and
introduces no new residue path (the immutable un-wipeable hex string is
eliminated; the single `Uint8Array` is the only mutable copy and is wiped on
every path). `clearPrf`/`stashPrf` overwrite-wipe correct; `takePrf`
deliberately does not wipe (ownership → consumer). Consumer throw-window safe
(`const prfOutput = handoff.prfOutput` cannot throw, no await before the try).
sessionStorage posture unchanged (only the non-secret `psso:webauthn-signin`
flag remains). No Critical → no escalation.

- **[Adjacent / pre-existing, NOT a regression]**: `secretKey` is not zeroized
  if a throw occurs after its assignment in the consumer (e.g.
  `deriveAuthKey`/`computeAuthHash` throwing, or the `VaultUnlockError` throw
  paths). Identical on `main`, unchanged by this diff, outside this fix's scope
  (PRF buffer). Recorded for visibility; not fixed here. See Resolution Status.

## Testing Findings
- **T1 (Low) — resolved**: dead write-only `prfSentinel` hoisted scaffolding in
  both producer test files (`passkey-signin-button.test.tsx`,
  `security-key-signin-form.test.tsx`) — assigned in `makePrfSentinel` but never
  read (assertions use the returned `prfBytes` local). Removed.
- The reviewer mutation-tested the new assertions: removing `prfOutput = null`
  (producer) made the success test fail; removing the consumer `finally` made
  both new early-return tests fail — confirming the assertions are non-vacuous.

## Adjacent Findings
- Security [Adjacent] pre-existing `secretKey` throw-path zeroization gap (see
  Security Findings above).

## Resolution Status

### T1 [Low] Dead `prfSentinel` scaffolding — Fixed
- Action: removed `prfSentinel` from the hoisted block and the `.current`
  assignment from `makePrfSentinel` in both producer test files.
- Modified: `src/components/auth/passkey-signin-button.test.tsx`,
  `src/components/auth/security-key-signin-form.test.tsx`

### Security [Adjacent] secretKey throw-path zeroization — Out of scope (pre-existing)
- **Anti-Deferral check**: pre-existing in a changed file (`vault-context.tsx`).
- **Justification**: The gap is identical on `main` and is unrelated to this
  fix's contract (PRF output zeroization). It is narrow defense-in-depth
  (secretKey is copied to `secretKeyRef` and wiped at line 751 on success; the
  only uncovered window is an exception thrown after assignment). Worst case:
  the live `secretKey` buffer lingers in heap until GC after an unlock that
  throws post-derivation — likelihood low (derivation rarely throws), cost to
  fix small but cross-cutting (would touch the whole unlock family for
  consistency, not just this path). Per the user's filter on speculative
  defensive scaffolding, surfaced to the user rather than silently expanded
  into this PR's scope.
- **Orchestrator sign-off**: routed to user decision (see final report); not
  blocking this fix.

## Tightening-only skip — Round 1
Findings applied directly (no Round 2 review):
- [T1] [Low] dead `prfSentinel` scaffolding — both producer test files — applied
Justification: test-only change, scoped within the reviewed files, inline minor
(dead-code removal), no security-boundary touch. 16 affected tests + lint pass.
