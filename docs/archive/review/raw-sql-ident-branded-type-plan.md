# Plan: unforgeable SQL text for raw-SQL calls (#635, guard 3)

## Project context

- Type: web app + workers (Next.js 16, Prisma 7, PostgreSQL) + operator scripts.
- Test infrastructure: unit + integration (real Postgres) + E2E + CI/CD.
- Verification environment constraints:
  - **VE1** — the retention-gc and audit-outbox workers run as esbuild CJS bundles (`--alias:@=./src`); a new shared module must import cleanly there. `verifiable-local` (`Smoke: worker-bundle-boot` in pre-pr) / `verifiable-CI`.
  - **VE2** — integration tests need local Postgres with the audit workers stopped (CLAUDE.md). `verifiable-local` / `verifiable-CI` (`ci-integration.yml` runs Postgres).

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
  template, or a call whose callee is the identifier `renderSql` (C3 decides which
  identifier that is) — nothing wrapped around or appended to it.
- FR2 `renderSql` returns text only for a genuine `SqlFragment`. Anything else —
  a value typed `any`, a value under `@ts-expect-error`, a look-alike or frozen copy —
  throws at runtime. A genuine value throws on every conversion path: `toString`,
  `valueOf`, `Symbol.toPrimitive` and `toJSON`, so an ordinary template,
  concatenation, `String(x)`, a direct `.toString()` call or `JSON.stringify` (logs,
  audit metadata) fails loudly instead of rendering `[object Object]` or `{}`.
- FR3 Genuine values come only from:
  - `sqlIdentifier(name)` — `^[a-z_]+$` (the regex `assertIdentifier` uses today, not
    widened) and not a PostgreSQL keyword of category `R` (reserved) or `T`
    (reserved, can be function or type). Precondition: `name` is a code constant or
    a member of a closed literal set — the retention registry, `GUARD_SQL` keys, the
    outbox two-table set, the migration script's three token columns. The
    precondition is enforced by review (C3 residual), not mechanically.
  - `trustedSql`, used ONLY as a tag: each part a genuine identifier/fragment or a
    non-negative safe integer, checked at runtime.
  - `joinSql`, which builds from registered text, never from caller strings.
- FR4 Prisma's raw-text surface is closed: `$queryRaw` / `$executeRaw` appear in
  expressions only as the tag of a tagged template; the rest of the name class
  `/^\$(query|execute)Raw\w*$/` is used only as C3 allows; nothing from Prisma's
  packages is used except an allowlisted set (C3 `PRISMA_IMPORT`).
- FR5 Layer 1 (file allowlist `raw-sql-usage.txt` with a purpose) is unchanged; the
  `ident-markers=N` suffix and all `raw-sql-ident` markers are removed.
- NF1 The SQL text reaching the database is byte-identical to today's for every
  migrated statement, proven by exact-string characterization tests committed
  before the statement is migrated (Step 0) whose expected strings do not change.

## Technical approach

The value guarantee is runtime-enforced (round 1); the gate enforces only the syntax
the runtime cannot see. After three review rounds found escapes in each deny-list
and in scope resolution, the gate is built from allowlists that need no binding
resolution (round 3, Sec S1/S2):

- `src/lib/prisma/raw-sql.ts` keeps a module-private `WeakMap<object, string>`.
  `SqlIdentifier` / `SqlFragment` are frozen opaque objects registered in it. Text is
  read only via `reg.get` at use time. Adjudication authority: WeakMap membership.
- The gate (ts-morph AST, no Program) judges each OCCURRENCE of a sensitive name by
  its syntactic position alone, never by what it is bound to: any occurrence not in
  an allowed position denies. Literal contents and module specifiers are matched by
  decoded value (`getLiteralValue()`), not source text. Type positions are ignored.

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
- Genuine objects are `Object.create(null)` objects, frozen, holding no text in any
  own property, whose only members are throwing `toString`, `valueOf`,
  `Symbol.toPrimitive` and `toJSON` (themselves frozen). No function that registers a
  value in the WeakMap is reachable from a genuine value (round 4, Sec S11);
  `Function` is reachable through the members' `constructor`, which is the `eval`
  residual. The WeakMap is written only inside the four exported functions.
- Built-ins are bound at module load so nothing is looked up at call time (round 5,
  Sec F-b): `WeakMap.prototype.get` / `set` bound to the registry,
  `Number.isSafeInteger`, `Object.freeze`, `Object.create` captured; loops are index
  loops (no `for…of`, no `Array.prototype` method lookups on caller arrays).
- `trustedSql` cannot tell a real template object from a forged array at runtime;
  tag-only use is enforced by C3.
- Control class: `enforceable boundary` against callers holding strings, `any`
  values or look-alike objects, given C3. Adjudication: WeakMap membership.
- Acceptance (unit):
  - `sqlIdentifier` rejects empty, uppercase, digit, quote, `;`, space, unicode,
    `select`, `or`, `true`, `null`, `join`, `left`; the keyword list equals
    `pg_get_keywords()` where `catcode IN ('R','T')` (integration test);
  - `trustedSql`: zero-substitution template renders its text exactly; rejects `-1`,
    `NaN`, `Infinity`, `1.5`, `2**53`, a plain string, a JSON-parsed object, an object
    literal with the same keys, a frozen copy of a genuine value;
  - `joinSql` with 0 / 1 / n parts; `renderSql` rejects every non-genuine input above;
  - a genuine value throws in a template literal, with `+`, under `String()`, on a
    direct `.toString()`, on a direct `.valueOf()`, and under `JSON.stringify` — each
    red-proven by removing that one override;
  - `Object.getPrototypeOf(v) === null` for every genuine value (red-proven with an
    `Object.prototype` object), and no value reachable from a genuine value through
    `constructor` / prototype walks yields an object `renderSql` accepts;
  - after import, replacing `WeakMap.prototype.get`, `Function.prototype.call`,
    `Array.prototype[Symbol.iterator]` and `Object.freeze` does not make `renderSql`
    accept a forged object;
  - the module's export names equal the four functions.

### C2 — Call-site and producer migration

Member set (re-derived in plan review rounds 1–3, ts-morph over non-test `src` +
`scripts`): 53 Unsafe calls, 7 with a non-literal first argument:

| Site | Today's interpolations | Change |
|---|---|---|
| `src/workers/audit-outbox-worker.ts` webhook fail-count UPDATE | `table` (2-literal set) | `renderSql(trustedSql\`…${sqlIdentifier(table)}…\`)` |
| `src/workers/retention-gc-worker/sweep.ts` two key-list DELETEs | identifier argument `sql` | inline; key list via `joinSql` |
| same, provenance DELETE … RETURNING | `entry.table`×2, `cutoffSql`, `guardSql`, `projection` | typed fragments |
| same, tenant-scoped DELETE | `entry.table`×2, `entry.cutoffColumn` | `trustedSql` |
| `scripts/migrate-account-tokens-to-encrypted.ts` SELECT and UPDATE | conditional WHERE, `BATCH_SIZE`; `setClauses`, `updates.length + 1` | `trustedSql`; conditional branches as `trustedSql\`…\`` / `trustedSql\`\`` |

- Composition invariant: every fragment-producing helper's result (`predicateSql`,
  `guardSql`, `cutoffSql`, `projection`, `setClauses`) is composed only through
  `trustedSql` / `joinSql`. Logs and audit metadata keep using the plain-string field
  (`entry.table`), never a genuine value — FR2's throwing `toJSON` enforces it.
- `assertIdentifier` → `sqlIdentifier` is a capture-and-thread rewrite: each of its 12
  call sites in `sweep.ts` (5 functions; `grep -n "assertIdentifier(" sweep.ts`) keeps
  the returned value and uses it downstream. `validateRegistry()` (boot only) calls
  `sqlIdentifier` for its throw and discards the result.
- Producers: `renderPredicate` returns `SqlFragment`; `GUARD_SQL`'s functions take
  `SqlIdentifier` and return `SqlFragment`.
- Acceptance: Step 0's characterization tests pass with expected strings unchanged.

### C3 — Gate rewrite (`scripts/checks/check-raw-sql-usage.mjs`, Layer 2)

Scope: every non-test `.ts .tsx .mts .cts .js .mjs .cjs` under `src/`, `scripts/`,
`prisma/` and at the repository root (`proxy.ts`, `sentry.*.config.ts`, …). `scripts/checks/**` (gate sources that spell the names as data) is exempt
from `RAW_METHOD`'s literal-content clause only; every other rule applies there.
`src/lib/prisma/raw-sql.ts` is exempt from `RAW_SQL_NAMES`. Independent of Layer 1.

Fail-closed reasons:

- `UNSAFE_ARG` — an Unsafe call's first argument is not a string literal, a
  no-substitution template, or a `CallExpression` whose `getExpression()` is an
  `Identifier` spelled `renderSql`. Deny: `renderSql(f).concat(x)`, `renderSql(f) + x`,
  `` `${renderSql(f)}${x}` ``, a ternary, `(renderSql)(f)`.
- `RAW_SQL_NAMES` — every occurrence (identifier, property name, shorthand,
  binding-element name, export name) of `renderSql`, `trustedSql`, `sqlIdentifier`,
  `joinSql` must be one of:
  - a name in the single canonical import `import { … } from "<spec>"`, unaliased,
    where `<spec>` resolves (alias `@/`→`src/`, relative, `.js`/`.ts`/`/index`
    variants) to `src/lib/prisma/raw-sql.ts`;
  - `renderSql` as the callee in `UNSAFE_ARG`'s allowed form;
  - `trustedSql` as the tag of a tagged template;
  - `sqlIdentifier` / `joinSql` as the callee of an ordinary call;
  - a type position.
  Any other occurrence denies regardless of scope: a local declaration of any kind
  (variable, `var` in a block, function / class declaration or expression name,
  parameter, catch binding, `import x =`, namespace), a call of `trustedSql`,
  `.call` / `.apply` / `.bind`, passing as an argument, re-export.
  Any other module-loading form whose specifier resolves to `raw-sql.ts` —
  namespace or default import, `export * from`, `require()`, `import()`,
  `import x = require()` — denies; a non-literal `import()` / `require()` argument in
  a scanned file denies.
- `SPECIFIER_LITERAL` (round 4, Sec S9) — any expression-position string or
  no-substitution template literal (decoded value) that matches the Prisma pattern
  below, or that resolves to `raw-sql.ts` under a case-insensitive comparison, denies
  unless it is the specifier of an allowed import declaration.
  `scripts/checks/check-raw-sql-usage.mjs` alone is exempt (it spells the allowed
  specifiers as data; round 5, Sec F-c). This catches loaders under another name
  (`createRequire(…)("@prisma/client")`, `requireModule("…/raw-sql")`). Measured: no
  such literal outside import declarations today.
- `UNSCANNED_IMPORT` (round 4, Sec S10) — a scanned file's import specifier that
  resolves into an excluded test path (`*.test.*`, `__tests__`, `manual-tests`,
  `e2e`) denies. Measured: 0 today.
- `RAW_METHOD` — names matching `/^\$(query|execute)Raw\w*$/`, found as an identifier,
  property name, or the decoded value of a string / no-substitution template literal,
  in expression position. Allowed only: `$queryRaw` / `$executeRaw` as the name of a
  property access that is the tag of a tagged template; `$queryRawUnsafe` /
  `$executeRawUnsafe` as the name of a property access that is directly (optional
  chaining allowed, no parentheses) the callee of a call. Everything else denies,
  including any use of `…Internal` / `…Typed`.
- `PRISMA_IMPORT` — every specifier matching `^(@prisma|\.prisma)(/|$)`,
  case-insensitively, as is the Prisma half of `SPECIFIER_LITERAL` (round 5, Sec F-d) (round 4,
  Sec S8: `@prisma/client-runtime-utils` exports the same `raw` / `sql` / `join` /
  `empty` / `Sql`). Only two are allowed:
  - `@prisma/client`: type-only imports (declaration or specifier level) are
    unrestricted (round 4, Func F1 — `import type { AuditLog }`); value imports are
    named, unaliased, and limited to `PrismaClient`, `Prisma`, and the enum names
    declared in `prisma/schema.prisma` (the gate reads them; it fails closed if an
    enum name equals a non-enum top-level export of `@prisma/client` such as `raw`,
    `sql`, `join`, `empty`, `Decimal`);
  - `@prisma/adapter-pg`: only in the files that construct a client today
    (re-derived at implementation).
  Every other `@prisma/*` / `.prisma/*` specifier, default or namespace import,
  `require()` / `import()`, and `export … from` denies. In expression position
  `Prisma` appears only as `Prisma.<member>` with member in
  {`PrismaClientKnownRequestError`, `PrismaClientInitializationError`} — the two
  measured in use (round 4, Sec S14 / Func F2); anything else — `Prisma.raw`, element
  access, destructuring, `Prisma` as an argument or alias — denies.
- `PRISMA_EXTENDS` — `$extends` as an identifier, property name, or decoded literal
  value, in expression position, denies (0 uses today; a client extension's
  `query.$allOperations` can rewrite SQL without spelling a raw method).
- Fail closed on 0 files analysed and on a file that fails to parse.

Residual (declared; enforced by review, not by this gate):
- `sqlIdentifier`'s precondition (FR3): a data-driven `name` cannot break SQL syntax
  but can choose the target table or column;
- a computed element access with a non-literal key (`tx["$" + name]`);
- reflective enumeration that never spells a name (`Object.getOwnPropertyNames(…)`, `for…in`);
- Prisma internals through `any` (`_request`, `_executeRequest`) and the pg adapter's
  `queryRaw` / `executeRaw` methods;
- a loader under another name called with a computed (non-literal) specifier —
  `module.require`, `require.cache`, `__webpack_require__` and the like (with a
  literal specifier they are caught by `SPECIFIER_LITERAL`);
- adding a third-party dependency that re-exports a raw-SQL producer
  (`sql-template-tag` and the like) — reviewed as a dependency change;
- imports into files outside the scan (today: `scripts/generate-team-key-fixture.ts`
  imports two files under `extension/src/lib/`, which hold no SQL);
- `eval` / `Function`; replacing a built-in the module calls before it loads (after
  load, the captured references are used).

Threat model: the gate is aimed at accidental and casual misuse in code that goes
through review. Deliberately obfuscated code can defeat any static gate (the
residual above); for that, review is the control.

Layer 1 keeps its behaviour. The `ident-markers=N` suffix is removed from the
allowlist grammar (a leftover suffix is a parse error) and from `raw-sql-usage.txt`.

- Control class: `fail-closed verification gate` over the allowlisted positions;
  `best-effort tripwire` for the residual.
- Acceptance: self-test over fixture trees (`RAW_SQL_CHECK_ROOT`); each deny case
  paired with its nearest allow case and red-proven:
  - every deny spelling named in the rules above, one fixture each — including one
    per local-declaration kind and one per specifier variant / loading form, an
    escaped literal (`tx["\x24queryRaw"]`, and in a no-substitution template),
    `import { raw } from "@prisma/client"` in a `.mjs` file, `import { raw as r }`,
    `import { raw } from "@prisma/client-runtime-utils"`, `tx["$queryRaw"]({ sql: x,
    values: [] })`, `Prisma.raw(x)` / `Prisma.sql` / `Prisma["raw"]` /
    `const { raw } = Prisma` / `const P = Prisma` after a legitimate
    `import { Prisma }`, `prisma.$extends(…)` / `prisma["$extends"]`,
    `createRequire(…)("@prisma/client")`, a case-variant raw-sql specifier,
    an import of a `*.test.ts` file, string-named `import { "trustedSql" as t }` and
    `export { x as "trustedSql" }`;
  - allow: each accepted specifier spelling of the raw-sql import (alias, relative
    without extension, relative `.js`, relative `.ts`, `/index`) used in
    `UNSAFE_ARG`'s form (round 4, Test T17); literal, no-substitution template,
    `renderSql(…)`, tagged `trustedSql`,
    `sqlIdentifier(…)`, tagged `$queryRaw`, direct and `?.` Unsafe calls, type
    positions (`TxProbe`'s method signature, `Pick<…, "$executeRaw">`, a
    `{ $executeRaw: … }` type literal), each allowlisted `Prisma.*` member, an enum
    import, `import type { AuditLog }`, a raw-method name as a string inside
    `scripts/checks/`;
  - completeness rule (round 5, Test): every rule and every clause of a rule above
    has at least one deny row and its nearest allow row, and every C1 claim has a
    test red-proven by removing that one mechanism. In particular:
    `requireModule("./raw-sql")` outside an import (deny); a violating file at the
    repository root (deny); `src/lib/latest-util.ts` / `scripts/manual-tests-helper.ts`
    importable without `UNSCANNED_IMPORT` (allow) next to a `*.test.ts` import (deny);
    `Prisma.dmmf`, `Prisma.DbNull`, `Prisma.JsonNull`, `Prisma.AnyNull` (deny); a
    fixture `prisma/schema.prisma` declaring `enum raw` → the gate fails closed; a bare
    `"$extends"` literal (deny); a backtick `createRequire(…)(\`@prisma/client\`)`
    (deny); `@PRISMA/client-runtime-utils` (deny);
  - structure: a table of `{ name, files, expectCode, expectReason }` rows driven by
    `it.each`, deny and allow rows adjacent per rule.
  - scope: one violating fixture per extension (`.mts .cts .js .mjs .cjs`) and one
    under `prisma/`, failing for the same reason as a `.ts` sibling;
  - empty scan root → fail; unparsable file → fail.

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
  log; the reviewer checks it precedes every C2 commit (`git log --oneline`) and that
  the characterization suite passes when that commit is checked out alone.
  - sweep: tighten `sweep-sql.test.ts` / `sweep-per-tenant-age.test.ts` from
    whitespace-tolerant regexes to exact `.toBe` strings of today's output.
  - outbox: export `onWebhookDeliveryFailure` (behaviour-preserving) and capture the
    exact arguments of its `tx.$queryRawUnsafe` call through a mocked `tx`.
  - migration script: add the `process.argv[1] && import.meta.url ===
    pathToFileURL(process.argv[1]).href` guard around `main()` (the pattern
    `scripts/tenant-domain.ts` uses), extract the two statements' construction into
    exported pure functions, and pin their exact output.
  - `predicate.test.ts`: pin `renderPredicate`'s exact outputs (already `.toBe`).
- **After C2**, NF1 is checked from the diff, not from the suite passing:
  `git diff <step0-SHA> -- <each Step 0 test file>` may only wrap the actual-value
  expression in `renderSql(...)`; every expected-string literal is byte-identical to
  Step 0's. Exception, reviewed separately: `predicate.test.ts`'s
  identifier-rejection cases move to `sqlIdentifier` with the same reject list.
- C1 unit tests and C3 gate self-test as listed (rewrite
  `scripts/__tests__/check-raw-sql-usage.test.mjs`).
- Integration: existing retention-gc sweep and webhook-delivery suites unchanged; new
  case asserting the keyword list equals `pg_get_keywords()` `R` + `T`.
- Mandatory: `npx vitest run`, `npm run typecheck`, `npm run test:integration`,
  `npx next build`, `scripts/pre-pr.sh` (incl. worker-bundle boot smoke, VE1).

## Considerations & constraints

### Scope contract

- **SC1** — Guards 1 and 2 of `#635` are already AST-based (`#636`); not touched.
- **SC2** — Parameterised tagged `$queryRaw` / `$executeRaw` stay as they are; C3 only
  constrains how they and Prisma's other exports may be used (FR4).
- **SC3** — Direct `pg` driver calls (`client.query(…)`) are outside this guard:
  `scripts/bootstrap-rds-roles.mjs` (identifiers via `quoteIdent`, values via
  `client.escapeLiteral`, over manifest constants) and `scripts/audit-db-grants.mjs`
  (11 calls, 6 interpolating the constant `AUDITABLE_SCHEMAS`). A guard for that API
  is separate work.

### Risks

- R1 — rendered SQL changes by a space. Mitigation: Step 0 exact-string tests and the
  diff check after C2.
- R2 — the `PRISMA_IMPORT` member allowlist is incomplete for a member a future change
  needs. It fails closed; the fix is to add the member with a reason.

## User operation scenarios

1. `tx.$queryRawUnsafe(\`… ${x} …\`)` → gate red `UNSAFE_ARG`.
2. `renderSql(trustedSql([userText]))` → gate red `RAW_SQL_NAMES`.
3. `trustedSql\`… ${x} …\`` with `x` typed `any` → runtime throw before the query.
4. `trustedSql\`… ${sqlIdentifier(x)} …\`` → passes; a bad or reserved `x` throws.
5. `` tx.$queryRaw`… ${Prisma.join(ids, sep)}` `` → gate red `PRISMA_IMPORT`.
6. `log.info({ table: tableIdent })` with a genuine value → throws at the log site.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `raw-sql.ts` runtime-checked opaque values | locked |
| C2 | Call-site and producer migration | locked |
| C3 | AST gate — see C3's fail-closed reasons | locked |
| C4 | Docs | locked |

## Implementation Checklist

Batches (Step 2-2). A is committed alone before C starts (NF1); B and D run alongside A.

- **A — Step 0 characterization** (test-only plus two behaviour-preserving production touches):
  `src/workers/retention-gc-worker/__tests__/sweep-sql.test.ts`, `sweep-per-tenant-age.test.ts` (exact `.toBe`);
  `src/workers/audit-outbox-worker.ts` (export `onWebhookDeliveryFailure`) + its test;
  `scripts/migrate-account-tokens-to-encrypted.ts` (CLI guard, extract two SQL builders) + new test;
  `src/workers/retention-gc-worker/__tests__/predicate.test.ts` (confirm exact pins).
- **B — C1**: `src/lib/prisma/raw-sql.ts`, `src/lib/prisma/raw-sql.test.ts`, keyword-list integration case under `src/__tests__/db-integration/`.
- **C — C2** (after A and B): `sweep.ts`, `predicate.ts`, `index.ts` (`validateRegistry`), `audit-outbox-worker.ts`, `scripts/migrate-account-tokens-to-encrypted.ts`; the Step 0 tests adapted only by wrapping in `renderSql(...)`; `predicate.test.ts` reject list moved to `sqlIdentifier`.
- **D — C3/C4**: `scripts/checks/check-raw-sql-usage.mjs`, `scripts/__tests__/check-raw-sql-usage.test.mjs` (table-driven), `scripts/checks/raw-sql-usage.txt` (header rewrite, `ident-markers` removed).

Shared utilities to reuse: ts-morph no-Program setup as in `scripts/checks/check-destructive-wrapper-derivation.mjs`; CLI guard pattern from `scripts/tenant-domain.ts`; existing gate env seams `RAW_SQL_CHECK_ROOT` / `RAW_SQL_CHECK_ALLOWLIST`.

Member-set derivation (C2), re-runnable:
`node -e` ts-morph scan — `CallExpression` with property-access callee named `$queryRawUnsafe`/`$executeRawUnsafe` over non-test `src/**/*.{ts,tsx}` + `scripts/**/*.ts`, first-argument kind ≠ string/no-substitution literal → 7 sites (listed in C2).

CI parity: the gate runs in pre-pr's static batch (`Static: raw-sql-usage`) and therefore in CI's static-checks job; its self-test runs in the App job via vitest. No gap.
