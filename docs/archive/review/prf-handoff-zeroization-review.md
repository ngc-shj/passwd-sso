# Plan Review: prf-handoff-zeroization
Date: 2026-05-31
Review round: 1 (resolved)

## Changes from Previous Round
Initial review. Three expert agents (functionality, security, testing) reviewed
the plan against the live codebase. No Critical findings; ownership-transfer
model verified sound by all three. All findings incorporated into the plan.

## Functionality Findings
- **F1 (Major) — resolved**: C4 omitted inverting the existing producer
  success-path zeroization assertion (`passkey-signin-button.test.tsx:140-141`).
  Under ownership transfer the producer must NOT wipe on success. → C4 now
  explicitly inverts to `some(b!==0)` + same-reference `stashPrf` assertion.
- **F2 (Major) — resolved**: `hexEncode` becomes an unused import in both
  producers. → C2 now lists import removal; notes `vault-context.tsx` keeps it.
- **F3 (Minor) — resolved**: C2 skeleton elided the load-bearing
  `result.responseJSON` read. → C2 skeleton + invariant now show it.
- Info: ownership model (`prfOutput = null` after stash) verified sufficient;
  no double-wipe path; C3 consumer fold safe; `secretKey` not regressed.

## Security Findings
- **S1 (Minor) — resolved**: `clearPrf()` has no production caller; its zeroize
  duty is latent and does not close the realistic full-reload abandonment leak.
  → C1 now scopes this honestly (latent, overwrite-only protection; full-reload
  residue accepted) and notes the browser-owned `prfResults.first` ArrayBuffer
  as the un-wipeable residency floor (no overstatement of "zero residue").
- Info: threat-model framing ("low severity defense-in-depth") accurate — this
  does not close an XSS read primitive (in-realm XSS could call `takePrf()`); it
  reduces post-use heap residency. No hidden copies (`toArrayBuffer` zero-copy,
  `importKey` opaque, no postMessage/structuredClone/Worker path).
- No Critical → no Opus escalation.

## Testing Findings
- **T1 (Minor) — resolved**: C4 omitted the two consumer early-return
  zeroization tests (`!dataRes.ok`, `!vaultData.accountSalt`) — the exact bug
  paths. → added to C4.
- **T2 (Minor) — resolved**: producer `fetchApi`-reject case underspecified and
  `prfOutput && !verifyData.prf` branch untested. → both added to C4.
- **T3 (Critical-adjacent → resolved)**: same as F1 — the producer success
  assertion inversion is the cross-component double-wipe guard;
  `prf-handoff.test.ts`'s `.toEqual` cannot catch it. → C4 now mandates the
  inverted producer-test assertion.
- **T4/T5 (Minor) — resolved**: remove dead `expectedHex`/`mockHexEncode`
  scaffolding; use bare `buf.every((b) => b === 0)` / `buf.some((b) => b !== 0)`
  idiom. → noted in C4.

## Adjacent Findings
- [Adjacent functional, from security] producer reject test must hold the same
  `Uint8Array` reference returned by the mocked `startPasskeyAuthentication` —
  folded into C4.

## Resolution Status
All findings resolved in-plan. Contracts C1-C4 remain `locked`. Proceeding to
Phase 2 (coding).
