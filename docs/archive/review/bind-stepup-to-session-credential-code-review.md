# Code Review: bind-stepup-to-session-credential
Date: 2026-08-12
Review round: 1

## Changes from Previous Round

Initial code review. Phase 2's Step 2-5 self-R-check (R1–R57 + RS*/RT*) came back clean for
functionality and security and found three testing gaps, all closed before this round; Round 1 is
therefore incremental verification on top of that baseline. Ollama seed generation was attempted and
timed out on the 4759-line diff, so all three experts fell back to full-diff review — the documented
fallback. Local LLM pre-screening (`pre-review.sh code`) returned "No issues found".

## Merged Findings (deduplicated, convergence-stamped)

| ID | Severity | Subject | Reported by | Convergence |
|----|----------|---------|-------------|-------------|
| C1 | **Critical** | The "I9 ordering" integration test does not exercise the mechanism its name and comment claim. The deletion commits before the route runs, so `ON DELETE SET NULL` has already nulled the binding and step 3 denies first — proven by an instrumented probe (the verifier is never called) and by mutation (swapping the route to `verifyAssertionAnyCredential`, the exact regression `C4` exists to prevent, left it green). RT4/RT7. | testing F1 | single-perspective, but **execution-verified** |
| M1 | Major | Wrapping the migration in `BEGIN`/`COMMIT` after it had been applied left `_prisma_migrations.checksum` permanently divergent from the file (`1842111f…` recorded vs `c694b2ec…` on disk, both measured). Any database that applied the pre-wrap file is blocked at the next `db:migrate`. | functionality F1 | single-perspective |
| M2 | Major | `check-bypass-rls.mjs`'s fixed 10-line `SCAN_RADIUS` no longer reaches the Prisma model calls in the three `withBypassRls` callbacks this branch lengthened — the binding read, the existence re-check and the `passkey_verified_at` write sit 8 to 67 lines past the window. Verified by injecting an unlisted model at each site: the gate still exited 0. Also falsifies the plan's claim that `C5` member 1 "moves it inside" (R29). | security 1 | single-perspective, **execution-verified** |
| M3 | Major | `e2e/tests/step-up-credential-binding.spec.ts` — the plan's own "only full-stack proof of the reported regression", explicitly in scope and not deferred — had never been executed in any environment, and so could be classified neither `verified-*` nor `blocked-deferred`. | testing 2 | single-perspective |
| m1 | Minor | `presentedCredentialIdMetadata` set `presentedCredentialIdRejected: true` both when the id was legitimately absent and when it was present but refused — collapsing the two states the flag exists to keep apart, resolved the opposite way from what its own comment argues for. | security 2 | single-perspective |
| m2 | Minor | Two files named under `C5` in the plan's Implementation Checklist (`signin/page.test.ts`, `page.basepath.test.ts`) are absent from the diff with no deviation entry. Both were re-run and pass unmodified — the gap is an unreconciled manifest, not a coverage regression. | functionality F2, testing 3 | **functionality+testing** |
| m3 | Minor | `presentedCredentialId`'s 512-char bound had a distant deny test (600) and a charset deny test, but no boundary-adjacent allow case at exactly 512 — asymmetric with `boundCredentialId`, which has one. An off-by-one (`<` for `<=`) would reject every legitimately-sized id undetected. | testing 4 | single-perspective |
| m4 | Minor | `C7`'s "the row survives (`truncateMetadata` did not fire)" criterion was proven only against the route's own pre-bounding function with `logAuditAsync` mocked, never against the real audit pipeline. | testing 5 | single-perspective |

## Adjacent Findings

- functionality F2 → routed to Testing; merged with testing 3 as `m2`.
- testing F1 (C1) carried an `[Adjacent]` tag to Security; the finding is a test defect, so it stays
  in Testing's lane and Security's independent review reached no contradicting conclusion.

## Quality Warnings

None. Every finding carried file/line evidence, and the two most consequential (C1, M2) were
demonstrated by execution rather than argued from reading.

## Environment Verification Report

Per the plan's `Verification environment constraints` VE1–VE3:

| Path | Classification | Basis |
|---|---|---|
| Signed WebAuthn ceremony, any tier | `blocked-deferred` | VE1 + its Anti-Deferral entry, owner `SC5`. Link present and correct. |
| `counter_mismatch` / `signature_invalid` at the integration tier | `blocked-deferred` | Plan's tier split + deviation D2. Covered instead at the route tier, as the plan assigns. |
| `credential_missing` via a same-user mid-transaction deletion | `blocked-deferred` | Deviation D2, and now D9 for the same conclusion reached about I9. |
| Integration suite | `verified-local` | `npm run test:integration` → 98 files / 611 passed (VE3 satisfied; `audit-outbox-worker` stopped for the run and restarted after — the guard refused a run while it was up, which is the guard working). |
| Unit suite / lint / build | `verified-local` | `npx vitest run` → 1008 files / 14530 passed; `npm run lint` and `npx next build` exit 0. |
| `scripts/pre-pr.sh` (70 gates) | `verified-local` | `check-pre-pr.sh run` exit 0. |
| The 7 CI-only gates of D5 | `verified-local` | Each run by hand, each exit 0; `refactor-phase-verify --force` explained by D8. |
| Manual two-authenticator scenarios 1–7 on `mrx33` (VE2) | **not verified** | No access from this session. Outstanding for the human merge gate. |
| E2E dialog-selection spec | **not verified — see D13** | Attempted; `globalSetup` fails seeding the first pre-existing fixture user with an RLS violation, blocking every E2E spec locally. Runs in CI on the PR (`ci.yml:491`, path filter `e2e/**`). Anti-Deferral entry in D13. |

## Resolution Status

### C1 Critical — the I9 test does not reach the mechanism it names
- Action: renamed to "the FK cascade's effect reaches the route: an outstanding ceremony on a
  deleted binding denies at step 3, verifier never called"; comment rewritten to state what it does
  and does not prove; two assertions added so it cannot be re-read as verifier evidence (the audit
  `reason` is pinned to `no_binding`, and the Redis challenge is asserted still present). The
  substitution defense is left where it is actually proven — `verify-authentication-assertion.test.ts`'s
  DENY case against the real verifier, and the "bound row present, wrong credential presented"
  integration case. Recorded as deviation D9 with the reason the true race is unschedulable, the same
  conclusion D2 reached for `credential_missing`.
- Modified: `src/__tests__/db-integration/reauth-credential-binding.integration.test.ts:237-300`

### M1 Major — migration checksum drift
- Action: measured both values, re-synced the recorded checksum on the dev database, verified
  equality and `prisma migrate status` up to date. D12 records the one-line re-sync any other
  environment that applied the pre-wrap file needs, `mrx33` included.
- Modified: `_prisma_migrations` row (dev DB, metadata only);
  `docs/archive/review/bind-stepup-to-session-credential-deviation.md` (D12)

### M2 Major — the bypass-RLS gate's scan window no longer covers its subjects
- Action: replaced the fixed radius with a balanced-delimiter walk of each call's actual extent;
  comment-only matches are skipped (`src/auth.ts:66` names the helper in prose); a call whose extent
  cannot be determined now fails the gate by name instead of falling back silently.
  **Red-proved per site**: injecting `tx.someUnauthorizedModel.` at the previously-invisible line of
  each of the three files makes the gate exit 1 in all three cases, while the real tree exits 0.
  Mutations were applied to scratchpad-backed copies; the files were verified byte-identical after.
  The widened window surfaced two pre-existing legitimate members in
  `src/app/api/user/mcp-tokens/route.ts` (`mcpRefreshToken`, `delegationSession`, `auditLog` — the
  sibling `[id]` route has listed exactly those for as long as it has existed), whose entry was
  extended. The plan's false "moves it inside" sentence was corrected in place. D10.
- Modified: `scripts/checks/check-bypass-rls.mjs`;
  `docs/archive/review/bind-stepup-to-session-credential-plan.md` (checklist correction)

### M3 Major — the E2E spec had never run
- Action: attempted, with a dedicated dev server so the existing one was untouched. Playwright exit
  1, and it never reached this branch's spec: `globalSetup` fails on the first pre-existing fixture
  user with `new row violates row-level security policy for table "users"` — a local-harness
  limitation affecting every E2E spec here, predating this branch. Not repaired in this branch (it is
  its own change and touches how tests bypass RLS). Teardown clean, no residue, port released. The
  CI `e2e` job runs the spec on the PR. Recorded as D13 with a quantified Anti-Deferral entry and a
  grep-able TODO.
- Modified: `docs/archive/review/bind-stepup-to-session-credential-deviation.md` (D13)

### m1 Minor — absent vs refused collapsed into one audit flag
- Action: `presentedCredentialIdMetadata` now returns `presentedCredentialIdAbsent: true` when the
  request carried no id, keeping `presentedCredentialIdRejected` for a value that was present and
  refused. New test asserts the absent case does **not** set the rejected flag.
- Modified: `src/app/api/auth/passkey/reauth/verify/route.ts:99-121`,
  `src/app/api/auth/passkey/reauth/verify/route.test.ts`

### m2 Minor — two checklist files absent from the diff
- Action: both re-run (25/25 pass unmodified) and the reason they need no edit recorded as D11 —
  they mock the module boundary and neither signature changed.
- Modified: `docs/archive/review/bind-stepup-to-session-credential-deviation.md` (D11)

### m3 Minor — no boundary-adjacent allow case for `presentedCredentialId`
- Action: added the exact-512 allow test, mirroring `boundCredentialId`'s.
- Modified: `src/app/api/auth/passkey/reauth/verify/route.test.ts`

### m4 Minor — truncation survival never proven through the real pipeline
- Action: added an integration case that registers a 600-character credential id, drives a mismatch
  denial through the real route, and asserts the `audit_outbox` row carries the truncated id plus its
  marker and lacks `_truncated` / `_originalSize`.
- Modified: `src/__tests__/db-integration/reauth-credential-binding.integration.test.ts`

### Verification after fixes
`npx tsc --noEmit` 0 · `npm run lint` 0 · `npx vitest run` 1008 files / 14530 passed ·
`npm run test:integration` 98 files / 611 passed · `npx next build` 0 ·
`check-pre-pr.sh run` 70/70 pass, exit 0 · `npm run check:bypass-rls` 0 (and red-provable).

## Recurring Issue Check

### Functionality expert
R1–R57 checked incrementally on top of the Phase 2 baseline; clean except as noted.
R1 clean (`BASE64URL_RE` consolidated per D3). R2 clean (`AUDIT_CREDENTIAL_ID_MAX_LENGTH` kept
distinct from `USER_AGENT_MAX_LENGTH` despite the equal value — value equality is not meaning
equality). R3 clean (zero remaining references to `verifyAuthenticationAssertion`; all three
production call sites and all four test callers moved). R4–R13 N/A to this diff's shape. R14 clean
(table-level grants cover the new column). R15/R16 N/A. R17 clean (all shared helpers reused).
R18 clean (allowlist updated exactly as derived). R19 clean (both exact-shape assertions moved).
R20–R23 N/A. R24 clean (additive-only). R25–R28 N/A. R29 spot-checked three inline citations
(`tenant-management.test.ts:45`, `with-request-log.ts`, the `reauth/options` "reachable, not
defensive" comment) — all accurate. R30–R33 N/A. R34 clean (SC1–SC6 all carry cost comparisons).
R35 N/A. R36 clean (zero suppressions remain). R37 N/A. R38 N/A. R39 N/A. R40 clean (the `reason`
union is exhaustively switched with a `never`-typed default). R41 N/A. **R42 → finding m2.**
R43 clean. R44 N/A (D8 covers the one instance). R45/R46 N/A. R47 clean (`reason` replaced the
`details`-text classification). R48 clean (C6's removal verified by grep). R49 clean (D1's guard
closes the gap the plan had flagged as unenforced). R50 clean. R51–R57 N/A.

### Security expert
R1 OK. R2 OK. **R3 → finding M2.** R4 N/A. R5 OK. R6 OK (`ON DELETE SET NULL`, not `Cascade`).
R7 OK. R8 N/A. R9 OK. R10 N/A. R11 N/A. R12 OK. R13 N/A. R14 OK. R15 OK. R16 OK (`REDIS_URL`
present in CI, so the two real-Redis integration tests are not silently skipped). R17 OK.
**R18 → finding M2** (values correct, enforcement radius insufficient). R19 OK. R20–R23 N/A.
R24 OK. R25 OK (MS7: the session cache carries neither `provider` nor the new fields). R26–R28 N/A.
**R29 → finding M2** (the plan's "moves it inside" claim false on re-verification). R30–R33 N/A.
R34 OK. R35 OK. R36 OK. R37 OK. R38 OK (the unbound-session `stale` state always has a live
sign-in-again escape; no wedge). R39 N/A. R40 OK. R41 OK. R42 OK (MS1/MS2/MS4/MS6 re-derived by
grep; no missed writer or adjudicator). R43 OK (the change only narrows). R44 OK. R45 N/A.
**R46 overlaps M2** (fixed-line window instead of actual callback scope). R47 OK (no branch on
`details`). R48 OK (one `passkeyVerifiedAt` reader remains). **R49 → M2.** R50 OK. R51 N/A.
R52 OK. R53 OK (the 512 bound justified against real ids and `METADATA_MAX_BYTES`; boundary tested).
R54 OK. R55 OK. R56/R57 N/A. RS1 N/A (no new secret comparison). RS2 OK. **RS3 → finding m1.**
RS4 OK. RS5 OK (`credentialRowId` is always server-derived). RS6 OK (the charset check runs before
serialization, closing the escaping-expansion vector by construction).

### Testing expert
R1–R57 not re-run as a rote pass (the Phase 2 baseline stands); spot checks during the
acceptance-criteria walk (R14, R18, R24, R29, R36, R42) found no contradicting evidence.
RT1 clean (every `authCredential` fixture carries `userId`; the 8 previously-uncompilable `GET()`
calls fixed). RT2 all findings testable in this harness; none rejected. RT3 clean.
**RT4 → finding C1.** RT5 clean (the real verifier is reached by the scoping tests).
RT6 clean. **RT7 → finding C1**, satisfied elsewhere; the E2E gate is wired in `ci.yml`.
RT8 clean (every denial test asserts the guarded mutation did not happen). RT9 clean (no twin).
**RT10 → finding m3**, otherwise satisfied. RT11 clean (the dedicated `TEST_USERS` entry is unique
and reclaimed by `cleanup()`; no contamination of the ~25 specs sharing other users).

## Seed Finding Disposition

Seed unavailable — no dispositions to record. (Ollama seed generation exceeded its budget on the
4759-line diff; all three experts performed full-diff review, the documented fallback.)
