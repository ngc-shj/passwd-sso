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
`renderSql()` from values only this repository's own code constants can create, and
raw SQL text cannot reach the parameterised `$queryRaw` / `$executeRaw` API. The
marker mechanism is removed.

## Requirements

- FR1 Every Unsafe call's first argument is a string literal, a no-substitution
  template, or a call whose callee IS the `renderSql` identifier bound (scope-aware)
  to the module's import — nothing wrapped around or appended to it.
- FR2 `renderSql` returns text only for a genuine `SqlFragment`. Anything else —
  including a value typed `any`, a value under `@ts-expect-error`, a look-alike or
  frozen copy — throws at runtime. A genuine value also throws on any implicit
  stringification (`toString` / `valueOf` / `Symbol.toPrimitive`), so composing one
  into an ordinary template or concatenation fails loudly instead of rendering
  `[object Object]`.
- FR3 Genuine values come only from:
  - `sqlIdentifier(name)` — `^[a-z_]+$` (the regex `assertIdentifier` uses today, not
    widened) and not a PostgreSQL reserved keyword. Precondition: `name` is a code
    constant or a member of a closed literal set (the retention registry, `GUARD_SQL`
    keys, the outbox two-table set) — never request or row data.
  - `trustedSql`, used ONLY as a tag: each part a genuine identifier/fragment or a
    non-negative safe integer, checked at runtime.
  - `joinSql`, which builds from registered text, never from caller strings.
- FR4 Prisma's raw-text surface is closed: `$queryRaw` / `$executeRaw` appear in
  expressions only as the tag of a tagged template; every other member of the name
  class `/^\$(query|execute)Raw\w*$/` (including `…Internal`, `…Typed`) is used only
  as described in C3; the sql-template-tag producers (`raw`, `sql`, `join`, `Sql`,
  `empty`, `sqltag`) are not used.
- FR5 Layer 1 (file allowlist `raw-sql-usage.txt` with a purpose) is unchanged; the
  `ident-markers=N` suffix and all `raw-sql-ident` markers are removed.
- NF1 The SQL text reaching the database is byte-identical to today's for every
  migrated statement, proven by exact-string characterization tests committed
  before the statement is migrated (Step 0).

## Technical approach

The value guarantee is runtime-enforced (round 1, Sec S1/S2); the gate enforces only
the syntax the runtime cannot see (how the module's functions and Prisma's raw
methods may be referenced).

- `src/lib/prisma/raw-sql.ts` keeps a module-private `WeakMap<object, string>`.
  `SqlIdentifier` / `SqlFragment` are frozen opaque objects registered in it. Text is
  read only via `reg.get` at use time. Adjudication authority: WeakMap membership.
- The gate (ts-morph AST, no Program) resolves identifiers through enclosing scopes
  (parameters, variable / function / class declarations, catch clauses) and accepts
  a binding only when the nearest declaration is the expected import specifier
  (round 2, Sec N4). Adjudication authority: the TypeScript parser plus that scope
  walk. Type positions are ignored.

## Contracts

### C1 — `src/lib/prisma/raw-sql.ts` (new)

```
export interface SqlIdentifier { readonly __sqlIdentifier: true }   // opaque
export interface SqlFragment { readonly __sqlFragment: true }       // opaque
export function sqlIdentifier(name: string): SqlIdentifier;
export function trustedSql(strings: TemplateStringsArray,
  ...parts: (SqlIdentifier | SqlFragment | number)[]): SqlFragment;
export function joinSql(parts: readonly (SqlIdentifier | SqlFragment)[], separator: SqlFragment): SqlFragment;
export function renderSql(fragment: SqlFragment): string;
```

- Exports are exactly these four functions and two types: no registry, no test
  hook, no re-export, no `Symbol.for` state. No node-only imports (VE1).
- Genuine objects are frozen with `toString`, `valueOf` and `Symbol.toPrimitive`
  that throw.
- `trustedSql` cannot tell a real template object from a forged array at runtime;
  that it is only used as a tag is enforced by C3 (`RAW_SQL_MODULE_USE`).
- Control class: `enforceable boundary` against callers holding strings, `any`
  values or look-alike objects, given C3's `RAW_SQL_MODULE_USE`. Not covered: the
  residual in C3. Adjudication: WeakMap membership.
- Acceptance (unit):
  - `sqlIdentifier` rejects empty, uppercase, digit, quote, `;`, space, unicode, and
    reserved keywords (`select`, `or`, `true`, `null`); the reserved list matches
    `pg_get_keywords()` where `catcode = 'R'` (asserted in an integration test);
  - `trustedSql`: zero-substitution template renders its text exactly; rejects
    `-1`, `NaN`, `Infinity`, `1.5`, `2**53`, a plain string, a JSON-parsed object, an
    object literal with the same keys, a frozen copy of a genuine value;
  - `joinSql` with 0 / 1 / n parts;
  - `renderSql` rejects every non-genuine input above;
  - a genuine value inside an ordinary template literal or `+` throws;
  - the module's export names equal the four functions.

### C2 — Call-site and producer migration

Member set (re-derived twice in plan review, ts-morph over non-test `src` + `scripts`):
53 Unsafe calls, 7 with a non-literal first argument:

| Site | Today's interpolations | Change |
|---|---|---|
| `src/workers/audit-outbox-worker.ts` webhook fail-count UPDATE | `table` (2-literal set) | `renderSql(trustedSql\`…${sqlIdentifier(table)}…\`)` |
| `src/workers/retention-gc-worker/sweep.ts` two key-list DELETEs | identifier argument `sql` | inline; key list via `joinSql` |
| same, provenance DELETE … RETURNING | `entry.table`×2, `cutoffSql`, `guardSql`, `projection` | typed fragments |
| same, tenant-scoped DELETE | `entry.table`×2, `entry.cutoffColumn` | `trustedSql` |
| `scripts/migrate-account-tokens-to-encrypted.ts` SELECT and UPDATE | conditional WHERE, `BATCH_SIZE`; `setClauses`, `updates.length + 1` | `trustedSql`; conditional branches as `trustedSql\`…\`` / `trustedSql\`\`` |

- Composition invariant (round 2, Func F1): every fragment-producing helper's result
  (`predicateSql`, `guardSql`, `cutoffSql`, `projection`, `setClauses`) is composed
  only through `trustedSql` / `joinSql` — never an ordinary template or string
  concatenation. FR2's throwing `toString` makes a violation fail at the site.
- `assertIdentifier` → `sqlIdentifier` is a capture-and-thread rewrite, not a rename
  (round 2, Func F3): each of its ~14 call sites in `sweep.ts` (5 functions) keeps the
  returned `SqlIdentifier` and uses it downstream instead of the raw string.
  `validateRegistry()` (boot-time only) calls `sqlIdentifier` for its throw and
  discards the result.
- Producers: `renderPredicate` returns `SqlFragment`; `GUARD_SQL`'s functions take
  `SqlIdentifier` and return `SqlFragment`.
- Acceptance: Step 0's characterization tests pass unchanged after migration.

### C3 — Gate rewrite (`scripts/checks/check-raw-sql-usage.mjs`, Layer 2)

Scope: every non-test `.ts .tsx .mts .cts .js .mjs .cjs` under `src/`, `scripts/`,
`prisma/`, except the gate implementations themselves (`scripts/checks/**`), and
`src/lib/prisma/raw-sql.ts` for `RAW_SQL_MODULE_USE`. Independent of Layer 1's trigger.

Fail-closed reasons:

- `UNSAFE_ARG` — an Unsafe call's first argument is not a string literal, a
  no-substitution template, or a `CallExpression` whose `getExpression()` is the
  `Identifier` `renderSql` resolving to the import. Deny: `renderSql(f).concat(x)`,
  `renderSql(f) + x`, `` `${renderSql(f)}${x}` ``, a ternary, `(renderSql)(f)`.
- `RAW_SQL_MODULE_USE` — the module's bindings are imported only by unaliased named
  import (alias path `@/lib/prisma/raw-sql` or the relative path to the same file);
  no namespace import, alias or re-export. `trustedSql` appears in expressions only
  as the tag of a tagged template; `renderSql` only as described in `UNSAFE_ARG`.
  Deny: a call of `trustedSql`, `.call` / `.apply` / `.bind`, `Reflect.apply`,
  passing either as an argument, assigning to another binding, an inner-scope
  shadow named like an import.
- `RAW_METHOD` — one rule over names matching `/^\$(query|execute)Raw\w*$/`, found as
  an identifier, property name, or the content of a string / no-substitution template
  literal, in expression position. Allowed only: `$queryRaw` / `$executeRaw` as the
  name of a property access that is the tag of a tagged template; `$queryRawUnsafe` /
  `$executeRawUnsafe` as the name of a property access that is directly (optional
  chaining allowed, no parentheses) the callee of a call. Everything else denies,
  including any use of `$queryRawInternal`, `$executeRawInternal`, `$queryRawTyped`.
- `PRISMA_SQL_TAG` — `raw`, `sql`, `join`, `Sql`, `empty`, `sqltag` reached from the
  `Prisma` binding of `@prisma/client` (property access, literal-key element access,
  destructuring, or any expression-position alias of the binding, including
  `import { Prisma as P }`), or imported by name or namespace from
  `@prisma/client/runtime/*`. Measured: 0 current uses. Allowed: other `Prisma.*`
  members (`PrismaClientKnownRequestError`, `DbNull`, type-position
  `Prisma.TransactionClient`).
- Fail closed on 0 files analysed and on a file that fails to parse.

Residual (declared; refused at review, not by this gate): a computed element access
with a non-literal key (`tx["$" + name]`); reflective enumeration that never spells a
name (`Object.getOwnPropertyNames(Object.getPrototypeOf(prisma))`, `for…in`); Prisma
internals through `any` (`_request`, `_executeRequest`); `eval` / `Function`; code that
replaces `WeakMap.prototype.get` or `Number.isSafeInteger` before the module loads.

Layer 1 keeps its behaviour. The `ident-markers=N` suffix is removed from the
allowlist grammar (a leftover suffix is a parse error) and from `raw-sql-usage.txt`.

- Control class: `fail-closed verification gate` over the decidable spellings;
  `best-effort tripwire` for the residual.
- Acceptance: self-test over fixture trees (`RAW_SQL_CHECK_ROOT`); each deny case
  paired with its nearest allow case and red-proven. Deny list: every spelling named
  in the four rules above, plus `import { raw as r } from "@prisma/client/runtime/…"`
  with `r(x)`, `tx["$queryRaw"]({ sql: x, values: [] })`, and an import present with
  an inner shadow, for both `renderSql` and `trustedSql`. Allow list: literal,
  no-substitution template, scope-resolved `renderSql(…)`, tagged `trustedSql`,
  tagged `$queryRaw`, direct and `?.` Unsafe calls, type positions (`TxProbe`'s method
  signature, `Pick<…, "$executeRaw">`, a `{ $executeRaw: … }` type literal), other
  `Prisma.*` members, `import { sql }`-shaped imports from a non-Prisma module.
  Empty scan root → fail; unparsable file → fail.

### C4 — Documentation

`scripts/checks/raw-sql-usage.txt` header and `check-raw-sql-usage.mjs` header
describe the new rule (narrative rewrite). Nothing under `docs/security/`
describes the marker mechanism today.

### Forbidden patterns (final tree, `src scripts`, excluding tests and docs/archive)

- pattern: `raw-sql-ident` — reason: marker mechanism removed
- pattern: `ident-markers` — reason: allowlist suffix removed
- pattern: `VARIABLE_LOOKBACK_LINES|findTemplateLiteralSpan` — reason: lexical tracker removed
- pattern: `assertIdentifier` — reason: replaced by `sqlIdentifier`

## Testing strategy

- **Step 0, one commit before any C2 change.** Its SHA is recorded in the deviation
  log; the reviewer checks it precedes every C2 commit (`git log --oneline`) and
  that the characterization suite passes when that commit is checked out alone.
  - sweep: tighten `sweep-sql.test.ts` / `sweep-per-tenant-age.test.ts` from
    whitespace-tolerant regexes to exact `.toBe` strings of today's output.
  - outbox: export `onWebhookDeliveryFailure` (behaviour-preserving) and capture the
    exact arguments of its `tx.$queryRawUnsafe` call through a mocked `tx`.
  - migration script: add the `process.argv[1] && import.meta.url ===
    pathToFileURL(process.argv[1]).href` guard around `main()` (the pattern
    `scripts/tenant-domain.ts` and `scripts/audit-chain-verify-worker.ts` use),
    extract the two statements' construction into exported pure functions, and pin
    their exact output.
  - `predicate.test.ts`: pin `renderPredicate`'s exact outputs (already `.toBe`).
- After C2: the same tests pass unchanged except for mechanical adaptation that
  unwraps through `renderSql(...)`; `predicate.test.ts`'s identifier-rejection cases
  are re-expressed against `sqlIdentifier` with the same reject list.
- C1 unit tests and C3 gate self-test as listed (rewrite
  `scripts/__tests__/check-raw-sql-usage.test.mjs`).
- Integration: existing retention-gc sweep and webhook-delivery suites unchanged;
  new case asserting the reserved-keyword list equals `pg_get_keywords()` `R`.
- Mandatory: `npx vitest run`, `npm run typecheck`, `npm run test:integration`,
  `npx next build`, `scripts/pre-pr.sh` (incl. worker-bundle boot smoke, VE1).

## Considerations & constraints

### Scope contract

- **SC1** — Guards 1 and 2 of `#635` are already AST-based (`#636`); not touched.
- **SC2** — Parameterised tagged `$queryRaw` / `$executeRaw` stay as they are; C3 only
  constrains how they and the sql-template-tag producers may be used (FR4).
- **SC3** — Direct `pg` driver calls (`client.query(…)`) are outside this guard.
  Today only `scripts/bootstrap-rds-roles.mjs` uses them, quoting identifiers with
  `quoteIdent` and values with `client.escapeLiteral` over manifest constants; a guard
  for that API is separate work.

### Risks

- R1 — rendered SQL changes by a space. Mitigation: Step 0 exact-string tests.
- R2 — scope-aware binding resolution misreads an unusual declaration form.
  Mitigation: fail closed on any declaration kind the resolver does not recognise.

## User operation scenarios

1. `tx.$queryRawUnsafe(\`… ${x} …\`)` → gate red `UNSAFE_ARG`.
2. `renderSql(trustedSql([userText]))` → gate red `RAW_SQL_MODULE_USE`.
3. `trustedSql\`… ${x} …\`` with `x` typed `any` → runtime throw before the query.
4. `trustedSql\`… ${sqlIdentifier(x)} …\`` → passes; a bad or reserved `x` throws.
5. `` tx.$queryRaw`… ${Prisma.join(ids, sep)}` `` → gate red `PRISMA_SQL_TAG`.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `raw-sql.ts` runtime-checked opaque values | pending |
| C2 | Call-site and producer migration | pending |
| C3 | AST gate (Unsafe args, module use, raw-method class, sql-template-tag) | pending |
| C4 | Docs | pending |
