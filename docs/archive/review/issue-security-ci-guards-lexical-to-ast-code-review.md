# Code Review: security-ci-guards-lexical-to-ast

Date: 2026-07-05
Review rounds: 2 (Round 1 findings → fixed; Round 2 CONVERGED)

## Changes from Previous Round
Initial code review (Round 1) on the committed AST-guards implementation, then
Round 2 verification of the two fixes (mandatory: security-boundary edits).

## Functionality Findings

- **F1 [Major → fixed]** `limiterFlagFlowsToChecker` resolved the `limiter:` identifier
  by matching ANY same-name `VariableDeclaration` in the file (`.some(decl => decl.getName() === name)`),
  not the scoped binding. A flagless *consumed* `const rateLimiter` plus an unrelated
  fail-closed `const rateLimiter` in another scope returned `true` — reopening a narrower
  form of the S2 dataflow gap. Empirically reproduced by both functionality and security
  experts independently. Zero impact today (all 10 routes have one module-scope const).
  → **Fixed** in 4b8bd0fd: resolve via `getSymbol()?.getValueDeclaration()` (scope-aware,
  no Program needed — empirically confirmed to work with the Prisma client hidden).
  Committed shadowing regression test (mutation-verified: old logic returns true).

- **F2 [Minor → fixed]** = S2 (fail-open on parseDiagnostics absence). See Security.

Non-findings verified clean: comment-range dedup (`seen` Set), StringLiteral inside `${}`
stays blanked while interpolation code visible, char-by-char blanking preserves newline
count / multiline anchoring, `calleeName` property-access tail correct for all real forms,
same-file single-const resolution sufficient, behavior parity old→new (zero manifest edits).

## Security Findings

- **S1 [Low → fixed]** = F1 (scope-aware resolution). RS3 dataflow-vs-existence at a finer
  grain. escalate: false.

- **S2 [Low → fixed]** `parseRouteSource` fail-closed guard was `if (diagnostics && diagnostics.length > 0) throw`.
  If a future ts-morph/TS drops the `@internal parseDiagnostics` field, `diagnostics` is
  `undefined`, the throw never fires, and malformed source passes silently — the exact
  fail-open NF-R4 exists to prevent. RS2. escalate: false.
  → **Fixed** in 4b8bd0fd: `if (!Array.isArray(diagnostics) || diagnostics.length > 0) throw`
  — absence of the diagnostics channel is itself treated as a parse failure.

Verified clean: no aliased/re-exported imports of the guarded symbols in maintenance/admin
routes; unhandled `limiter:` forms (spread, function-return, property-access) all return
`false` (fail-closed); `${}` interpolation stays visible (real `tx.x.delete(` still matches);
two-tier delegated-write floor unchanged, not widened; guard1 is strictly stronger than the
old five independent `source.includes`/`.test(source)` existence checks.

## Testing Findings

**No findings.** All 4 boolean helpers verified mutation-resistant in BOTH directions
(positive case kills const-false, decoy kills const-true) — verified by executing fixtures,
not reading assertions. I-C3-5 committed gap-closure proof present and unique (the only test
with a comment-hidden `failClosedOnRedisError: true` + real call). I-C3-4 fixture genuinely
unparseable (parseDiagnostics.length=2). Shared module-level Project + fixed `"test.ts"`
virtualPath with `overwrite:true` proven leak-free. Zero manifest edits confirmed. All
helper branches (inline-call + variable-binding for limiter flow; StringLiteral /
NoSubstitutionTemplateLiteral / TemplateHead-Middle-Tail / regex-literal for blanking) covered.

## Round 2 Verification
CONVERGED. Both fixes correct-and-complete. Key new risk (getSymbol requiring a Program that
fails without prisma generate) empirically CLEARED: with `node_modules/.prisma/client` hidden,
`getSymbol()` on a same-file local identifier resolves correctly and the full suite passes —
`skipFileDependencyResolution: true` + in-memory FS isolate it. `let`-reassignment not followed
(fail-closed-leaning, zero routes affected) — non-blocking pre-existing property of a syntactic guard.

## Adjacent Findings
Both F1/S1 and F2/S2 were flagged independently by two experts (functionality + security) —
strong triangulation signal. Merged; fixed once.

## Quality Warnings
None — every finding carried empirical evidence (ts-morph probes, reproduced decoys, real route reads).

## Recurring Issue Check

### Functionality expert
- R1 (reuse): ts-morph reused (precedent check-state-mutation-centralization.ts); no duplication.
- R2 (constants): N/A — regexes stay in route-class-patterns.json SSoT.
- R42 (member-set): all 4 guard1 callees + both guard2 regexes upgraded incl. assertion 6
  (memo named only 7). F1 was the same class at finer grain (name-match vs. resolution) — fixed.

### Security expert
- RS2 (fail-open): S2 — flagged and fixed (diagnostics-absence now fail-closed).
- RS3 (dataflow-vs-existence): S1 — flagged and fixed (scope resolution not name existence).
- R42: all 10 operatorGated:true routes enumerated from manifest, each uses the handled form.

### Testing expert
- RT (mutation-resistance): both directions for all 4 helpers, empirically executed.
- Shared-state: module-level Project + fixed virtualPath proven leak-free via overwrite:true.
- R42: member-set fully upgraded; no surviving lexical `source.includes(`/`.test(source)` for guarded callees.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1 (all guards run local + app-ci vitest,
no external service). The one runtime-environment concern (getSymbol vs. no-prisma-generate)
was raised and empirically cleared in Round 2 — classified `verified-local` (Prisma-client-hidden re-run passed).

## Resolution Status

### F1/S1 [Major/Low] limiterFlagFlowsToChecker name-match not scope resolution — Fixed
- Action: replaced whole-file name-match with `getSymbol()?.getValueDeclaration()` scope resolution.
- Modified file: src/__tests__/proxy/ast-guards.ts (limiterFlagFlowsToChecker identifier branch)
- Test: src/__tests__/proxy/ast-guards.test.ts (shadowing decoy, mutation-verified)

### F2/S2 [Minor/Low] parseDiagnostics absence fails open — Fixed
- Action: treat non-array/absent diagnostics as a parse failure (throw).
- Modified file: src/__tests__/proxy/ast-guards.ts (parseRouteSource)
