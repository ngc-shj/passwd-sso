# Plan Review: security-ci-guards-lexical-to-ast

Date: 2026-07-05
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings

- **F1 [Minor — implementer trap]** `matchesInCodeText` must use AST/scanner node ranges,
  never regex-based comment/string blanking. Empirically, a naive regex blanker false-flips
  3 real routes (`mcp/register`, `mobile/authorize`, `tenant/mcp-clients`) because an
  unpaired apostrophe in a comment (`user's tenant`) makes the string-blanking regex swallow
  the following real `tx.x.create(`. → **Reflected**: added "Hard rule" to blanking section +
  I-C3-3 apostrophe regression fixture.
- **F2 [Minor]** NF-R2 rationale misattributed (this vitest test runs in `app-ci` with prisma
  generate, not `static-checks`). → **Reflected**: NF-R2 rewritten with correct CI topology;
  `@prisma/client` ban reframed as hygiene, not CI gate.
- **F3 [Minor]** C1 forbidden-pattern list omitted line 299's `/failClosedOnRedisError:\s*true/.test(source)`
  regex form. → **Reflected**: added it to C1 forbidden patterns.
- Verified-correct (no finding): `hasCallWithObjectFlag` decomposition, `hasRealCall` vs
  imports, SSoT preservation, template `${expr}` visibility, NF-R4 intent.

## Security Findings

- **S1 [Critical]** NF-R4 fail-closed relies on ts-morph `createSourceFile` throwing on
  malformed source — it does NOT (recovering parser, verified). A syntax-broken route keeps
  its call nodes and passes guard1 green. → **Reflected**: NF-R4 + I-C1-4 rewritten to require
  explicit `sf.compilerNode.parseDiagnostics` check + throw; must NOT use `getPreEmitDiagnostics()`
  (Program/type resolution, NF-R2 violation). Added I-C3-4 throwing fixture. escalate: true.
- **S2 [High/Major]** guard1 overclaims: `createRateLimiter`-with-flag and `checkRateLimitOrFail`
  are checked as independent existence facts; nothing verifies the fail-closed limiter is the one
  the handler consumes — same dataflow residual class as guard3/SC1, but presented as fully closed.
  → **Reflected**: added `limiterFlagFlowsToChecker` (C1 signature + I-C1-5), wired into assertion 8b
  consumer walkthrough, added I-C3-6 decoy-limiter test. Chose to close it (a) rather than merely
  disclose (b), since the limiter is a same-file `const` and ts-morph is already the tool.
- **S3/S4 [Low, informational]** guard2 blanking direction correct; SC1 (guard3 scope-out) sound —
  "value was validated" is a genuine dataflow/branded-type property AST call-matching cannot close.
  No fix required.

## Testing Findings

- **T1 [High]** Same as F2 (NF-R2 CI topology wrong). → **Reflected** (shared fix).
- **T2/T4 [Medium]** Mutation proof was manual/reverted/non-committed → no durable regression guard
  for the PR's raison-d'être. → **Reflected**: promoted to committed I-C3-5 (exact comment-hidden-flag
  input → false); AC-C2-2 downgraded to optional sanity demo.
- **T3 [Medium]** C3 decoy set missing import-specifier / non-object-arg / multi-line cases.
  → **Reflected**: I-C3-1 (import decoy), I-C3-2 (c)(d) (non-object arg, multi-line).
- **T5 [Low]** "removing decoy flips result" is one-sided mutation proof for a boolean predicate.
  → **Reflected**: AC-C3-1 now requires both-direction mutation resistance.
- **T6 [Low]** guard2 blanking edge cases (regex literal, escaped backtick). → **Reflected**:
  I-C3-3 regex-literal + apostrophe cases; reuse `check-raw-sql-usage.mjs` span logic noted.
- **T7 [Low]** Parse-cache "measure and decide" is over-engineering (303 ms measured); shared
  mutable Project risks cross-test state. → **Reflected**: NF-R3 states no caching (YAGNI).
- **[Adjacent Low]** `next build` excludes test files → won't typecheck `ast-guards.ts`; real
  coverage is `tsc --noEmit`. → **Reflected**: testing-strategy gate corrected to typecheck.

## Adjacent Findings
- (Testing→Functionality) `next build` vs `typecheck` coverage of `ast-guards.ts` — reflected above.
- (Functionality→Testing) shared ts-morph pattern with `check-state-mutation-centralization.ts` —
  precedent cited in NF-R1; no duplication to eliminate (that script is a standalone CLI, not importable).

## Quality Warnings
None — all findings carried empirical evidence (live ts-morph probes, grep output, real route reads).

## Recurring Issue Check

### Functionality expert
- R1 (shared-util reimpl): checked — no pre-existing importable AST helper; `check-state-mutation-centralization.ts`
  is a standalone CLI. New `ast-guards.ts` justified.
- R2 (hardcoded constants): clean — callee names passed as args, guard2 regexes stay in `route-class-patterns.json` SSoT.
- R42 (member-set): PASS — independent grep reproduced the plan's set exactly (assertions 6,7,8b×5,8c);
  assertion 3 `METHOD_EXPORT_RE` correctly excluded (SC2). One enforcement-grep gap (F3) fixed.

### Security expert
- R42: partially — callee member-set complete, but the fail-closed *contract*-part set was under-enumerated
  at the dataflow grain (S2: two members, one closed). Fixed by adding `limiterFlagFlowsToChecker`.
- RS2 (fail-open posture): APPLIED — S1 (ts-morph fails open absent explicit diagnostics check).
- RS3 (dataflow vs existence): APPLIED — S2, S4 (validated-value-flow distinction).
- RS4 (secrets/logging): N/A — test layer, no secrets.
- RS5 (new blind spot): APPLIED — S1 is a new recovering-parser blind spot the lexical check lacked.

### Testing expert
- R42: PASS — re-derived member-set from code matches plan; assertion 6 correctly added over the memo's list.
- RT (mutation resistance, committed regression, shared-state, vacuous assertions): APPLIED — T2/T4/T5/T7.
- Precedent parity: helper is importable predicate (direct import + inline fixtures), correctly diverges from
  the CLI `--fixture`/exit-code precedent. No CI wiring change needed (runs in existing app-ci vitest).
- N/A: flaky-sleep, DB-mock, snapshot-drift, msw/fetch (no async/DB/snapshot/network in helper).
