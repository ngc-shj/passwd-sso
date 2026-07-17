# Code Review: security-control-verification
Date: 2026-07-17
Review round: 1

## Changes from Previous Round
Initial code review (three experts: functionality, security, testing) against `main...HEAD`
commit `450f0bbf6`.

## Functionality Findings
No findings. All 6 C5 member sites carry `assertCurrentKeyVersion`; metadata-only PUT strips
keyVersion/aadVersion in both route.ts and v1; error propagation catches KeyVersionMismatchError→409
and rethrows others; rotation tuple-CAS reads (key_version, vault_setup_at, account_salt) with
correct arg order; lock order users→password_entries consistent across all members; C11 equality at
upload+migrate+rewrap; team P2002→409 parity confirmed. Member set independently re-derived complete.

## Security Findings
### F1 (Major, escalate:false) — PUT with encryptedBlob but no keyVersion skips the C5 guard (fail-open)
`src/app/api/passwords/[id]/route.ts` + `v1/passwords/[id]/route.ts`. updateE2EPasswordSchema makes
encryptedBlob and keyVersion independently optional; the blob-tx guard is `if (keyVersion !== undefined)`.
A blob-without-keyVersion PUT skips assertCurrentKeyVersion and leaves the keyVersion column unchanged →
racing a rotation, a stale-key blob write bricks the entry (v(N+1) column, vN ciphertext). Owner-only
blast radius (RLS + userId), so Major not Critical. Everything else verified SOUND (tuple-CAS,
guard SQLi-safety/fail-closed, C11, allowlist fail-closed + env-pollution guard, deleteSignal
user.delete, team P2002, lock-order).

## Testing Findings
### F1 (Major, RT7) — metadata-strip + blob-requires-keyVersion fix untested
Existing metadata-only test carries no keyVersion; strip + new rejection unproven on both PUT paths.
### F2 (Major, RT7) — bulk-import whole-import 409 abort untested
Only a passing guard mock added; no stale-keyVersion 409 + zero-rows case.
### F3 (Major, RT7) — C11 3 boundary rejections untested
upload/migrate (→400) and rotation-rewrap (→AttachmentCekWrapAadVersionMismatchError) all exist in
production, none tested.
### F4 (Minor, RT5) — C10 collision test name over-claims (asserts static map, not route)
### F5 (Minor, RT4) — T2 witness SQL AND/OR precedence drops state='active' on 2nd disjunct (fail-safe)
### F6 (Minor, RT4) — 2 single-shot C9a races lack witness (mitigated by double-execute loop)

## Adjacent Findings
None (security F1 and testing F1 converge on the same production gap — the guard fix and its test).

## Quality Warnings
None — all findings carried file:line evidence.

## Recurring Issue Check
### Functionality expert
R1-R44 clean or N/A. R42 member-set re-derived complete; R43 team P2002 narrows 500→409;
R34 history-restore lost-update fixed in-scope; R40 null-null CAS branch dead-but-harmless.
### Security expert
R42 re-derivation surfaced F1 (fail-open member); R3/R38 same. R18/R33/R43/R44/RS3 clean.
Others not triggered. RS1/RS2/RS4/RS5/RS6 not triggered.
### Testing expert
RT1 pass (discriminated mocks); RT4 mostly pass (C6 T3 non-vacuity fixed, F5/F6 minor);
RT5 pass (real symbols); RT7 FAIL on F1/F2/F3 (three fail-closed branches untested);
RT8 pass where tested; R34 satisfied.

## Environment Verification Report
- VE1 (real-DB integration): verified-local — `npm run test:integration` run on developer machine
  (passwd-sso-db-1 healthy); C6-C10 pass. Team-rotate C7 re-run confirmed 200|409-only after P2002 fix.
- VE2 (master-key execute partial-failure): verified-local at unit level (execute-partial-failure.test.ts).
- VE3 (E2E rotation): N/A — no new E2E; existing settings-key-rotation.spec.ts unchanged.

## Resolution Status
### sec-F1 / test-F1 [Major] blob-without-keyVersion fail-open + its test
- Action: both PUT handlers now reject `encryptedBlob && keyVersion === undefined` with
  KEY_VERSION_WITHOUT_REENCRYPT, making the guard unconditional on the blob path. Honest clients
  always send keyVersion (use-personal-base-form-model.ts:86). Regression tests added (test-F1).
- Modified: src/app/api/passwords/[id]/route.ts, src/app/api/v1/passwords/[id]/route.ts (+ test files)
### test-F2 [Major] bulk-import 409 abort untested
- Action: regression test added (stale keyVersion → 409, zero rows created).
### test-F3 [Major] C11 boundary rejections untested
- Action: per-site rejection tests added (upload/migrate → 400; rewrap → AttachmentCekWrapAadVersionMismatchError).
### test-F4 [Minor] C10 collision test name
- Action: renamed to reflect it asserts the error-class→code contract.
### test-F5 [Minor] T2 witness SQL precedence
- Action: parenthesized the OR so state='active' filters both disjuncts.
### Round-2 regression (caught by full-suite gate, R19) — write-scope fixture
- The F1 fix (blob PUT now requires keyVersion) is a behavior change. A pre-existing
  `src/__tests__/api/passwords/write-scope.test.ts` fixture PUT a blob without keyVersion (valid
  before the guard was made unconditional) and correctly began returning 409. Fixed the fixture to
  send `keyVersion: 1` (what real clients always send). This is the all-test-tree safety net (R19)
  doing its job — the ripple surfaced only at the full-suite run, not the directly-touched files.
  Full suite green after: 963 files, 12,532 tests. Commit 86ae9405e.

### test-F6 [Minor] single-shot C9a races lack witness — ACCEPTED
- Anti-Deferral: Worst case = a single-shot race passes without contention firing (false green on
  that one assertion). Likelihood = low: the same updateMany CAS primitive IS contention-proven by
  the double-execute 50-iter both-outcomes loop in the same file; the single-shot tests additionally
  assert exact exclusivity + loser side-effect absence (RT8). Cost-to-fix = moderate (add a barrier/
  witness to two more cases). The plan explicitly permitted the loop fallback and it is present.
  Accepted as-is; the correctness assertions are non-vacuous even without a per-case witness.
