# Code Review: null-tenant-gate-throw-only

Date: 2026-07-22
Review rounds: 2 (converged — Round 2: No findings)

## Origin

External reviewer findings against the null-tenant fail-open class closure (PR #693 line):

1. **Medium** — `check-null-tenant-fail-closed.mjs` `hasNullTenantThrowGuard()` accepted ANY
   `return` inside a null-tenant guard as fail-closed, so a future softening of
   `if (!tenant) throw` to `return []` / `return null` / `return { allowed: true }`
   would false-green CI. **CONFIRMED by mutation experiment** (all 3 shapes exit 0
   against the pre-fix gate).
2. **Low** — strictest lockout fallback could lock legitimate users during a transient
   DB outage; requested metrics/alerts, admin release path, and a regression test that
   the fallback is not cached. **Verified mostly implemented**: fallback is already
   non-cached on all three paths (`account-lockout.ts:87-93,108-118`) and observable
   via dedicated warn events (`vault.lockout.tenantRowMissing.usingStrictest`,
   `vault.lockout.thresholdsFetchFailed.usingStrictest`). Only the no-cache
   regression test was missing. Admin instant-release API is a new feature, out of
   scope per user decision (regression test only).

User decisions (AskUserQuestion):
- Gate fix: **throw-only** (all 8 real manifest throw-files throw; no return guard
  exists — denial-shaped-return AST allowlist deferred until an actual member needs it).
- Low scope: **regression test only**.

## Changes (initial fix)

- `scripts/checks/check-null-tenant-fail-closed.mjs` — throw-disposition guard body
  must contain a ThrowStatement (ReturnStatement acceptance removed); comments +
  violation message updated.
- `scripts/__tests__/check-null-tenant-fail-closed.test.mjs` — 3 negative `it.each`
  self-tests (`return []` / `return null` / `return { allowed: true }` → exit 1).
- `src/lib/auth/policy/account-lockout.test.ts` — regression test: strictest fallback
  is NOT cached; DB recovery restores the tenant's real thresholds
  (`findUnique` called twice, second call applies lenient policy).

All mutation-verified red before Round 1 (returns re-accepted → 3 tests fail;
fallback cached in catch branch → lockout test fails).

## Round 1 — Functionality Findings

- **F1 Minor** — gate comment "only `throw` proves fail-closed" overstates: throw in
  dead branch / swallowed by try/catch / nested callback still greens (pre-existing
  dominance residual, evasion-shaped). Fix: soften wording, record accepted residual.
- **F2 Minor [Adjacent→testing]** — no positive self-test pins the block-body throw
  shape all 8 real files use (converges with Testing F1).
- Edge-matrix verified: strict shrink of false-green surface, no new false-green /
  false-red. All 8 real guards block-throw ✓. Lockout test mock choreography correct.

## Round 1 — Security Findings

- **NT-SEC-1 Minor** — dominance-blind throw acceptance (dead-branch / swallowed /
  ordering / unreachable-closure) — pre-existing ACCEPTED residual per
  `project_null_tenant_fail_open_class` ("early-warning, not a proof").
- **NT-SEC-2 Minor (top)** — `hasPermissiveEnforcementCoalesce` only matched `??`;
  `||` and ternary lenient shapes green a failsafe-default file. Pre-existing but
  UNDOCUMENTED residual; `??`→`||` is a one-character ordinary edit. R42
  follow-through: fix `||` (2-line + red-proven test), ternary rides the
  accepted-residual umbrella with recorded disposition.
- **NT-SEC-3 [Adjacent→testing]** — negative it.each cases cannot distinguish
  over-tight regression from correct rejection; existing positive control mitigates.
- Verified sound: strict tightening; inverted-guard/ternary guard shapes fail-closed
  at gate level (probed); gate wired (pre-pr.sh:195, ci.yml static-checks,
  vitest.config includes self-test, check-gate-selftest-coverage meta-gate).

## Round 1 — Testing Findings

- **F1 Major** — no positive self-test fixture for block-body throw guard; the
  surviving descendants clause of the just-edited expression is unpinned (RT7
  green-on-real-shapes gap). Perspective convergence with Functionality F2 →
  severity floor Major.
- **F2 Minor** — `during!`/`after!` dereferenced without preceding
  `expect(x).not.toBeNull()`, diverging from sibling convention.
- Independent RT7 red-direction re-verification performed by the expert (both new
  tests; mutations restored, residue-checked). CI inclusion confirmed. Parse-failure
  false-pass ruled out.

## Merged Findings (Round 1)

| ID | Sev | Summary | Source |
|---|---|---|---|
| M1 | Major | Block-body throw positive self-test missing (RT7 green-on-real-shapes) | Test F1 + Func F2 (convergence) |
| M2 | Minor | Gate comment overstates guarantee (dominance residual undocumented) | Func F1 + Sec NT-SEC-1 |
| M3 | Minor | Coalesce check misses `\|\|` (undocumented residual, one-char edit) | Sec NT-SEC-2 |
| M4 | Minor | `!` dereference without `not.toBeNull()` | Test F2 |
| M5 | info | Negative tests can't distinguish over-tight regression | Sec NT-SEC-3 (resolved by M1 fix) |

## Resolution Status

### M1 [Major] Block-body throw positive self-test missing
- Action: `THROW_SRC` baseline fixture converted to block body with a statement
  before the throw (pins descendants clause on every green-path run); added
  dedicated positive test "accepts a bare (unbraced) `if (!tenant) throw` guard"
  (pins direct-kind clause). Mutation-verified: dropping the descendants clause →
  4 tests red; restore → 15 pass.
- Modified file: `scripts/__tests__/check-null-tenant-fail-closed.test.mjs:49-67,120-136`

### M2 [Minor] Comment overstates guarantee
- Action: reworded to "a `throw` in the guard body is the accepted signal" with an
  explicit accepted-residual paragraph (dead branch / try-swallowed / nested
  callback = deliberate evasion, out of the gate's anti-regression threat model;
  covered by review + mutation-verified unit tests over the real files).
- Modified file: `scripts/checks/check-null-tenant-fail-closed.mjs` (guard comment)

### M3 [Minor] Coalesce check misses `||`
- Action: `LENIENT_FALLBACK_TOKENS` set accepts `??` and `||`; ternary recorded as
  accepted residual in the same comment (not reachable by one-character edit;
  runtime pinned by mutation-verified unit tests); violation message mentions both
  operators; red-proven self-test added (`|| 5` in a failsafe file → exit 1;
  mutation reverting to `??`-only → that test fails). Real-repo gate remains green
  (no false-red on the 16 live reads).
- Modified file: `scripts/checks/check-null-tenant-fail-closed.mjs`,
  `scripts/__tests__/check-null-tenant-fail-closed.test.mjs`

### M4 [Minor] `!` dereference without null assertion
- Action: `expect(during).not.toBeNull()` / `expect(after).not.toBeNull()` inserted
  before the `!` dereferences, matching sibling-test convention.
- Modified file: `src/lib/auth/policy/account-lockout.test.ts`

### M5 [info] Over-tight-regression indistinguishability
- Action: resolved by the M1 positive controls (block-body baseline + bare-throw
  positive) — an over-tight check now reds the positives.

### NT-SEC-1 [Minor] Dominance-blind residual — Accepted (pre-existing)
- Anti-Deferral check: **Accepted residual.** Worst case: a deliberately-evasive
  edit (dead-branch throw / try-swallow) greens the gate while being fail-open.
  Likelihood: low — requires intentional authorship in a human-reviewed codebase;
  ordinary refactors hit the tightened checks. Cost-to-fix: control-flow dominance
  analysis (high). Mitigation: mutation-verified unit tests over every real member
  pin runtime behavior; residual now DOCUMENTED in the gate comment (M2 fix) and in
  `project_null_tenant_fail_open_class`. Consistent with the previously-approved
  disposition of the same residual.

### Ternary lenient fallback — Accepted (recorded per NT-SEC-2 recommendation)
- Anti-Deferral check: **Accepted residual.** Worst case: `tenant ? tenant.x :
  lenient` in a failsafe file greens the gate. Likelihood: low — not reachable by a
  one-character edit, unlike `??`→`||` (now closed). Cost-to-fix: ternary AST case
  (~10 lines) with whichever-branch-is-lenient heuristics (false-red prone).
  Mitigation: runtime behavior pinned by mutation-verified unit tests over both
  failsafe files; disposition recorded in the gate comment.

## Verification (Round 1 fixes)

- `node scripts/checks/check-null-tenant-fail-closed.mjs` → exit 0 (16 reads)
- Self-test suite: 15/15; lockout suite: 37/37
- RT7 mutations: drop-descendants-clause → 4 red; re-accept-returns → 3 red;
  revert-`||` → 1 red; all restored, gate file byte-identical to backup, residue
  check clean (3 intended modified files only)
- Full suite: 967 files / 12,809 tests pass (1 skipped)
- pre-pr: 52/52 pass

## Environment Verification Report

N/A — no environment constraints declared (no Phase 1; external-review-driven fix).
All verification `verified-local` (commands cited above); CI re-runs the same gates
(static-checks runs the gate via pre-pr.sh; vitest includes both test files).

## Round 2 (incremental — No findings)

All Round 1 fixes verified RESOLVED by an independent reviewer pass:

- **M1**: both acceptance clauses now independently pinned — dropping the
  descendants clause reds 4 tests; dropping the direct-kind clause reds 2 tests
  (bare-throw + Promise.all fixtures; `getDescendantsOfKind` excludes self, so the
  direct-kind clause is genuinely load-bearing). `console.error` in the fixture
  collides with no checker heuristic.
- **M2**: comment claims verified against implementation — the IfStatement
  descendant scan has no reachability analysis, so the documented residual shapes
  green exactly as stated.
- **M3**: `??`-only revert reds only the new `||` test; `||`-only reds only the
  original `??` test (independent failure). False-red audit across all 16 manifest
  files: the coalesce check runs only for the 2 failsafe files; account-lockout.ts
  has one `||` with no enforcement-field left operand; session-timeout.ts has zero
  `??`/`||`; display-exempt / throw files are never coalesce-checked. Bonus: the
  extension now protects the plausible future `|| lenient` edit at
  `session-timeout.ts:112`.
- **M4**: null guards present; return type `RecordFailureResult | null` warrants
  them.
- **R43**: none — M3 strictly tightens (superset token set), M1/M4 test-only,
  M2 comment-only; every pre-existing rejection test still passes.
- **RT7**: every clause added/changed is mutation-proven red and restored green.

Observed (not a finding): the coalesce check flags any `??`/`||` on an enforcement
field in a failsafe file regardless of the right operand's strictness (a
`|| STRICTEST` would also red). Pre-existing Round-1 design ("returns a restrictive
default some other way"); both real files comply.

Termination: all experts No findings at Round 2 → converged.
