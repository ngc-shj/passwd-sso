# Plan Review: directory-structure-review
Date: 2026-06-07
Review rounds: 2 (converged)

## Changes from Previous Round
- **Round 1**: initial three-expert review of the plan (after a read-only
  current-state diagnosis re-validated every pin file-by-file).
- **Round 2**: incremental review of the round-1 fixes; surfaced 3 Minor
  refinements (load-env count, exact vi.mock alias targets incl. a dead mock,
  dual `security-headers.ts` naming collision). All resolved.

## Diagnosis (pre-review, read-only)
Three parallel diagnostic sweeps established the evidence base:
1. **scripts/ pins** — of ~44 root files only 5 have no mechanical coupling; the
   #519 "scripts/ root is fixed" conclusion still holds. Found several de-facto
   pins undocumented in CONTRIBUTING (`dcr-cleanup-worker.ts`,
   `rls-cross-tenant-*`, `check-state-mutation-centralization.*`,
   `migrate-prf-per-credential-salt.sh`, `scripts/lib/*`, etc.).
2. **src/lib pins** — 10 pinned files re-validated; `password-generator.ts` is the
   weakest pin (stateless, 1 importer, no CI/CODEOWNERS coupling → movable);
   `load-env.ts`/`notification.ts` pin reasons inaccurate/under-documented.
3. **blast radius** — inventoried every surface that hardcodes a scripts/ or src/
   path; confirmed the codemod auto-rewrites src/scripts/e2e + check-bypass-rls +
   check-crypto-domains + vitest.config + workflows, but NOT
   CONTRIBUTING/CODEOWNERS/package.json/README/CLAUDE.md.

A fourth sweep extracted the exact refactor-tooling contract (verify-move-only-diff
ignores M/A/D; CONTRIBUTING+CODEOWNERS are in check-blame-ignore-revs
ALLOWED_MA_PATHS → a move-only PR may amend policy in the same commit; parallel
guard ⇒ one refactor/* PR at a time).

## Functionality Findings
- **F1 [Critical] — RESOLVED**: `move-and-rewrite-imports.mjs` rewrites only
  Import/Export declarations in moved files, NOT relative `vi.mock("./…")` calls →
  C6's two test files would mock non-existent paths after the move (false-green).
  Fix: C6 now mandates a pre-move conversion of relative `vi.mock` to `@/lib`
  alias in a separate prep commit, plus strengthened per-file verbose verification.
- **F2 [Major] — RESOLVED**: original diagnosis claim "`notification.ts` is in no
  allowlist" was wrong — it is at `check-bypass-rls.mjs:67`. C2 now *augments* the
  accurate "RLS-allowlisted" reason rather than replacing it.
- **F3 [Major] — RESOLVED**: `set-dcr-cleanup-worker-password.sh` (de-facto pin)
  added to C1 (peer of the documented `set-outbox-worker-password.sh`).
- **F4 [Minor] — RESOLVED (corrected in round 2)**: `load-env.ts` out-of-src
  importer count is **6** (2 e2e + 4 scripts), not 7 — `generate-env-example.ts`
  only mentions it in a comment.
- **F5/F6 [Minor] — RESOLVED**: `CLAUDE.md:455` references the moved path; added to
  C4 manual same-commit edits and the consumer walkthrough.

## Security Findings
- **S1 [Major] — RESOLVED**: new C3 CODEOWNERS gates would be unprotected by
  `check-codeowners-drift.mjs` (paths absent from ROSTER_GLOBS). C3 now requires
  adding each new path to ROSTER_GLOBS in the same Phase A PR (self-protecting).
- **S2 [Major] — RESOLVED**: `src/lib/proxy/**` (CSRF/session/CORS enforcement,
  the architectural centerpiece) was omitted from C3's boundary set → added.
- **S3 [Minor] — RESOLVED**: `pre-pr.sh:179` silently passes if
  `migrate-prf-per-credential-salt.sh` is absent (a move would silently disable a
  PRF read-only integrity check). C1 adds an optional hardening (exit 1) — verified
  safe (run_step logs the failure without aborting; the script is load-bearing, the
  "not present yet" comment is stale).
- **S4 [Minor] — RESOLVED**: `src/lib/security/**` (rate-limit, CSP, safe-href)
  added to C3.
- **No-gate-dropped invariant**: verified clean for all moves — `password-generator.ts`
  has no gate entries to orphan; `callback-url-basepath.test.ts` moving into
  `src/lib/auth/**` *gains* gate coverage; SEC-4 `env-allowlist.ts` is unmoved (SC1).

## Testing Findings
- **T1/T2/T4 [Major/Critical] — RESOLVED**: same root cause as F1. Round 2 further
  determined the exact `@/lib` alias targets (derived from `vault-context.tsx`'s
  real imports) and that `./crypto-emergency` is a **dead mock** (not imported by
  the subject) to be deleted, and `./webauthn-client` → `@/lib/auth/webauthn/webauthn-client`
  (two dirs deep). 4 of the current relative mocks already don't intercept
  (pre-existing) — conversion fixes them; verbose verification mandatory.
- **T5 [Major] — RESOLVED**: VEC3 corrected — C6 moves into `src/lib/auth/**` and
  `src/lib/vault/**`, which DO trigger `ci-integration.yml`. Documented.
- **T6 [Finding] — RESOLVED (verified SAFE)**: C5 deletion confirmed safe by
  assertion-by-assertion comparison (canonical `prisma/prisma-filters.test.ts`
  superset). Gate method named explicitly.
- **T7 [Finding] — RESOLVED (verified NOT redundant)**: root `validations.test.ts`
  holds unique aadVersion-boundary + passkey-share-link assertions → leave in
  place; merge tracked as a TODO. C7 reduced to investigate-only + TODO.
- **T8 [Confirmed safe]**: C4 test-pair, `--enforce-rename-parity`, mock alignment
  all clean. `password-generator.test.ts` has no `vi.mock` calls (C6's prep step
  does not apply to C4).

## Round 2 (incremental) Findings
- **NEW-F1 [Minor] — RESOLVED**: load-env count off-by-one (see F4) — fixed to 6.
- **NEW-F2 / T1-refinement [Major→folded] — RESOLVED**: exact vi.mock alias targets
  + dead-mock deletion (`crypto-emergency`) + deep webauthn path — folded into C6.
- **N1 [Minor] — RESOLVED**: dual `security-headers.ts` (proxy/ vs security/) naming
  collision noted in C3; both gated to the same owner, no conflict.

## Adjacent Findings
- (Security, round 1) the codemod-vs-vi.mock gap (F1) crosses into testing scope;
  routed to the testing expert (T1/T2/T4) — merged.

## Quality Warnings
None — all findings carried file:line evidence and concrete fixes.

## Resolution Status
All round-1 and round-2 findings resolved. No Skipped/Accepted/Out-of-scope
findings requiring Anti-Deferral entries (the only deferrals are first-class Scope
contract items SC1-SC5 in the plan, each with an owner/justification). Two TODOs
created for genuinely deferred follow-ups (CODEOWNERS gate re-eval for
notification.ts/redis.ts per SC4; validations.test.ts assertion merge per C7).

## Recurring Issue Check
### Functionality expert
- R1 N/A · R2 N/A · R3 ACTIVE→resolved (F1 vi.mock propagation; F3 pin omission;
  NEW-F1 count drift) · R7 ACTIVE→resolved (F1) · R17/R22 N/A · R19 resolved
  (C4 safe; C6 mock) · R25 N/A · R33 resolved (codemod covers workflows; C2 doc-only)
  · R35 N/A.
### Security expert
- R3 resolved (S1 ROSTER_GLOBS; S3 guard) · R14 N/A · R18 clean (no allowlist entry
  orphaned) · R31 clean (C5 deletes a test file, not security-state) · R33 clean
  (webhook-dispatcher/url-helpers grep -v not moved) · R34 resolved (S2 proxy/**)
  · R35 N/A · RS1-RS3 N/A · RS4 clean (no personal data; @ngc-shj is an owner handle).
### Testing expert
- R7 clean (no e2e reference to moved paths) · R16 N/A · R19 resolved (T1/T2 mock
  alignment) · R21 resolved (T4 strengthened verification) · R25 N/A · R33 resolved
  (T5 ci-integration trigger) · RT1 resolved (T1 mock-reality) · RT2-RT6 N/A/resolved.
