# Plan: unforgeable SQL text for raw-SQL calls (#635, guard 3)

## Project context

- Type: web app + workers (Next.js 16, Prisma 7, PostgreSQL) + operator scripts.
- Test infrastructure: unit + integration (real Postgres) + E2E + CI/CD.
- Verification environment constraints:
  - **VE1** — the retention-gc and audit-outbox workers run as esbuild CJS bundles (`--alias:@=./src`); a new shared module must import cleanly there. `verifiable-local` (`Smoke: worker-bundle-boot` in pre-pr) / `verifiable-CI`.
  - **VE2** — integration tests need local Postgres with the audit workers stopped (CLAUDE.md). `verifiable-local` / `verifiable-CI`.

## Objective

Guards 1 and 2 of `#635` were moved to AST matching in `#636` (SC1). Guard 3 remains:
the raw-SQL gate (`scripts/checks/check-raw-sql-usage.mjs`, Layer 2) lets `${…}`
into a `$queryRawUnsafe` / `$executeRawUnsafe` argument when a
`// raw-sql-ident: <reason>` comment is present, and checks only that a validator
NAME appears somewhere in the file.

End state: SQL text that reaches an Unsafe call is either a literal or produced by
`renderSql()` from a value only this repository's validators can create; raw SQL
text cannot reach the tagged `$queryRaw` / `$executeRaw` API either. The marker
mechanism is removed.

## Requirements

- FR1 Every Unsafe call's first argument is a string literal, a no-substitution
  template, or a direct call to `renderSql(…)`.
- FR2 `renderSql` returns text only for a genuine `SqlFragment`; anything else —
  including a value typed `any`, a value under `@ts-expect-error`, a plain object of
  the same shape — throws at runtime.
- FR3 Genuine values come only from: `sqlIdentifier(name)` (enforces `^[a-z_]+$`,
  the regex `assertIdentifier` uses today — not widened), `trustedSql` (each part a
  genuine identifier/fragment or a safe integer, checked at runtime), and `joinSql`.
- FR4 `$queryRaw` / `$executeRaw` appear in expressions only as the tag of a tagged
  template; `Prisma.raw` (and `raw` imported from a Prisma package) is not used.
- FR5 Layer 1 (file allowlist `raw-sql-usage.txt` with a purpose) is unchanged; the
  `ident-markers=N` suffix and all `raw-sql-ident` markers are removed.
- NF1 The SQL text reaching the database is byte-identical to today's for every
  migrated statement, proven by exact-string characterization tests committed
  before the statement is migrated (Step 0).

## Technical approach

The value guarantee moves from the type system to the runtime, where neither `any`
nor a suppression pragma can reach it (plan review round 1, Sec F1/F2):

- `src/lib/prisma/raw-sql.ts` keeps a module-private `WeakMap<object, string>`.
  `SqlIdentifier` / `SqlFragment` are frozen opaque objects registered in it; only
  the module's functions register. `renderSql` and `trustedSql` look values up in it.
  Static types (opaque interfaces) give early feedback, but are not the control.
  Adjudication authority: the WeakMap membership test at runtime.
- The gate (ts-morph AST, no Program) checks syntax only: where Unsafe text may come
  from (FR1), that the Unsafe and tagged raw methods are not referenced in other ways
  (FR4), and that `Prisma.raw` is absent. Adjudication authority: the TypeScript
  parser. It scans every non-test `.ts`/`.tsx` under `src/` and `scripts/`,
  independent of the Layer-1 trigger regex. Type positions (`Pick<…, "$executeRaw">`,
  `{ $executeRaw: … }` in a type literal, `TxProbe`'s method signature) are ignored.

## Contracts

### C1 — `src/lib/prisma/raw-sql.ts` (new)

```
export interface SqlIdentifier { readonly __sqlIdentifier: true }   // opaque
export interface SqlFragment { readonly __sqlFragment: true }       // opaque
export function sqlIdentifier(name: string): SqlIdentifier;          // throws unless ^[a-z_]+$
export function trustedSql(strings: TemplateStringsArray,
  ...parts: (SqlIdentifier | SqlFragment | number)[]): SqlFragment;  // throws on a non-genuine part or non-safe-integer
export function joinSql(parts: readonly (SqlIdentifier | SqlFragment)[], separator: SqlFragment): SqlFragment;
export function renderSql(fragment: SqlFragment): string;            // throws unless genuine
```

- No node-only imports (VE1).
- Control class: `enforceable boundary` for code that runs through the module — a
  caller holding only strings, `any` or look-alike objects cannot obtain a genuine
  value. Not covered: code that edits this module, or `eval`. Adjudication: runtime
  WeakMap membership.
- Acceptance (unit): identifiers — valid, empty, uppercase, digit, quote, `;`, space,
  unicode; `trustedSql` — zero-substitution template renders its text exactly (the
  empty branch of a conditional fragment), rejects `NaN`, `Infinity`, `1.5`, `2**53`,
  a plain string, a JSON-parsed object, an object literal with the same keys, a
  frozen copy of a genuine value; `joinSql` with 0 / 1 / n parts; `renderSql` rejects
  every non-genuine input above.

### C2 — Call-site and producer migration

Member set derived with
`node -e` + ts-morph: every `CallExpression` whose callee is a property access named
`$queryRawUnsafe` / `$executeRawUnsafe` in non-test `src/**/*.{ts,tsx}` and
`scripts/**/*.ts`, classified by first-argument kind (script recorded in the
Implementation Checklist at Phase 2). Non-literal first arguments today:

| Site | Interpolations | Change |
|---|---|---|
| `src/workers/audit-outbox-worker.ts` webhook fail-count UPDATE | `table` (2-literal set) | `renderSql(trustedSql\`…${sqlIdentifier(table)}…\`)` |
| `src/workers/retention-gc-worker/sweep.ts` two key-list DELETEs | identifier argument `sql` | inline `renderSql(trustedSql…)`, key list via `joinSql` |
| same, provenance DELETE … RETURNING | `entry.table`×2, `cutoffSql`, `guardSql`, `projection` | typed fragments |
| same, tenant-scoped DELETE | `entry.table`×2, `entry.cutoffColumn` | `trustedSql` |
| `scripts/migrate-account-tokens-to-encrypted.ts` SELECT and UPDATE | conditional WHERE literal, `BATCH_SIZE`; `setClauses`, `updates.length + 1` | `trustedSql`; conditional branches as `trustedSql\`…\`` / `trustedSql\`\`` |

Producers feeding them become typed: `renderPredicate` (`predicate.ts`) returns
`SqlFragment`; `assertIdentifier` is replaced by `sqlIdentifier`; `GUARD_SQL`'s
functions take `SqlIdentifier` and return `SqlFragment`. `validateRegistry()` keeps
failing fast at boot.

- Acceptance: Step 0's characterization tests pass unchanged after migration.

### C3 — Gate rewrite (`scripts/checks/check-raw-sql-usage.mjs`, Layer 2)

ts-morph, no Program, every non-test `.ts`/`.tsx` under `src/` and `scripts/`.
Fail-closed reasons:

- `UNSAFE_ARG` — an Unsafe call's first argument is not a string literal,
  no-substitution template, or a direct call of `renderSql` bound by an unaliased
  named import from `@/lib/prisma/raw-sql` (or the equivalent relative path) in the
  same file.
- `UNSAFE_METHOD_ESCAPES` — in expression position, `$queryRawUnsafe` /
  `$executeRawUnsafe` appear other than as the name of a property access that is
  directly (no parentheses) the callee of a call: element access, destructuring,
  shorthand property, passing as an argument, `.call` / `.apply` / `.bind`, a
  string or template literal spelling the name.
- `RAW_NOT_TAGGED` — `$queryRaw` / `$executeRaw` in expression position other than as
  the tag of a tagged template (closes `$queryRaw(Prisma.raw(x))`).
- `PRISMA_RAW` — any `Prisma.raw` property access, or an import binding `raw` from a
  `@prisma/*` module (closes `` $queryRaw`${Prisma.raw(x)}` ``).
- Fail closed on 0 files analysed and on a file that fails to parse.

Residual (declared, best-effort): a computed element access whose key is not a
literal (`tx["$" + name]`) and `eval` / `Function` cannot be decided without
evaluation; such code is refused at review, not by this gate.

Layer 1 keeps its behaviour; the `ident-markers=N` suffix is removed from the
allowlist grammar (a leftover suffix becomes a parse error) and from
`raw-sql-usage.txt`, whose header is rewritten to describe this mechanism.

- Control class: `fail-closed verification gate` over the decidable spellings above;
  `best-effort tripwire` for the residual.
- Acceptance: self-test over fixture trees (`RAW_SQL_CHECK_ROOT`), each deny case
  paired with its nearest allow case and red-proven:
  untagged `${}` template / identifier / concatenation / `renderSql` aliased /
  `renderSql` from another module / a local function named `renderSql` → deny,
  vs. literal, no-sub template, imported `renderSql(…)` → allow;
  element access with string key, template key, destructuring, shorthand, argument,
  `.call`, parenthesized callee, string-literal name → deny, vs. direct call
  (incl. `?.`) and type-position references (`TxProbe` method signature,
  `Pick<…, "$executeRaw">`, `{ $executeRaw: … }` type literal) → allow;
  `$queryRaw(x)` call, `$queryRaw` passed as a value → deny, vs. tagged → allow;
  `Prisma.raw(…)`, `import { raw } from "@prisma/client/runtime/…"` → deny,
  vs. `Prisma.sql` / `Prisma.join` → allow;
  empty scan root → fail; unparsable file → fail.

### C4 — Documentation

`scripts/checks/raw-sql-usage.txt` header and `check-raw-sql-usage.mjs` header
describe the new rule (narrative rewrite, not suffix removal). Nothing under
`docs/security/` describes the marker mechanism today.

### Forbidden patterns (final tree, `src scripts`, excluding tests and docs/archive)

- pattern: `raw-sql-ident` — reason: marker mechanism removed
- pattern: `ident-markers` — reason: allowlist suffix removed
- pattern: `VARIABLE_LOOKBACK_LINES|findTemplateLiteralSpan` — reason: lexical tracker removed
- pattern: `assertIdentifier` — reason: replaced by `sqlIdentifier`

## Testing strategy

- **Step 0 (committed before any C2 change):** characterization tests that capture
  each migrated statement's exact text with `.toBe` from TODAY's code: sweep's SQL
  builders (tighten the existing regex assertions in `sweep-sql.test.ts` /
  `sweep-per-tenant-age.test.ts` to exact strings), the outbox fail-count UPDATE (a
  mocked `tx.$queryRawUnsafe` capturing its arguments), and the migration script's
  two statements (extract the SQL construction into exported pure functions first if
  needed — behaviour-preserving — then test them). After C2, the same tests must pass
  unchanged.
- C1 unit tests as listed.
- C3 gate self-test as listed (rewrite `scripts/__tests__/check-raw-sql-usage.test.mjs`).
- Integration: existing retention-gc sweep and webhook-delivery suites unchanged.
- Mandatory: `npx vitest run`, `npm run typecheck`, `npm run test:integration`,
  `npx next build`, `scripts/pre-pr.sh` (incl. worker-bundle boot smoke, VE1).

## Considerations & constraints

### Scope contract

- **SC1** — Guards 1 and 2 of `#635` are already AST-based (`#636`); not touched.
- **SC2** — Parameterised tagged `$queryRaw` / `$executeRaw` stay as they are; C3 only
  constrains how they may be invoked (FR4). (Round 1 corrected the earlier claim that
  they cannot take raw text: they can, through a non-tagged call or `Prisma.raw`.)

### Risks

- R1 — rendered SQL changes by a space. Mitigation: Step 0 exact-string tests.
- R2 — `scripts/` imports `@/lib/prisma/raw-sql` through the tsconfig alias under
  `tsx`; workers through esbuild's alias. C3's import check accepts the alias and the
  relative path to the same file, nothing else.

## User operation scenarios

1. `tx.$queryRawUnsafe(\`… ${x} …\`)` → gate red `UNSAFE_ARG`.
2. `tx.$queryRawUnsafe(renderSql(trustedSql\`… ${x} …\`))` with `x: string` → tsc error; with `x` typed `any` → runtime throw before the query.
3. `trustedSql\`… ${sqlIdentifier(x)} …\`` → passes; a bad `x` throws before SQL runs.
4. `tx.$queryRaw(Prisma.raw(x))` → gate red `RAW_NOT_TAGGED` and `PRISMA_RAW`.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `raw-sql.ts` runtime-checked opaque values | pending |
| C2 | Call-site and producer migration | pending |
| C3 | AST gate (Unsafe args, method escapes, tagged-only raw, no Prisma.raw) | pending |
| C4 | Docs | pending |
