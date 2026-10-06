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
- Genuine objects are frozen; `toString`, `valueOf`, `Symbol.toPrimitive` and
  `toJSON` throw.
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
`prisma/`. `scripts/checks/**` (gate sources that spell the names as data) is exempt
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
- `RAW_METHOD` — names matching `/^\$(query|execute)Raw\w*$/`, found as an identifier,
  property name, or the decoded value of a string / no-substitution template literal,
  in expression position. Allowed only: `$queryRaw` / `$executeRaw` as the name of a
  property access that is the tag of a tagged template; `$queryRawUnsafe` /
  `$executeRawUnsafe` as the name of a property access that is directly (optional
  chaining allowed, no parentheses) the callee of a call. Everything else denies,
  including any use of `…Internal` / `…Typed`.
- `PRISMA_IMPORT` — for specifiers matching `^(@prisma/client|\.prisma/client)(/|$)`:
  only named imports of `PrismaClient`, `Prisma` and the generated enums, unaliased;
  no default or namespace import, no `require()` / `import()`, no `export … from`.
  In expression position `Prisma` appears only as `Prisma.<member>` with member in
  {`PrismaClientKnownRequestError`, `PrismaClientInitializationError`, `dmmf`,
  `DbNull`, `JsonNull`, `AnyNull`} (the members in use today, re-derived at
  implementation); anything else — `Prisma.raw` / `sql` / `join` / `Sql` / `empty`,
  element access, destructuring, aliasing `Prisma` — denies.
  `@prisma/adapter-pg` is imported only where it is today (the client constructors).
- `PRISMA_EXTENDS` — `$extends` in expression position denies (0 uses today; a client
  extension's `query.$allOperations` can rewrite SQL without spelling a raw method).
- Fail closed on 0 files analysed and on a file that fails to parse.

Residual (declared; enforced by review, not by this gate):
- `sqlIdentifier`'s precondition (FR3): a data-driven `name` cannot break SQL syntax
  but can choose the target table or column;
- a computed element access with a non-literal key (`tx["$" + name]`);
- reflective enumeration that never spells a name (`Object.getOwnPropertyNames(…)`, `for…in`);
- Prisma internals through `any` (`_request`, `_executeRequest`) and the pg adapter's
  `queryRaw` / `executeRaw` methods;
- `eval` / `Function`; code that replaces `WeakMap.prototype.get` or
  `Number.isSafeInteger` before the module loads.

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
    `tx["$queryRaw"]({ sql: x, values: [] })`;
  - allow: literal, no-substitution template, `renderSql(…)`, tagged `trustedSql`,
    `sqlIdentifier(…)`, tagged `$queryRaw`, direct and `?.` Unsafe calls, type
    positions (`TxProbe`'s method signature, `Pick<…, "$executeRaw">`, a
    `{ $executeRaw: … }` type literal), each allowlisted `Prisma.*` member and enum
    import, a raw-method name as a string inside `scripts/checks/`;
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
| C1 | `raw-sql.ts` runtime-checked opaque values | pending |
| C2 | Call-site and producer migration | pending |
| C3 | AST gate (positional allowlists: Unsafe args, raw-sql names, raw methods, Prisma imports) | pending |
| C4 | Docs | pending |
