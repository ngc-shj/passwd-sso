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

### Security [Adjacent] secretKey throw-path zeroization — Fixed (user opted to include)
- The user chose to include this in the PR. Applied the same consolidation as
  C3: `secretKey` hoisted to an outer `let`, the three explicit `secretKey.fill(0)`
  calls folded into the single outer `finally` (`secretKey?.fill(0)` next to
  `prfOutput.fill(0)`), so the post-derivation throw paths (VaultUnlockError on
  `/api/vault/unlock` body.error, crypto-derivation throws) now zeroize the
  unwrapped vault secret key.
- Modified: `src/lib/vault/vault-context.tsx` (`unlockWithStoredPrf`).
- Test: `src/lib/vault/vault-context.test.tsx` — new "zeroizes the unwrapped
  secret key when unlock throws AFTER the key is unwrapped" regression test;
  captures the real unwrapped key via a pass-through spy on
  `unwrapSecretKeyWithPrf` (real crypto preserved) and asserts it is zeroized.
  Mutation-verified: removing `secretKey?.fill(0)` makes the test fail.
- Focused functionality + security re-review of the delta: No findings (copy
  happens before the finally wipe; no use-after-zeroize; scope-isolated to
  `unlockWithStoredPrf`; null-safe optional chain; strictly increases coverage).

## Post-review hardening — stashPrf TTL (follow-up)
A secondary review of PR #505 suggested a TTL on `stashPrf` so an unconsumed
handoff does not linger indefinitely. Applied: `PRF_HANDOFF_TTL_MS = 30_000`;
`stashPrf` arms `setTimeout(clearPrf, …)`, cancelled by `takePrf` / `clearPrf` /
overwrite via a managed `ttlTimer` (so a stale timer can never wipe a fresh
handoff or a consumer-owned buffer). The module doc keeps the scope honest: the
TTL only bounds the in-SPA-without-unlock residency window — a full page reload
drops the module and the timer via GC regardless.
- Modified: `src/lib/auth/prf-handoff.ts`.
- Tests: `prf-handoff.test.ts` — TTL self-expiry, no-wipe-before-TTL,
  takePrf-cancels-TTL, re-stash-resets-TTL. Mutation-verified (neutering the
  `setTimeout` fails the self-expiry test). Full suite 10775 passed.

### TTL triangulate review (functionality / security / testing)
Ran a focused Phase 3 round on the TTL delta (`88d35c49..HEAD`):
- Functionality: No findings — timer lifecycle correct (`cancelTtl` on every
  `pending` transition), `clearPrf` hoisting valid, SSR-safe (no module-top
  `setTimeout`), 30s comfortably covers stash→`takePrf` with graceful
  degradation to manual unlock on expiry.
- Security: No findings — strictly reduces residency (abandoned handoff wiped at
  ≤30s vs. unbounded-until-GC before), no new exposure, take-vs-timer race
  foreclosed by single-threaded `cancelTtl` in `takePrf`.
- Testing: two Low items. (a) "does NOT wipe before TTL" is a narrow boundary
  guard — kept. (b) Coverage gap: `clearPrf`'s timer cancellation untested.
  Analysis showed the expert's suggested wipe-based test would be vacuous (a
  following `stashPrf` cancels the timer anyway; a phantom fire no-ops on null
  `pending`) — `clearPrf`'s `cancelTtl` is a timer-hygiene contract. Added a
  `vi.getTimerCount()` assertion test instead; mutation-verified (removing
  `cancelTtl` from `clearPrf` fails it). `prf-handoff.test.ts` now 9 tests.

## Tightening-only skip — Round 1
Findings applied directly (no Round 2 review):
- [T1] [Low] dead `prfSentinel` scaffolding — both producer test files — applied
Justification: test-only change, scoped within the reviewed files, inline minor
(dead-code removal), no security-boundary touch. 16 affected tests + lint pass.
