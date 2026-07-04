# Plan: Promote route-policy security CI guards from lexical to AST matching

## Project context

- **Type**: web app (Next.js) — this change touches only the **CI guard / test layer**, no runtime/product code.
- **Test infrastructure**: unit + integration + E2E + CI/CD. The guards under change ARE tests (vitest `route-policy-manifest.test.ts`) and CI scripts.
- **Verification environment constraints**: none. Every guard runs in local `npx vitest run` and in the `app-ci` CI job (vitest, prisma generated — see NF-R2) with no external service, DB, or network dependency. All acceptance paths are `verifiable-local`.

## Objective

Eliminate the **false-negative (guard-strength) gap** in the operator-gated route
security assertions of `src/__tests__/proxy/route-policy-manifest.test.ts`, by
replacing `source.includes(...)` / `regex.test(source)` lexical matching with
AST-aware matching that asserts a **real call expression / argument** rather than
mere token presence.

Two guards are in scope (per user decision "guard1 + guard2 in this PR"):

- **guard1** — assertion 8b/8c: operator-gated routes must carry a real
  fail-closed rate-limit call, not a token that could sit in a comment / unused
  import / unrelated call.
- **guard2** — assertion 6 (`destructive` ⇔ `DELETE_SIGNAL`) and assertion 7
  (`sideEffectingGet` floor ⇔ `WRITE_PRIMITIVE`): the write-primitive / delete-signal
  regexes currently match anywhere in source text, including comments and string
  literals.

guard3 (raw-SQL `// raw-sql-ident:` marker) is **out of scope** — see SC1.

**No runtime vulnerability is being fixed.** The runtime is correct in every case
today (verified: all 10 operator-gated routes carry the real calls; #634 already
merged). This is a detection-strength upgrade so a *future* regression that hides
a required call in a comment/string cannot pass green.

## Requirements

### Functional
- F-R1: assertion 8b passes iff each `operatorGated:true` route file contains, as
  **real call expressions**, all of: `verifyAdminToken(...)`,
  `requireMaintenanceOperator(...)`, `createRateLimiter({ ... failClosedOnRedisError: true ... })`,
  `checkRateLimitOrFail(...)`. The `failClosedOnRedisError: true` must be a real
  object-literal property of the argument to a real `createRateLimiter` call — NOT
  a bare regex over the whole file.
- F-R2: assertion 8c passes iff every route file that contains a **real call** to
  `requireMaintenanceOperator(...)` is declared `operatorGated:true`. A commented-out
  or string-literal occurrence must NOT trigger the reverse-drift requirement.
- F-R3: assertion 6 (`destructive`) and assertion 7 (`sideEffectingGet`) evaluate
  their `DELETE_SIGNAL` / `WRITE_PRIMITIVE` patterns against **code text only**
  (comments and string-literal contents excluded), preserving the existing
  documented two-tier floor (delegated writes via imported service functions are
  still not detected — that is a separate, already-accepted heuristic ceiling).
- F-R4: the shared `route-class-patterns.json` regexes remain the single source of
  truth for guard2. The AST upgrade changes *where* the regex is applied (code
  text only), NOT the regex itself — so the `.sh` check and the vitest test still
  cannot drift on the pattern definition.

### Non-functional
- NF-R1: no new npm dependency. Use `ts-morph@28.0.0` (already in `dependencies`)
  and `typescript@5.9.3` — both installed. Precedent: `scripts/check-state-mutation-centralization.ts`.
- NF-R2: **CI topology (corrected per review T1/F2)** — `route-policy-manifest.test.ts`
  is a **vitest** test. It runs in the **`app-ci`** CI job (`.github/workflows/ci.yml`,
  `npm run test:coverage`) which DOES run `npx prisma generate` first — NOT in the
  `static-checks` job (which runs `PRE_PR_STATIC_ONLY=1` and skips vitest entirely,
  `scripts/pre-pr.sh:~493`). Therefore the generated Prisma client IS available at test
  time; the memory note `project_static_check_ci_no_prisma_generate` applies to `.mjs`/`.tsx`
  guards invoked directly by `pre-pr.sh` static mode, NOT to this vitest test.
  The AST helper still MUST NOT import `@prisma/client` — but for **hygiene/speed**
  (the helper only inspects syntactic call/object shape; no type info is needed), NOT
  as a CI-failure-avoidance gate. It parses route source as text via a ts-morph
  `Project` created with `{ useInMemoryFileSystem: true, skipFileDependencyResolution: true }`
  so a route file that itself `import`s `@prisma/client` needs no generated client to parse
  (verified: parsing does not resolve imports).
- NF-R3: parsing all ~212 route files is cheap — measured ~137 ms for a single
  parse-all pass, ~303 ms for 4 passes (once per assertion). This is within the existing
  suite's budget; **no caching is required (YAGNI)**. Parse per-file with a fresh
  `SourceFile`. If a module-level `Project` is reused for speed, files MUST be added
  with `{ overwrite: true }` and keyed by repo-relative virtual path, and the helper
  MUST NOT leak state across calls (each call operates on exactly the file it parsed) —
  a shared mutable `Project` is per-test state and must not violate "each test starts clean".
- NF-R4: fail-closed **(corrected per review S1 — critical)**. ts-morph is a *recovering*
  parser: `Project.createSourceFile(...)` does **NOT throw** on malformed source (verified
  empirically — it returns a partial AST, and call nodes surrounding a syntax error survive).
  Therefore fail-closed cannot rely on a parse throw. `parseRouteSource` MUST explicitly
  inspect `sf.compilerNode.parseDiagnostics` (populated by the **parser**, no Program/type
  resolution needed — verified it returns >0 for broken source WITHOUT a Program) and
  `throw` when `length > 0`. It MUST NOT use `getPreEmitDiagnostics()` — that requires a
  Program and would pull type resolution / generated types, violating NF-R2. A route file
  the parser rejects surfaces as a **test failure**, never a silent green.

## Technical approach

### Shared AST helper

Create `src/__tests__/proxy/ast-guards.ts` (test-support module, colocated with the
consuming test; NOT under `src/lib` because it is test-only and pulls `ts-morph`).

It exposes pure functions over a single route file's source text:

- `parseRouteSource(source: string, virtualPath: string): SourceFile` — parse one
  file into a ts-morph `SourceFile` via an in-memory `Project`
  (`{ useInMemoryFileSystem: true, skipFileDependencyResolution: true }`). No tsconfig,
  no dependency resolution. **After parsing, if `sf.compilerNode.parseDiagnostics.length > 0`,
  `throw`** (NF-R4 fail-closed — ts-morph does not throw on its own). No try/catch that
  returns a default anywhere on this path.
- `hasRealCall(sf: SourceFile, calleeName: string): boolean` — true iff the file
  contains a `CallExpression` whose callee is an identifier (or property-access tail)
  named `calleeName`. Excludes occurrences inside comments/strings AND import
  specifiers by construction (the AST has no `CallExpression` node for those).
- `hasCallWithObjectFlag(sf: SourceFile, calleeName: string, flag: string, value: boolean): boolean`
  — true iff some `CallExpression` to `calleeName` has a first argument that is an
  `ObjectLiteralExpression` containing a `PropertyAssignment` named `flag` whose
  initializer is the boolean literal `value`. Returns `false` when the first arg is not
  an object literal (e.g. `createRateLimiter(config)` with a variable) — the flag cannot
  be proven, so guard1 fails closed for that route.
- `limiterFlagFlowsToChecker(sf: SourceFile): boolean` **(new per review S2 — closes the
  dataflow residual)** — true iff the object passed as the `limiter:` property to a real
  `checkRateLimitOrFail({ ... })` call resolves, **within the same file**, to a
  `const <id> = createRateLimiter({ ... failClosedOnRedisError: true ... })` binding.
  This links the fail-closed limiter to the limiter the handler actually consumes,
  rather than checking `createRateLimiter`-with-flag and `checkRateLimitOrFail` as two
  independent existence facts. Same-file `const` lookback only (no Program, mirrors
  `check-raw-sql-usage.mjs`'s variable-lookback approach). If `checkRateLimitOrFail`'s
  `limiter:` arg is an inline `createRateLimiter({...})` call expression (not a variable),
  match its flag directly. Closes the guard1 analogue of guard3's "validator exists vs.
  validator guards THIS value" gap.
- `matchesInCodeText(sf: SourceFile, re: RegExp): boolean` — applies `re` to the
  file's text **with comment ranges and string/template-literal contents blanked
  out**, so guard2 keeps using the shared regex but only over real code. Rationale
  for keeping regex (not full call-node matching) for guard2: `WRITE_PRIMITIVE` /
  `DELETE_SIGNAL` are deliberately broad member-set re-derivations (`prisma.X.create(`,
  `$executeRaw`, `consume*(`, model-specific deletes) sourced from
  `route-class-patterns.json`; re-expressing them as structural AST matchers would
  (a) fork the SSoT the `.sh` check depends on and (b) risk missing a member the
  regex catches. Blanking comments+strings is the minimal, sufficient fix for the
  stated lexical gap. This is the "enumerate A's implicit constraints before
  replacing A" discipline: the regex's constraint is "stays byte-identical to the
  `.sh` check's pattern" — preserved by keeping the regex and only changing its input.

### Comment/string blanking (guard2)

**Hard rule (per review F1 — implementer trap):** comment and string ranges MUST be
obtained from **ts-morph AST nodes / TS scanner comment ranges** — NEVER from independent
regex passes over the text. A naive regex blanker (blank `/* */`, then `//`, then
`'...'`/`"..."` as separate passes) was empirically shown to false-flip ≥3 real routes
(`mcp/register`, `mobile/authorize`, `tenant/mcp-clients`): an unpaired apostrophe inside
a comment (`iOS app's`, `user's tenant`) makes the string-blanking regex swallow the
following real `tx.x.create(`/`deleteMany(` line, re-opening the false-negative. AST node
ranges avoid this by construction.

`matchesInCodeText` walks the SourceFile once:
- Collect comment ranges via the TS scanner / ts-morph comment-range APIs (node-anchored,
  not regex).
- Collect `StringLiteral`, `NoSubstitutionTemplateLiteral`, and template-literal
  **text spans** (`TemplateHead`/`TemplateMiddle`/`TemplateTail` fixed text) by node range —
  the `${expr}` interpolation code stays visible, since an interpolated `prisma.x.delete(`
  IS real executed code (fail-secure toward detection). Regex-literal bodies (`/prisma\.x\.delete\(/`)
  are code and stay visible (they are not StringLiteral nodes).
- Replace those ranges' characters with spaces (char-for-char, preserving offsets and line
  numbers so multi-line regex behavior and any diagnostic stay correct), then run
  `re.test(blanked)`.
- Precedent: `check-raw-sql-usage.mjs:158-188` already solves the template-literal span
  problem (brace-depth-aware); reuse that conceptual approach rather than re-deriving it.

### Integration into the test file

`route-policy-manifest.test.ts` currently reads each route's source with
`readFileSync` and applies `source.includes(...)` / `RE.test(source)`. Rewrite
assertions 6, 7, 8b, 8c to parse the source once per file into a `SourceFile` and
call the helper functions. `readFileSync` still supplies the raw text to the parser.

## Contracts

### C1 — AST helper module `src/__tests__/proxy/ast-guards.ts`

- **Signatures** (no bodies):
  - `export function parseRouteSource(source: string, virtualPath: string): SourceFile`
  - `export function hasRealCall(sf: SourceFile, calleeName: string): boolean`
  - `export function hasCallWithObjectFlag(sf: SourceFile, calleeName: string, flag: string, value: boolean): boolean`
  - `export function limiterFlagFlowsToChecker(sf: SourceFile): boolean` (S2)
  - `export function matchesInCodeText(sf: SourceFile, re: RegExp): boolean`
- **Invariants** (all app-enforced — these are test-support functions, no storage layer):
  - I-C1-1: `hasRealCall` / `hasCallWithObjectFlag` return `false` for any occurrence
    of `calleeName` that is inside a comment or a string/template-text span (there is
    no CallExpression node for such text). **Member-set of "callees checked by guard1"**:
    derived from assertion 8b/8c source =
    `grep -oE '(verifyAdminToken|requireMaintenanceOperator|createRateLimiter|checkRateLimitOrFail)\(' src/__tests__/proxy/route-policy-manifest.test.ts | sort -u`
    → { verifyAdminToken, requireMaintenanceOperator, createRateLimiter, checkRateLimitOrFail }.
    All four must route through `hasRealCall` (or `hasCallWithObjectFlag` for
    createRateLimiter). No lexical `source.includes(` for these four survives in the diff.
  - I-C1-2: `hasCallWithObjectFlag(sf, "createRateLimiter", "failClosedOnRedisError", true)`
    returns `true` for the module-scope `const rateLimiter = createRateLimiter({ ..., failClosedOnRedisError: true })`
    form (the real form in all 10 routes) and `false` when the property is absent,
    is `false`, or when `failClosedOnRedisError: true` appears only in a comment or a
    *different* call's argument.
  - I-C1-3: `matchesInCodeText` yields identical results to the old
    `RE.test(source)` for all current route files (no false-negative regression on
    real code), while returning `false` for a synthetic file whose only match is
    inside a comment or string literal.
  - I-C1-4 (parse fail-closed, NF-R4): ts-morph does NOT throw on malformed source
    (recovering parser — verified). `parseRouteSource` MUST inspect
    `sf.compilerNode.parseDiagnostics` and throw when non-empty; the calling test
    surfaces it as a failure (never a silent pass). A truncated/garbage-source fixture
    that MUST throw is a C3 test case (I-C3-4), NOT just a prose invariant.
  - I-C1-5 (S2 dataflow link): `limiterFlagFlowsToChecker` returns `false` for a file
    where a decoy `const decoy = createRateLimiter({ failClosedOnRedisError: true })`
    exists but `checkRateLimitOrFail({ limiter: otherLimiter })` consumes a *different*
    limiter lacking the flag; returns `true` for all 10 real routes where the same
    `const rateLimiter` flows into `checkRateLimitOrFail`'s `limiter:`.
- **Forbidden patterns** (checked in Phase 2-4 grep):
  - pattern: `source\.includes\("(verifyAdminToken|requireMaintenanceOperator|createRateLimiter|checkRateLimitOrFail)\(` — reason: guard1 callee must go through AST, not lexical includes.
  - pattern: `/failClosedOnRedisError:\\s*true/\.test\(source\)` (F3) — reason: the flag
    check must go through `hasCallWithObjectFlag` (real object-literal property of a real
    createRateLimiter call), not a whole-file regex. This completes the guard1 member-set
    enforcement (previously only C2's `.test(source)` ban covered it).
  - pattern: `from "@prisma/client"` in `ast-guards.ts` — reason: hygiene/speed (NF-R2,
    corrected) — the helper needs no type info; keep it dependency-free.
- **Acceptance criteria**:
  - AC-C1-1: unit tests for the helper (see C3) pass, covering each invariant with a
    positive case AND a comment/string-decoy negative case.
  - AC-C1-2: helper imports only from `ts-morph` and `node:*` — no `@/` app imports,
    no `@prisma/client` (hygiene, not a CI gate — NF-R2 corrected).
- **Consumer-flow walkthrough** (the helper's output shape is consumed by the test):
  - Consumer `route-policy-manifest.test.ts` (assertion 8b) reads the booleans from
    `hasRealCall(sf, "verifyAdminToken")`, `hasRealCall(sf, "requireMaintenanceOperator")`,
    `hasCallWithObjectFlag(sf, "createRateLimiter", "failClosedOnRedisError", true)`,
    `hasRealCall(sf, "checkRateLimitOrFail")`, AND `limiterFlagFlowsToChecker(sf)` (S2)
    and pushes a violation string when any is `false`. It uses only the boolean — no
    other field. Satisfiable from the signatures.
  - Consumer assertion 8c reads `hasRealCall(sf, "requireMaintenanceOperator")` and
    cross-checks `manifest.routes[path].operatorGated === true`. Boolean only.
  - Consumer assertions 6/7 read `matchesInCodeText(sf, DELETE_SIGNAL)` /
    `matchesInCodeText(sf, WRITE_PRIMITIVE)` in place of `RE.test(source)`. Boolean only.

### C2 — rewrite assertions 6, 7, 8b, 8c in `route-policy-manifest.test.ts`

- **Signatures**: no new exports; the four `it(...)` blocks change their body to call
  C1 helpers. `parseRouteSource(source, repoRelPath)` per file per assertion — no caching
  (NF-R3: ~303 ms total, YAGNI).
- **Invariants** (app-enforced):
  - I-C2-1: assertion 8b/8c behavior is **unchanged for all current routes** — the
    same 10 routes pass 8b, the same reverse-drift set passes 8c. Only the *detection
    mechanism* changes. Verified by the suite staying green with zero manifest edits.
  - I-C2-2: assertion 6/7 pass/fail decisions are **unchanged for all current routes**
    (I-C1-3). The two-tier delegated-write floor documented in the file header remains
    accurate — update the header comment only if wording implies pure-lexical matching.
  - I-C2-3 (R42 member-set): the class "lexical security guards in this file" =
    { assertion 6 (DELETE_SIGNAL), assertion 7 (WRITE_PRIMITIVE), assertion 8b
    (4 includes + failClosedOnRedisError regex), assertion 8c (1 includes) }. Derived by
    `grep -nE 'source\.includes\(|\.test\(source\)' src/__tests__/proxy/route-policy-manifest.test.ts`.
    ALL members in this set are upgraded — assertion 6 is included even though the
    issue memo named only assertion 7, because it is the identical `DELETE_SIGNAL.test(source)`
    lexical pattern (member-set derived from code, not from the memo's list).
- **Forbidden patterns**:
  - pattern: `\.test\(source\)` in the four rewritten assertions — reason: guard2 must
    apply patterns via `matchesInCodeText`, not raw source. (assertion 3's
    `METHOD_EXPORT_RE` over source is a DIFFERENT concern — export extraction, not a
    security-value guard — and is explicitly NOT in this member-set; it stays as-is.
    See SC2.)
  - pattern: `source\.includes\(` for the guard1 callees (per C1 forbidden list).
- **Acceptance criteria**:
  - AC-C2-1: `npx vitest run src/__tests__/proxy/route-policy-manifest.test.ts` green,
    zero edits to `route-policy-manifest.json` or `route-class-patterns.json`. This
    zero-manifest-edit gate is **blocking, not advisory** — a forced manifest edit means
    behavior changed (a bug in this PR).
  - AC-C2-2 (T2/T4 — corrected): the mutation proof that the gap is closed is a
    **committed permanent test in C3** (I-C3-5), NOT a manual reverted injection. An
    optional one-time manual comment-injection MAY be run as a sanity demo but is not the
    load-bearing artifact — the committed C3 decoy is.

### C3 — unit tests for the AST helper `src/__tests__/proxy/ast-guards.test.ts`

- **Signatures**: vitest `describe`/`it` blocks; no product exports.
- **Invariants**:
  - I-C3-1: each helper function has ≥1 positive case and ≥1 comment-decoy and ≥1
    string-literal-decoy negative case, using inline source strings (no filesystem).
    For `hasRealCall`, additionally an **import-specifier-only decoy**
    (`import { createRateLimiter } from "..."` with no call → `false`) — the case most
    likely to regress if the impl is "optimized" to a name-only search (T3).
  - I-C3-2: `hasCallWithObjectFlag` has cases: (a) `failClosedOnRedisError: false` → `false`;
    (b) flag on a *different* call than `createRateLimiter` → `false`; (c) first arg is a
    **variable, not an object literal** (`createRateLimiter(config)`) → `false` (T3);
    (d) **multi-line / reformatted** object literal
    (`createRateLimiter({\n  failClosedOnRedisError:\n  true,\n})`) → `true` (T3).
  - I-C3-3: `matchesInCodeText` has cases: pattern matches only inside a template-literal
    fixed-text span (→ `false`); matches inside a `${...}` interpolation expression
    (→ `true`, real code); matches inside a **regex literal body** `/tx\.x\.delete\(/`
    (→ `true`, real code, not a string node) (T6); a **comment apostrophe regression
    fixture** — `// the user's tenant` immediately before a real `tx.mcpClient.create(`
    must still match (→ `true`), guarding the F1 false-flip (T6/F1).
  - I-C3-4 (S1 fail-closed): `parseRouteSource` on a **truncated/garbage source** throws
    (not returns) — asserted with `expect(() => parseRouteSource(garbage, "x.ts")).toThrow()`.
  - I-C3-5 (T2/T4 — the load-bearing gap-closure proof, committed permanently):
    `hasCallWithObjectFlag(parseRouteSource('const r = createRateLimiter({ prefix: "x" });\n// failClosedOnRedisError: true', "x.ts"), "createRateLimiter", "failClosedOnRedisError", true)`
    returns **`false`**. This exact input passed the OLD `/failClosedOnRedisError:\s*true/.test(source)`
    (matched the comment) and MUST fail the new check — the permanent regression guard that
    replaces manual AC-C2-2.
  - I-C3-6 (S2): `limiterFlagFlowsToChecker` has a decoy-limiter negative case
    (per I-C1-5) and a real-flow positive case.
- **Forbidden patterns**: none specific.
- **Acceptance criteria**: AC-C3-1: `npx vitest run src/__tests__/proxy/ast-guards.test.ts` green;
  mutation-resistant in **both directions** per boolean helper (T5): each function has a
  positive case that fails if the function is mutated to constant-`false`, AND a decoy
  case that fails if mutated to constant-`true`. Decoy-flip alone is insufficient.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | AST helper module `ast-guards.ts` (parse-fail-closed + 4 matchers incl. limiter-flow) | locked |
| C2 | Rewrite assertions 6/7/8b/8c to use the helper | locked |
| C3 | Unit tests for the AST helper (decoy negatives + committed gap-closure proof) | locked |

## Testing strategy

- **Helper unit tests (C3)**: inline-source, decoy-driven — the core proof that the
  AST layer closes the lexical gap. Each negative case is a comment/string that the
  OLD lexical check would have accepted.
- **Manifest parity suite (C2)**: must stay green with zero manifest/pattern edits —
  proves behavior-preservation for all real routes (I-C2-1, I-C2-2).
- **Committed gap-closure proof (I-C3-5)**: the permanent regression test proving a
  comment-hidden `failClosedOnRedisError: true` no longer satisfies guard1. Replaces the
  former manual/reverted mutation spot-check.
- **Full gates (CLAUDE.md mandatory)**: `npx vitest run` + `npx tsc --noEmit`
  (**typecheck**, corrected per review Adjacent): `next build` EXCLUDES test files and does
  NOT typecheck `ast-guards.ts` (imported only by tests) — `tsc --noEmit` (the `typecheck`
  script, which includes test files and runs in `app-ci`) is what covers it. Per memory
  `feedback_skip_build_for_test_only` the diff is test-support-only so `next build` MAY be
  skipped, but `typecheck` is mandatory. Then `scripts/pre-pr.sh`.

## Considerations & constraints

### Scope contract

- **SC1** — guard3 (raw-SQL `// raw-sql-ident:` marker RESIDUAL in
  `check-raw-sql-usage.mjs:418-442`) is deferred. Owner: the branded-type
  (`SafeSqlIdentifier`) / worker-policy-manifest design track (triangulate P4).
  Rationale: guard3's gap is "value was validated" — a **dataflow** property that AST
  call-matching cannot close; the issue memo itself concludes the correct fix is
  type-level (branded types), not AST. Tracked in
  `docs/archive/review/issue-security-ci-guards-lexical-to-ast.md` §3. Not a 30-minute
  fix; deferral justified (design-layer entanglement, not "easy but skipped").
- **SC2** — assertion 3's `METHOD_EXPORT_RE` (HTTP-method export extraction) and
  assertion 1/2/4/5 are NOT lexical *security-value* guards (they extract structure or
  call real production functions) and are out of scope. Only the DELETE/WRITE-primitive
  and operator-gated-call guards (the false-negative security-detection surface) are
  upgraded.

### Known risks
- **R-risk-1**: ts-morph parse cost across ~212 files. Resolved (not just mitigated):
  measured ~303 ms for 4 parse-all passes (NF-R3) — within budget, so parse per-file
  per-assertion with NO caching (YAGNI; a shared mutable Project would introduce
  cross-test state, which NF-R3 forbids).
- **R-risk-2**: template-literal blanking must NOT blank `${expr}` code. Mitigation:
  I-C1-3 / I-C3-3 explicit interpolation-visible test case. This mirrors the existing
  `check-raw-sql-usage.mjs` brace-depth span logic — same hazard, already solved there;
  reuse the conceptual approach.
- **R-risk-3**: `matchesInCodeText` offset preservation — blanking must replace
  char-for-char (spaces), not delete, so line/column in any future diagnostic stays
  correct and multi-line regex behavior is unchanged.

### Out of scope
- No change to `route-policy-manifest.json`, `route-class-patterns.json`, or any
  route runtime code. If the suite requires a manifest edit to pass, that is a
  behavior change and a bug in this PR — stop and re-examine.
- guard3 (SC1), assertion 3 method extraction (SC2).

## User operation scenarios

1. **Regression a developer might introduce**: a maintenance route refactor drops the
   real `createRateLimiter({ failClosedOnRedisError: true })` call but leaves a
   `// TODO: re-add failClosedOnRedisError: true` comment. OLD 8b: passes (token in
   comment). NEW 8b: fails. ← the exact gap being closed.
2. **False-positive avoidance**: a route legitimately has the string
   `"createRateLimiter("` inside an error message or doc comment but ALSO the real
   call. NEW guard: still passes (real call present). No new false positive.
3. **assertion 6/7 comment decoy**: a GET-only route has `// prisma.x.delete(...)` in
   a comment explaining why it does NOT delete. OLD 7: false-positive violation
   (WRITE_PRIMITIVE matches the comment). NEW 7: correctly no match. ← removes a
   latent false-positive too, not only false-negatives.
