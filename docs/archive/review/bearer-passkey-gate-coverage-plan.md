# Plan: bearer-passkey-gate-coverage

Issue: #964 — widen the bearer passkey static gate's coverage beyond readable Prisma filters.
Branch: `fix/bearer-passkey-gate-coverage`.
Review record: `bearer-passkey-gate-coverage-review.md` (finding IDs cited below).

## Project context

- Type: web app (Next.js) with CI static gates under `scripts/checks/`.
- Test infrastructure: unit + integration + E2E + CI/CD. The gate has a fixture-based
  self-test (`scripts/__tests__/check-bearer-passkey-gate.test.mjs`, run by vitest).
- Verification environment constraints:
  - VE1: the CI `static-checks` job runs `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` with no
    generated Prisma client, so nothing in this gate may need type resolution of the client.
    Every path in this plan is `verifiable-local` and `verifiable-CI`; nothing is
    `blocked-deferred`.

## Objective

`scripts/checks/check-bearer-passkey-gate.mjs` (C7 of the #956 plan) is a best-effort
detection gate over digest lookups. Its header lists five residual classes it does not see.
This change closes the detection half of each one where a syntactic rule can, at a measured
cost, and restates the residuals that remain. The control class does not change: the gate
stays a tripwire, and the enforcement stays the per-use gate inside each validator.

## Requirements

- R-1: a digest key spelled in non-test `src` is accounted for: placed by the positional
  walk, or counted as a site of the function that spells it, whatever value shape or
  receiver carries it. A direct caller of a function that builds a digest-keyed object is
  counted too (C1); other ways to reach a builder are SC6.
- R-2: raw SQL that reaches a token table without naming a digest column is refused or
  classified, for the spellings C3 and C4 enumerate: whole-row references, dynamic SQL, and
  database objects defined in SQL files. What they do not reach is SC4.
- R-3: SQL through the pg driver is constrained like `$queryRawUnsafe`'s argument.
- R-4: no blanket refusal that drowns the manifest. The issue measured 326 new functions for
  "refuse every unreadable filter"; this plan adds entries in single digits (A-12).
- R-5: gate wall time is recorded before and after (median of 3 runs each); the change is
  expected to add under 2 s. Round-1 probes measured about 0.3 s for the census and 0.35 s
  for the migrations. This is a recorded measurement, not an enforced threshold.

## Technical approach

The existing gate decides "is this call a lookup" by walking from a call's argument down
through positions it can read. The first three residual classes are values that walk cannot
follow. Following values further is dataflow, and each extension leaves the next spelling
outside.

This plan inverts the direction for detection. A digest lookup through the query builder
needs the digest field's name as a key. So the gate enumerates every *spelling* of a digest
key in non-test `src` and requires each to be accounted for. No value needs to be followed.
The positional walk keeps its present job (lookups, opacity, model coverage).

Measured inputs. The figures are from scratch ts-morph probes, reproduced independently by
the functionality reviewer in round 1. The implemented gate prints the same counts in its
summary line (C6), which makes the gate the reproducing command; Phase 2 records them.

- 52 object-literal properties named a digest key, all inside a call's argument: 26 under
  `where`, 23 under `data`, 2 under `select`, 1 under another key.
- 5 member reads; 3 string literals equal to a digest key.
- 136 SQL-bearing literals; 7 name a token table. The only `*` outside `count(*)` is a
  `RETURNING *` on `audit_outbox`, which is not a token table.
- 16 SQL migrations define a function, view, trigger or rule.
- `.query(...)` calls in non-test `src`: 0. `createPool` has 4 importers, `createClient`
  none.

SQL text is read with the existing lexer, `scripts/checks/lib/sql-scan.mjs` (`tokenizeSql`).
Its token stream is read; its behaviour is not changed.

## Contracts

Vocabulary:

- *Digest key*: a member of `DIGEST_KEYS`. *Digest column*: the `@map` column of a digest-key
  field.
- *Token model / token table*: a schema model declaring a digest key, and its `@@map` table.
- *Site*: one unit counted in a manifest entry's `calls`. After this change `calls` counts
  lookup calls, opaque calls and floating spellings (F1).

### C1 — Digest-key spelling census

Control class: best-effort tripwire. Adjudication authority: the TypeScript parse tree
(ts-morph, no Program).

Member set, derived by role and not by a list of node kinds (F9): the census visits every
identifier whose text is a digest key, and every string or no-substitution template literal
whose cooked value equals one. Each occurrence has one role:

- *binding*: the declared name of a variable, parameter or function, or an expression that
  refers to such a local binding. Not a spelling.
- *type*: any position inside a type. Not a spelling.
- *key*: everything else. This includes an object-literal property name (plain, shorthand,
  string-literal, a computed key `constString` pins, an accessor or method), a member
  access, an element access with a pinned key, the property side of a binding element, a
  class member name, an enum member, a JSX attribute, and a string literal in a value
  position. A role the census does not recognise is a key (it errs toward a site).

A string literal that only contains a digest key inside longer text is not a key (SC3).

Placement: an object-literal property key is *placed* when the positional walk visited it as

- a lookup: a digest key under a filter position (today's rule, any receiver);
- a write: a scalar key at a `data` / `create` / `update` position of a call whose receiver
  resolves to a model that declares the field, including the scalar-only methods
  (`createMany`, `updateMany` and their `AndReturn` forms) and nested writes whose relation
  resolves;
- a projection: a key under `select` or `omit` of such a call.

Placement is recorded through its own channel. It does not change which model the existing
walkers receive (I-C1b). Any other key is never placed.

Sites: an unplaced key is a *floating digest key*. It adds no site when it sits inside a
counted call, or inside another floating key, that `attribute()` gives the same manifest
key; otherwise it is one site of the function `attribute()` names (F6). A floating key
`attribute()` cannot name (a class member, a non-exported top-level `const`) fails with the
existing "cannot be attributed" failure; the remedy is to move it into a named function or
an exported `const` (F7).

Consumers of a filter builder (S2, S9): a function holding a floating *write* key builds a
digest-keyed object outside any position the walk reads. A write key is an object-literal
property, the target of an assignment (`w.tokenHash = h`, `w["tokenHash"] = h`), or a
string literal passed as a call's argument (`Object.fromEntries([["tokenHash", h]])`,
`Reflect.set(w, "tokenHash", h)`) (S16); a read (`row.tokenHash`) is not one. A direct call of that function is one site of the caller. The callee is resolved scope-aware: a local function,
or a named import of the builder's module, by the gate's existing import resolution. One
level only: the caller then needs its own entry and is classified by a human.

Invariants (app-enforced by this gate; no storage-level equivalent exists for source text):

- I-C1a: every key occurrence in non-test `src` is placed, or counted in the `calls` of a
  manifest entry for the function `attribute()` names.
- I-C1b: the census changes no existing decision. Lookups, opacity, model coverage and the
  per-use-gated predicate read what they read today; a floating key never satisfies model
  coverage.
- I-C1c: a failure message for a function reports lookups, opaque calls and floating keys
  separately, and gives each floating key's line and role.

Expected result on the real repo (round-1 probe, exact-match strings, receiver-model
placement); Phase 2 records the implemented gate's figures and explains any difference:

- 4 new keys: `audit-logger.ts#METADATA_BLOCKLIST`, `redact-keys.ts#SECRET_REDACT_KEYS`,
  `mobile-token.ts#refreshIosToken`, `emergency-access-state.ts#hasResourceScope`.
- 1 existing entry whose `calls` changes: `api/mobile/token/refresh/route.ts#handlePOST`.

Acceptance:

- A-1: each key role has a cell that fails `UNLISTED` in an unlisted function and a paired
  cell, differing in one axis, that passes. A class member and a non-exported top-level
  `const` are pinned by the "cannot be attributed" line instead; their allow cell is the
  same spelling inside a named function with an entry (F15). Binding and type roles have
  allow cells. A shorthand property over a local binding, and a reference with no visible
  binding, are keys (deny cells).
- A-1b: the default arm is pinned by rare positions: an enum member, a JSX attribute, an
  export specifier alias, a labelled statement, a decorator argument. The red proof flips
  the default to "not a spelling" and these cells turn red (T15).
- A-2: the value shapes of the issue's first residual (a spread, `&&` / `||` / `??`, a
  helper's return in the same file, a computed key pinned by a `const`) fail `UNLISTED`
  under an unresolved receiver and under a non-token model. The same cells are run against
  the unmodified gate first and recorded green there (T6).
- A-3: a digest key in a filter on a `Reflect.get` receiver, and one in a two-hop `data`
  held in a variable, fail `UNLISTED`; recorded green on the unmodified gate.
- A-4: site counting is pinned by cells told apart by the `COUNT_MISMATCH` figure: a
  floating key inside a counted lookup call adds 0; nested floating keys add 1; two sibling
  floating keys add 2; a floating key in a nested named function inside a counted call's
  argument adds 1 under its own key; a floating-only function goes `STALE_ENTRY` once its
  key is placed (T1).
- A-4b: a helper returning `{ tokenHash: h }`, and one building it by assignment, is one
  site of the helper; a function in the same file and one in another file (named import)
  that call it fail `UNLISTED`. Allow cells: a same-named local function shadowing the
  import; a caller of a function that only reads the key; a caller of a caller; a method
  call, a namespace import and a builder passed as a value (SC6) (T17).
- A-5: placement axes: `data`, `select` and `omit` of a digest key pass on a resolved token
  model (including `updateMany`), and fail on a non-declaring model and on an unresolved
  receiver (T3).
- A-6: a recorded before/after table of every existing entry's `calls` on the real repo,
  each change with its reason. Both gates pass only when the manifest equals the computed
  figures, so the table is the diff of the manifest at the base commit against the new
  one (T1, T16).

### C2 — An unpinned computed key in a filter is opaque on every model

Control class: fail-closed for the positions the walk reads (no pass without a manifest
entry); tripwire overall.

A computed key `constString` cannot pin becomes opaque in every filter position the walk
reaches (`where`, `cursor`, `having`, relation filters, nested-write filters), whatever the
model. Other opacity reasons keep their token-model scoping: those are the 326-function
measurement. The walk's reach is unchanged: a call on an unresolved receiver is walked only
in a file that spells a digest key or holds a backslash (F8).

Acceptance:

- A-7: an unpinned computed key under each filter position fails on a resolved non-token
  model; the same key pinned by a `const` passes; the same unpinned key under `data` or
  `select` on a non-token model still passes.
- A-8: the real repo needs no new entry and no `calls` change for C2 (round-1 probe: none).

### C3 — Raw SQL: whole-row references and dynamic SQL

Control class: best-effort tripwire for the static rules. The run-time rule is a fail-closed
refusal inside `trustedSql` / `sqlIdentifier` (it throws; it cannot be skipped by the caller).

SQL-bearing literals (member set, derived from the raw methods the gate constrains): the
template of a `$queryRaw` / `$executeRaw` tag; the literal argument of an `Unsafe` call; a
`trustedSql` template; the literal argument of a `.query(...)` call (C5).

One decision, one adjudicator (S5, F3). A token table's name can reach SQL text two ways,
and each has exactly one judge:

- written in a literal: the static rules below, over `tokenizeSql`'s tokens;
- spliced as an identifier: the run-time mint. No rule reads rendered text for position.

Static definitions:

- Names compare case-insensitively when unquoted and exactly when quoted; a schema
  qualifier before a name is skipped.
- *Relation position*: a name directly after `FROM`, `JOIN`, `UPDATE`, `INTO` or `ONLY`,
  where that `FROM` is not part of `DISTINCT FROM`, `trim`, `extract`, `substring` or
  `overlay`, and the name is followed by an alias, a keyword of the closed follow-set, `,`,
  `)`, `;` or the end. A name followed by `::`, `[` or `(` is a value, not a relation (S4),
  except the column list after `INTO t` (F13).
- *Token relation*: a token table's name in relation position; in a `trustedSql` template,
  also a substitution in relation position. A quoted identifier holding a substitution is
  judged as that substitution.
- *Alias*: the name after a token relation, optionally after `AS`, that is not in the
  follow-set. The follow-set is a closed list in the gate (`WHERE`, `SET`, `ON`, `USING`,
  `VALUES`, `RETURNING`, the join and set-operation words, and so on). A word missing from
  it is read as an alias, which errs toward refusal (F2).
- Any token-table name elsewhere (a comma list, `FOR UPDATE OF`, `LOCK TABLE`, `TABLE t`)
  is not in relation position and is refused by W2.

Static rules. W1–W3 and W5 apply to a literal that names a token table (in a name token
or inside a string token) and to every `trustedSql` template (fragments compose). W4
applies to every SQL-bearing literal.

- W1: a `*` token other than `count(*)` fails.
- W2: a token table's name, or a token relation's alias, fails unless it is in relation
  position or qualifies a declared column: `t.<name>` where `<name>` is a column of that
  table in the schema, or, for the alias of a substitution relation, a column of some
  schema model. A substitution is not a column name (S14). `k.to_jsonb` is not a column, so it fails (S1). A
  qualifier that is itself a substitution (`${x}.<name>`) is W6's, not W2's (T19).
- W3: an alias followed by `(` fails (a column alias list renames the digest column).
- W4: dynamic SQL and object definitions fail: `EXECUTE`, `PREPARE`, a statement-initial
  `DO`, a `CREATE` or `ALTER` of a function, procedure, view, trigger or rule, and calls to
  `query_to_xml*`, `table_to_xml*`, `cursor_to_xml*`, `schema_to_xml*`, `database_to_xml*`,
  `dblink*` and `ts_stat`. This is independent of check-bypass-rls's writer rule; both deny.
- W5: a token table's name as a whole word, in any case, inside a string token fails: SQL
  carried as a string argument is invisible to W1–W3 (S3). This closes the class the W4
  function list only samples.
- W6, `trustedSql` templates only. The run-time mint knows which substitution is a table;
  only the lexer knows the syntax around it. So the lexer refuses, for any substitution:
  one after a `FROM` that is not a relation `FROM` (`DISTINCT FROM`, `trim`, `extract`,
  `substring`, `overlay`); one in relation position followed by `::`, `[` or `(`, the column list after
  `INTO ${t}` excepted as for a literal; a
  qualifier `${x}.<name>` whose name is not a column of some schema model (S14); and one directly adjacent to a word character (a letter, a digit, `_` or
  `$`) of the template's text (`api_${x}`), which would assemble a name from parts (S10,
  S11, F12).

Run-time rule (`src/lib/prisma/raw-sql.ts`):

- `TOKEN_TABLE_NAMES`: an exported frozen array of string literals. The gate fails unless
  its set equals the schema's token tables, in both directions.
- `sqlIdentifier(name)` refuses a member of `TOKEN_TABLE_NAMES`
  (`code: RAW_SQL_TOKEN_TABLE`).
- `sqlTable(name)` mints a table identifier for any table (same syntax and reserved-word
  rule as `sqlIdentifier`), kept in its own registry. `trustedSql` accepts one only where
  the template's own text puts it after `FROM`, `JOIN`, `UPDATE`, `INTO` or `ONLY` as a
  whole word in any case, across whitespace and an optional opening quote, or directly
  before `.` as a qualifier. Elsewhere it throws with the same code. `joinSql` does not
  accept one. A template part holding a comment marker (`--`, `/*`) directly before a table
  is refused, so a comment cannot supply the keyword (S15). The mint decides only "a table sits after a relation keyword or before a
  dot"; which keyword contexts and followers are relations is W6's decision, on the same
  template.
- check-raw-sql-usage's positional rule for the raw-sql names gains `sqlTable`; its
  self-test's module stubs and name-bound cells (forge, shadow, ordinary call) gain
  `sqlTable` twins, red-proved by removing the name from the rule (T13).
- Callers that splice a table switch to `sqlTable`: the retention-GC sweep and registry
  validation, and the audit-outbox worker's quoted table.

Invariants (app-enforced):

- I-C3a: no SQL-bearing literal in non-test `src` violates W1–W6.
- I-C3b: every statement the retention-GC worker renders from the real registry still
  renders. A test enumerates the whole registry, not a sample (T8).

Acceptance:

- A-9a: deny and allow cells for each of W1–W5, on a token-table literal, a non-token
  literal and a `trustedSql` template. Allow cells include the real shapes: the
  `password_shares` `UPDATE ... SET`, `INSERT INTO t (cols) VALUES`, `FROM ${table} WHERE (`
  with the keyword and the substitution split by a newline, the `mcp_refresh_tokens`
  `NOT EXISTS` subquery, `${parent}.id`, `count(*)`, `ON CONFLICT ... DO UPDATE`, a
  multiplication and `RETURNING *` on a non-token table, a quoted and a schema-qualified
  relation, and `execute` inside a comment or a string. Deny cells include `to_jsonb(t)`,
  `t::text`, `TABLE t`, `k.to_jsonb`, `FROM t::text`, a case-varied name, a comment-split
  name, each W6 form (`IS DISTINCT FROM ${t}`, `FROM ${t}::text`, `${t}.to_jsonb`,
  `"${t}".to_jsonb`, `api_${x}`), and for W5 a name in another case. W5 allow cells: a
  longer word containing the name, and a similar name. W6 allow cells: `INSERT INTO ${t}
  (cols)`, and a substitution next to a quote or a space. Each deny cell fires one rule
  only: W4's string-argument cells name no token table (that input is W5's), so each rule
  is red-proved alone (T3, T17, T19, T20).
- A-9b: `raw-sql` unit cells (T12): `sqlIdentifier` refuses each token table and still
  accepts every name it accepts today; `sqlTable`, for a token table and for another
  table, renders after each relation keyword (lower and mixed case, across a newline,
  inside quotes) and as a qualifier, and throws in a value position, after a word that
  merely ends in a keyword (`ts_from`), and next to another substitution; it obeys the
  syntax and reserved-word rules; forged look-alikes are refused as the existing forge
  cells do for identifiers; `joinSql` refuses it; the refusal carries its `code`; a tamper
  cell covers any newly captured built-in. `TOKEN_TABLE_NAMES` has gate cells for a missing name, an extra
  name, a non-literal element, and the exact set in another order (T4).
- A-9c: the real repo passes W1–W6 with no SQL rewritten other than the `sqlTable` switch;
  anything else is listed in the deviation log.

### C4 — Database objects defined in SQL files

Control class: best-effort tripwire with human classification. Adjudication authority:
`tokenizeSql` over each file, re-lexing every string token of a qualifying statement
(dollar-quoted or single-quoted), recursively.

Files read (S7): `prisma/migrations/*/migration.sql`, `infra/postgres/initdb/*.sql`,
`scripts/*.sql`. A file needs an entry in a new manifest section `sqlObjects` (keyed by repo
path, with a reason of at least `MIN_REASON` characters) when it holds

- a `CREATE` of a function, procedure, view, materialized view, trigger or rule whose
  statement or body names a token table or a digest column, or a function or procedure
  whose body holds a PL/pgSQL `EXECUTE` (a trigger's `EXECUTE FUNCTION` clause is not one)
  (F4);
- a `DO` block whose body creates one of those objects and names a token table or a digest
  column (F5);
- any statement that names a digest column and is not plain: `CREATE TABLE` without `AS`,
  `ALTER TABLE ... ADD COLUMN` without `GENERATED`, `ADD` / `DROP CONSTRAINT`, `CREATE
  INDEX`, `DROP`, and an `INSERT ... VALUES` holding no `SELECT` and no `ON CONFLICT ...
  DO UPDATE` (a seed; S17). A `REFERENCES` clause naming a digest
  column is not plain: it gives another column the digest's values (S12). So this covers a
  copy (`CREATE TABLE AS`, `SELECT INTO`, `INSERT ... SELECT`), a rename, a generated
  column, a foreign key and a policy (S6, F14).

A stale entry fails. A missing migrations directory or zero migrations read fails.

Schema checks, fatal:

- the columns of the digest-key fields equal the gate's digest-column set, in both
  directions, and a field mapped to a digest column is named a digest key (S6);
- a `view` block;
- a `@unique` (or `@@unique` member) `String` field whose name or column ends in `hash` or
  `digest`, on any model, is a digest key or is listed in a new manifest section
  `nonBearerHashFields` with a reason (S8). The predicate is narrow on purpose: unique
  fields such as `sessionToken`, `token` and `clientId` are sessions, one-time tokens and
  public identifiers, outside this gate's subject (S13);
- a `@relation` whose `references` lists a digest key (S12).

Acceptance:

- A-10: cells for each object kind and each qualifying statement form (deny without an
  entry, allow with one). Allow cells with no entry: each plain form naming a digest
  column, a routine on a non-token table, and a trigger with `EXECUTE FUNCTION` only; its
  deny twin is `EXECUTE` in a function body. Also a single-quoted body, a stale entry, a
  short reason, and each schema check in both directions (for the unique-field check: a
  non-unique field, a non-`String` field, a listed field, a `@@unique` member). Phase 2
  records the entries the real repo needs, with the file names (round-2 probe: the 5
  function-body migrations).

### C5 — pg driver `.query` and pool importers

Control class: best-effort tripwire.

- A call whose callee is a member named `query` (property access, optional chain, element
  access with a pinned key) must take a string literal or a no-substitution template as its
  first argument. That literal is a SQL-bearing literal (C3).
- The files that import `createPool` or `createClient` from `src/lib/db/pool-factory` must
  equal a new manifest section `pgPools` (file path to reason). The importer set is derived
  from the code on every run; the manifest is its human-reviewed copy, as `functions` is. In
  those files and in `pool-factory`, a reference to a member named `query` other than such a
  direct call fails (value reference, `.call` / `.apply` / `.bind`, destructuring).
- Any other way of loading `pool-factory` fails: a namespace or default import, a re-export,
  a dynamic import or `require`.

Acceptance:

- A-11: deny and allow cells for each callee form, each argument form, each reference form,
  each load form, an importer with no entry, a stale entry, and a fixture with no
  `pool-factory`. The real repo's `pgPools` lists the 4 importers.

### C6 — Manifest, header, summary line and self-test

- The manifest gains `sqlObjects`, `pgPools` and `nonBearerHashFields`; `functions` gains
  the entries C1 surfaces, each classified by reading the function.
- The gate's summary line prints the census and SQL counts (keys, placed, floating,
  SQL-bearing literals, literals naming a token table, SQL files read, qualifying files).
- The gate header's rule list and residual list are rewritten to match the implemented
  rules; the remaining residuals cite SC1–SC7.
- Self-test harness (T2, T5):
  - new deny cells use a helper that asserts the outcome exactly, in one of two forms: for
    violations, the set of whole failure lines and the count line; for a fatal check, the
    single `FAIL:` line and no violation summary. A cell's fixture produces one violation
    unless a pair is inherent (a builder and its caller, a name both missing and extra);
    such a cell declares the pair. SQL deny cells name no digest column, so the existing
    column rule does not co-fire. Existing cells keep their matching (T14).
  - the base fixture schema is rewritten to satisfy every schema check (`@map` on digest
    fields, `@@map` tables, a `replacedByHash` field). All existing cells stay green, the
    cells that swap the schema keep their messages, and each new schema deny cell changes
    one property (T11).
  - the base fixture gains a benign migration, a `raw-sql.ts` with `TOKEN_TABLE_NAMES` for
    the fixture schema, a `pool-factory`, and the new manifest sections; `fixture()` merges
    the new sections as it merges `models`. `BEARER_PASSKEY_GATE_ROOT` relocates the SQL
    file roots with the rest. There are cells for a missing or non-object section.
  - fixtures keep the existing acquire-then-`finally` temp-root shape.
- Red proofs (T6), on a scratch copy holding the gate, its libraries, the self-test and a
  resolvable `node_modules`, never on the real source. The deviation log records per
  clause: the base-green run on the scratch copy; the one-step mutation as a diff; the
  cells that turned red with their failure line; the unpiped exit status; and, at the end,
  `git status --short` of the real tree. Each rule is mutated in both directions: weakened
  (a deny cell must turn red) and widened (an allow cell must turn red).
- A-12: new `functions` entries on the real repo number fewer than 10 (expected 4).
- A-13: these pass: `npx vitest run` (it includes the gate self-test,
  `src/lib/prisma/raw-sql.test.ts` — whose exact export-surface assertion gains the new
  exports — the check-raw-sql-usage, sql-scan and check-bypass-rls self-tests, and the
  retention-GC and audit-outbox unit suites); `npx next build`; `npm run test:integration`
  against this worktree's own database; `bash scripts/pre-pr.sh`. Exit codes are read
  unpiped.

Forbidden patterns:

- pattern: `process.exit(0)` added in `check-bearer-passkey-gate.mjs` — reason: no early
  green exit.
- pattern: `isExported(` in `check-bearer-passkey-gate.mjs` — reason: builds a Program (VE1).
- pattern: `eslint-disable` — reason: no suppression in place of a fix.

## Testing strategy

- Gate self-test: the cells the acceptance criteria name. Every rule has a deny cell and an
  allow cell that differ in one axis.
- `raw-sql` unit tests: A-9b.
- Retention-GC and audit-outbox: unit and integration suites stay green; the only edits
  allowed to their expectations are the mint name.
- Red proofs and timing as C6 and R-5 state.

## Considerations and constraints

Scope contract:

- SC1 — a type-resolved pass for reflective delegate spellings (`Reflect.get`,
  `Object.values`, a returned delegate). Not built.
  - Worst case: a validator reaches a delegate reflectively and filters by a key that is
    never spelled; nothing is refused.
  - Likelihood: low. It needs both a reflective receiver and an unspelled key.
  - Cost to fix: a Program made this gate take about 36 s against 8 s (the #956 round-1
    measurement), and VE1 means delegate types do not resolve in `static-checks`.
- SC2 — opacity beyond one relation hop. Not built.
  - Worst case: an unreadable `data` two models from a token model hides a nested filter
    whose key is never spelled.
  - Likelihood: low; a spelled key is counted by C1 at any depth.
  - Cost to fix: 7 entries today and one for most future update routes on 34 more models
    (the #956 round-3 measurement).
- SC3 — a digest key that is never spelled as a key: built by concatenation or character
  codes, held inside longer string text (`JSON.parse`), or compared in JavaScript without
  naming the field (`Object.values(row)`).
  - Worst case: an ungated lookup the gate does not see.
  - Likelihood: low; each needs deliberate indirection in a reviewed validator.
  - Cost to fix: dataflow across files and types; a different control.
- SC4 — SQL the lexer cannot judge: an alias declared in one `trustedSql` fragment and used
  as a bare value in another; a table name assembled across two fragments; a table read as a
  value because another fragment supplies its context (a fragment before the table opening a
  FROM-syntax function, `trim(both` + ` from ${t})`, or a table-holding fragment embedded in
  another template) — the run-time mint judges each template's own text and does not refuse
  it, and the retention sweep's real templates place fragments before tables, so a rule
  forbidding that needs a fragment kind (code review S23); objects created by hand outside the three SQL roots; a
  database function called by a name that says nothing about what it reads (its definition
  is what C4 classifies).
  - Worst case: a whole-row lookup assembled from two fragments.
  - Likelihood: low; every file holding raw SQL is allowlisted one by one
    (`check-raw-sql-usage`) and reviewed.
  - Cost to fix: a SQL parser with catalog knowledge.
- SC5 — TypeScript outside the scan root (`scripts/`, `cli/`, `extension/`, `ios/`).
  - Worst case: an operator script looks a token up by digest. It runs with operator
    credentials outside the request path, so no user-bound bearer is validated there.
  - Likelihood: low; none of these trees validates a bearer for a request.
  - Cost to fix: a second scan root with its own manifest; `cli/` and `extension/` hold no
    Prisma client.
- SC6 — a filter builder reached other than by a direct call of a local function or a named
  import (S2): a method call, a namespace import, a re-export, a builder passed as a value,
  or a builder two calls away.
  - Worst case: a second validator reuses an acknowledged builder through such a spelling
    and an unresolved receiver, ungated, and the gate stays green. On a resolved token
    model `where: helper(h)` is already opaque and needs its own entry.
  - Likelihood: low. No function builds a digest filter outside a call today (round-1
    probe: the one floating property is a row passed to `refreshIosToken`).
  - Cost to fix: a call graph over values, which needs the type-resolved pass of SC1.
- SC7 — a pool handed out of an importer file and queried elsewhere through a non-call
  spelling of `query` (F10).
  - Worst case: `const q = pool.query.bind(pool)` in a module that received the pool.
  - Likelihood: low; the 4 importers pass the pool only to `createPrismaClient`.
  - Cost to fix: refusing every `.query` reference in `src`, which existing non-pg reads
    (`metadata.query`, `extra.query`) would fail.

Risks:

- A false refusal from W1–W5 on a future legitimate statement. The refusal names the rule;
  the remedy is to restate the SQL or use the query builder.

## User operation scenarios

- A developer adds a validator that finds its row with
  `tx.someToken.findFirst({ where: { ...(scoped && { tokenHash }) } })` through a delegate
  passed as a parameter. The gate fails `UNLISTED` and names the function and line.
- A developer adds `"tokenHash"` to a log-redaction list. The gate fails `UNLISTED`; they add
  an `exempt` entry with the reason.
- A developer writes `` $queryRaw`SELECT to_jsonb(k) FROM api_keys k WHERE ...` ``. The gate
  fails W2 at that literal.
- A migration adds `CREATE FUNCTION find_key(text) ... FROM api_keys ...`. The gate fails
  until the file is listed with a reason.
- A worker starts calling `pool.query(sql)` with a built string. The gate fails C5.
- A retention registry entry is added for a new token table. `sqlTable` renders it in
  `DELETE FROM`; a template that puts it in a value position throws at boot validation.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Digest-key spelling census | locked |
| C2 | Unpinned computed key opaque on every model | locked |
| C3 | Raw SQL whole-row references and dynamic SQL | locked |
| C4 | Database objects defined in SQL files | locked |
| C5 | pg `.query` and pool importers | locked |
| C6 | Manifest, header, summary line and self-test | locked |

## Implementation Checklist

Files to change:

- `scripts/checks/check-bearer-passkey-gate.mjs` — C1, C2, C3 static rules, C4, C5, summary
  line, header.
- `scripts/checks/bearer-passkey-gate-manifest.json` — new `functions` entries, `sqlObjects`,
  `pgPools`, `nonBearerHashFields`.
- `scripts/__tests__/check-bearer-passkey-gate.test.mjs` — base fixture, exact-outcome
  helper, new cells.
- `src/lib/prisma/raw-sql.ts` and `src/lib/prisma/raw-sql.test.ts` — `TOKEN_TABLE_NAMES`,
  `sqlTable`, `sqlIdentifier` refusal, `trustedSql` position check, `joinSql` refusal.
- `src/workers/retention-gc-worker/sweep.ts`, `index.ts`; `src/workers/audit-outbox-worker.ts`
  — table mints switch to `sqlTable`. Every test tree that mints a table is updated (R19).
- `scripts/checks/check-raw-sql-usage.mjs` and its self-test — `sqlTable` joins the names.
- `docs/archive/review/bearer-passkey-gate-coverage-deviation.md` — measurements, red
  proofs, deviations.

Shared utilities to reuse, not reimplement:

- `scripts/checks/lib/sql-scan.mjs` — `tokenizeSql`, `sqlInputFromNode`, `TOKEN`, `nameOf`.
- `scripts/checks/lib/prisma-relation-reach.mjs` — `loadPrismaSchema` (models, handles,
  tables, columns), `objectLiterals`.
- `scripts/checks/lib/scope-bindings.mjs` — `visibleBinding`, `bindingIndex`,
  `resolveLocalFunction`, `unwrapExpression`.
- `scripts/checks/lib/ast-project.mjs` — `createAstProject`, `sourceFiles`.
- In the gate: `attribute`, `constString`, `refersToImport`, `importsOf`, `resolveSpecifier`.

Patterns to follow:

- A missing input fails with `fatal()`; a rule violation goes through `failAt` / `failures`.
- Manifest sections carry a reason of at least `MIN_REASON` characters and fail when stale.
- Built-ins `raw-sql.ts` relies on are captured at load.

CI parity: the gate runs in `scripts/pre-pr.sh` (static section), which CI's `static-checks`
job runs with `PRE_PR_STATIC_ONLY=1` and no generated Prisma client. The gate self-test and
the `raw-sql` tests run in the vitest job. No CI-only gate covers these files.
