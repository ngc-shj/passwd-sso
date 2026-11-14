# Coding Deviation Log: bearer-passkey-gate-coverage

Batch B1: contracts C1 (digest-key spelling census) and C2 (unpinned computed key in a filter), the exact-outcome
self-test helper, the summary-line census counts, and acceptance A-1 to A-8 and A-12. C3 to C5 are a later batch.

## Census on the real repo (printed by the gate)

- `files=1095 token-models=13 analysed=45 manifest=45 digest-keys=60 placed=51 floating=9`.
- Keys by role: 14 plain properties and 37 shorthand properties (all 51 placed); 1 floating property, 5 member reads,
  3 equal strings. This equals the plan's 52 object-literal properties (51 placed, 1 floating), 5 member reads, 3 strings.
- Of the 9 floating keys, 3 sit inside a counted call or inside another floating key of the same function (add no site).
  The other 6 are the 6 sites below.
- Builders: the one floating write key (the row literal in `mobile/token/refresh/route.ts#handlePOST`) has no direct caller
  (`POST` wraps it as a value, SC6), so builder calls add zero sites. C2 changes no entry.

## Timing (median of 3, `node scripts/checks/check-bearer-passkey-gate.mjs`, interleaved, same machine)

- Before (HEAD gate): 7.96 s (8.04, 7.96, 7.84). After: 8.17 s (8.17, 7.83, 8.17). About +0.2 s. The plan's R-5 expects under 2 s and records the figure; it is a measurement, not an enforced bound.
- The machine was heavily loaded by other jobs at other times: runs of 14 to 20 s were discarded as not comparable.

## A-6: existing entries whose `calls` changed

| Entry | Old | New | Reason |
|-------|-----|-----|--------|
| `src/app/api/mobile/token/refresh/route.ts#handlePOST` | 1 | 2 | the row literal `{ ..., tokenHash: oldRow.tokenHash }` handed to `refreshIosToken` is one floating property |

No other existing entry changed (`git diff` of the manifest: that count, its reason text, and the `$comment`).

## New manifest entries (4, below the A-12 bound of 10)

| Key | Calls | Class | Why |
|-----|-------|-------|-----|
| `src/lib/auth/tokens/mobile-token.ts#refreshIosToken` | 1 | refresh-bound | It reads `oldRow.tokenHash` (the row the route looked up) only as its retry-cache key; no lookup. It is the mint, and it gates inline with `passkeyEnforcementBlocks` before `issueIosToken`; the existing class fits (same refresh route, lifetime and self as inline gate as the handler's entry), and its inline gate is checked mechanically |
| `src/lib/emergency-access/emergency-access-state.ts#hasResourceScope` | 1 | exempt | Reads `where.tokenHash !== undefined` as a scope guard that refuses an unscoped state change under bypass RLS; no lookup, grants nothing |
| `src/lib/audit/audit-logger.ts#METADATA_BLOCKLIST` | 1 | exempt | A list of metadata keys to strip from logs |
| `src/lib/logger/redact-keys.ts#SECRET_REDACT_KEYS` | 2 | exempt | A list of keys pino redacts (`tokenHash`, `codeHash`) |

No existing class was forced: `exempt` takes a reason only, and `refresh-bound` fit `refreshIosToken`.

## A-2 / A-3 on the unmodified gate

The 30 cells of the `formerly unread shapes (A-2, A-3)` describe (deny cells and their `id` twins) were run against
`git show HEAD:scripts/checks/check-bearer-passkey-gate.mjs` in a scratch tree, with the violation helper replaced by an
exit-0 assertion: 30 passed, 0 failed, exit 0. So each deny fixture is accepted by the old gate and refused by the new one.
- A-3 reading: a `Reflect.get(...)` receiver with a plain `where: { tokenHash }` was already a lookup before this change, so
  the cell holds the key in a `where` variable that is assigned into (unreadable to the walk), which the old gate accepted.
  The "two-hop data held in a variable" cell is built the same way (an assigned-into object, a model two hops from a token model).

## Red proofs (scratch copy only)

- Scratch tree `scratchpad/slot0..3`: copies of the gate, `lib/`, manifest and self-test; symlinks to `node_modules`, `src`, `prisma`.
- Base green: 485 passed, 0 failed, exit 0. Deliberate syntax error appended to the scratch gate: 0 passed, 485 failed, exit 1
  (so the test loads the scratch gate). Restored; byte-identical to the real gate (`cmp`).
- 81 one-step mutations, each applied to the scratch gate alone, then the full self-test run (`--reporter=json`).
  Every mutation turned at least one cell red; none needed a new cell. "weaken" = the gate detects less (a deny cell turns
  red); "widen" = it detects more (an allow cell turns red). The red count and two example cells follow; each edit is
  `muts.mjs` in the scratchpad (a single replacement, two for the multi-part ones). Exit status is the vitest exit code
  (1 for every row, i.e. the suite was red).
- Equivalent mutant noted, not proven: the `getFullText().includes(b.name)` pre-filter in the consumer pass is a speed guard
  (no consumer can exist in a file lacking the builder's name), so no cell can tell it apart.
- Cells added during this work to give mutations something to turn red (before the run): a binding used as a member receiver,
  an initializer read, a class `extends` of a binding and of an unresolved name, an `implements` name, an export of a local,
  `include` as a non-projection, builders by string-literal / shorthand / computed property, callers of a reader that
  compares or copies the key, a caller of a function that only lists the key, a floating key after the counted call,
  a floating key in a named function inside another floating key, and nested computed keys.

| Mutation | Direction | Red cells | Examples (cell names) | Exit |
|----------|-----------|-----------|-----------------------|------|
| type-arm-widen | widen | 7 | digest-key spelling census — roles (A-1) passes on a name in an implements clause (a type…; digest-key spelling census — roles (A-1) passes on a type alias member (a type position, … | 1 |
| type-arm-weaken | weaken | 63 | lookups, whatever the receiver passes on a digest key outside any filter position once it…; the summary line and the fatal outcome prints the census on the base fixture: both lookup… | 1 |
| typedecl-widen | widen | 1 | digest-key spelling census — roles (A-1) passes on an interface member and a parameter an… | 1 |
| typenode-widen | widen | 2 | digest-key spelling census — roles (A-1) passes on a type argument (a type position, not …; digest-key spelling census — roles (A-1) passes on an interface member and a parameter an… | 1 |
| extends-weaken | weaken | 1 | digest-key spelling census — roles (A-1) FAILS on a class's extends expression with no vi… | 1 |
| extends-widen | widen | 1 | digest-key spelling census — roles (A-1) passes on a name in an implements clause (a type… | 1 |
| binding-declared-widen | widen | 14 | lookups, whatever the receiver FAILS on a digest key in a shorthand key; digest-key spelling census — roles (A-1) FAILS on a shorthand property over a local bindi… | 1 |
| ref-weaken | weaken | 2 | digest-key spelling census — roles (A-1) FAILS on a reference with no visible binding; digest-key spelling census — roles (A-1) FAILS on a class's extends expression with no vi… | 1 |
| ref-widen | widen | 12 | digest-key spelling census — roles (A-1) FAILS on a destructured property; digest-key spelling census — roles (A-1) passes on a const and its reference (a binding, … | 1 |
| initializer-widen | widen | 2 | digest-key spelling census — roles (A-1) passes on a const read as an initializer (a bind…; real repository passes against the real repo | 1 |
| valueparents-widen | widen | 12 | digest-key spelling census — roles (A-1) FAILS on a destructured property; digest-key spelling census — roles (A-1) FAILS on a reference with no visible binding | 1 |
| valueparents-weaken | weaken | 2 | digest-key spelling census — roles (A-1) FAILS on a reference with no visible binding; digest-key spelling census — roles (A-1) FAILS on a class's extends expression with no vi… | 1 |
| extargs-widen | widen | 2 | digest-key spelling census — roles (A-1) FAILS on a class's extends expression with no vi…; digest-key spelling census — roles (A-1) passes on a const extended by a class (a binding… | 1 |
| default-weaken | weaken | 9 | digest-key spelling census — roles (A-1) FAILS on a method (attributed to itself, a named…; digest-key spelling census — roles (A-1) FAILS on an accessor (attributed to itself, a na… | 1 |
| strprop-weaken | weaken | 3 | digest-key spelling census — roles (A-1) FAILS on a string-literal property; digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building… | 1 |
| computed-weaken | weaken | 4 | digest-key spelling census — roles (A-1) FAILS on a computed property naming a string; digest-key spelling census — site counting (A-4) adds 1 for nested computed floating keys… | 1 |
| computed-write-weaken | weaken | 2 | digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building…; digest-key spelling census — builders and their callers (A-4b) passes when both are liste… | 1 |
| elem-weaken | weaken | 3 | digest-key spelling census — roles (A-1) FAILS on an element read; digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building… | 1 |
| elem-write-weaken | weaken | 2 | digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building…; digest-key spelling census — builders and their callers (A-4b) passes when both are liste… | 1 |
| string-weaken | weaken | 22 | lookups, whatever the receiver FAILS on a computed key bound by let (an unpinned key: flo…; digest-key spelling census — roles (A-1) FAILS on a computed property named by a const | 1 |
| prop-weaken | weaken | 60 | lookups, whatever the receiver passes on a digest key outside any filter position once it…; the summary line and the fatal outcome prints the census on the base fixture: both lookup… | 1 |
| prop-write-weaken | weaken | 8 | formerly unread shapes (A-2, A-3) FAILS on a helper's return as the where, as the helper …; digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building… | 1 |
| shorthand-weaken | weaken | 3 | digest-key spelling census — roles (A-1) FAILS on a shorthand property over a local bindi…; digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building… | 1 |
| shorthand-write-weaken | weaken | 2 | digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building…; digest-key spelling census — builders and their callers (A-4b) passes when both are liste… | 1 |
| member-weaken | weaken | 8 | digest-key spelling census — roles (A-1) FAILS on a member read; digest-key spelling census — roles (A-1) FAILS on a member assignment | 1 |
| member-write-weaken | weaken | 2 | digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building…; digest-key spelling census — builders and their callers (A-4b) passes when both are liste… | 1 |
| member-receiver-widen | widen | 1 | digest-key spelling census — roles (A-1) passes on a const used as a member receiver (a b… | 1 |
| bindelem-propname-weaken | weaken | 1 | digest-key spelling census — roles (A-1) FAILS on a renamed destructured property | 1 |
| bindelem-shorthand-weaken | weaken | 1 | digest-key spelling census — roles (A-1) FAILS on a destructured property | 1 |
| bindelem-renamed-widen | widen | 1 | digest-key spelling census — roles (A-1) passes on a renamed destructuring target (a bind… | 1 |
| bindelem-array-widen | widen | 1 | digest-key spelling census — roles (A-1) passes on an array destructuring element (a bind… | 1 |
| import-spec-widen | widen | 1 | digest-key spelling census — roles (A-1) passes on an import specifier named as a digest … | 1 |
| export-ref-widen | widen | 1 | digest-key spelling census — the default arm (A-1b) passes on an export specifier that ex… | 1 |
| export-alias-weaken | weaken | 1 | digest-key spelling census — the default arm (A-1b) FAILS on an export specifier alias (w… | 1 |
| assign-weaken | weaken | 4 | digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building…; digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building… | 1 |
| assign-widen-kind | widen | 3 | digest-key spelling census — builders and their callers (A-4b) passes on a caller of a fu…; digest-key spelling census — builders and their callers (A-4b) passes on a caller of a fu… | 1 |
| assign-widen-left | widen | 1 | digest-key spelling census — builders and their callers (A-4b) passes on a caller of a fu… | 1 |
| assign-widen-op | widen | 2 | digest-key spelling census — builders and their callers (A-4b) passes on a caller of a fu…; real repository passes against the real repo | 1 |
| callarg-weaken | weaken | 4 | digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building…; digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building… | 1 |
| callarg-widen | widen | 1 | digest-key spelling census — builders and their callers (A-4b) passes on a caller of a fu… | 1 |
| callarg-wrappers-weaken | weaken | 2 | digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building…; digest-key spelling census — builders and their callers (A-4b) passes when both are liste… | 1 |
| place-lookup-widen | widen | 303 | inputs passes on the base fixture and prints the analysed count; digest lookup detection passes when that function is listed | 1 |
| place-pinned-widen | widen | 1 | lookups, whatever the receiver FAILS on a computed digest key spelled through a const-bou… | 1 |
| place-write-widen | widen | 11 | lookups, whatever the receiver passes on a digest written as data (a write, not a lookup); lookups, whatever the receiver passes on a replacedByHash written as data (the rotation C… | 1 |
| place-write-weaken | weaken | 14 | digest-key spelling census — site counting (A-4) is not stale while the same write is on …; digest-key spelling census — site counting (A-4) never lets a floating key satisfy model … | 1 |
| place-select-widen | widen | 3 | digest-key placement (A-5) passes on a select of a digest key on a model declaring it; digest-key placement (A-5) passes on a select under a relation whose relation resolves to… | 1 |
| place-select-weaken | weaken | 3 | digest-key placement (A-5) FAILS on a select of a digest key on a model that does not dec…; digest-key placement (A-5) FAILS on a select of a digest key on an unresolved receiver | 1 |
| place-include-weaken | weaken | 1 | digest-key placement (A-5) FAILS on a digest key under an include (a projection for place… | 1 |
| place-omit-widen | widen | 1 | digest-key placement (A-5) passes on an omit of a digest key on a model declaring it | 1 |
| place-omit-weaken | weaken | 2 | digest-key placement (A-5) FAILS on an omit of a digest key on a model that does not decl…; digest-key placement (A-5) FAILS on an omit of a digest key on an unresolved receiver | 1 |
| place-declares-weaken | weaken | 19 | digest-key spelling census — site counting (A-4) is not stale while the same write is on …; digest-key spelling census — site counting (A-4) never lets a floating key satisfy model … | 1 |
| place-declares-widen | widen | 14 | lookups, whatever the receiver passes on a digest written as data (a write, not a lookup); lookups, whatever the receiver passes on a replacedByHash written as data (the rotation C… | 1 |
| pmodel-top-widen | widen | 5 | lookups, whatever the receiver passes on a replacedByHash written as data (the rotation C…; digest-key placement (A-5) passes on an updateMany data of a digest key on a model declar… | 1 |
| pmodel-nested-widen | widen | 1 | digest-key placement (A-5) passes on a nested updateMany's data whose relation resolves t… | 1 |
| place-merge-widen | widen | 14 | lookups, whatever the receiver passes on a digest written as data (a write, not a lookup); lookups, whatever the receiver passes on a replacedByHash written as data (the rotation C… | 1 |
| cover-call-weaken | weaken | 4 | digest-key spelling census — site counting (A-4) adds 0 for a floating key inside a count…; digest-key spelling census — site counting (A-4) FAILS that cell when the manifest counts… | 1 |
| cover-call-widen | widen | 2 | digest-key spelling census — site counting (A-4) adds 1 under its own key for a floating …; digest-key spelling census — site counting (A-4) passes once that nested function has its… | 1 |
| cover-floating-weaken | weaken | 4 | digest-key spelling census — site counting (A-4) adds 1 for nested computed floating keys…; digest-key spelling census — site counting (A-4) adds 1 for nested floating keys (the inn… | 1 |
| cover-floating-widen | widen | 2 | digest-key spelling census — site counting (A-4) adds 1 under its own key for a floating …; digest-key spelling census — site counting (A-4) passes once both functions are listed | 1 |
| within-widen | widen | 6 | lookups, whatever the receiver passes on a digest key outside any filter position once it…; digest-key spelling census — the default arm (A-1b) FAILS on a labelled statement and its… | 1 |
| span-weaken | weaken | 4 | digest-key spelling census — site counting (A-4) adds 1 for nested computed floating keys…; digest-key spelling census — site counting (A-4) adds 1 for nested floating keys (the inn… | 1 |
| span-computed-weaken | weaken | 1 | digest-key spelling census — site counting (A-4) adds 1 for nested computed floating keys… | 1 |
| floating-site-weaken | weaken | 38 | lookups, whatever the receiver passes on a digest key outside any filter position once it…; the summary line and the fatal outcome counts a floating key in the summary line | 1 |
| unattributed-weaken | weaken | 4 | digest-key spelling census — roles (A-1) FAILS on a class member outside any function wit…; digest-key spelling census — roles (A-1) FAILS on a non-exported top-level const holding … | 1 |
| coverage-widen | widen | 116 | lookups, whatever the receiver FAILS on a computed key bound by let (an unpinned key: flo…; lookups, whatever the receiver passes on a digest key outside any filter position once it… | 1 |
| builder-weaken | weaken | 22 | formerly unread shapes (A-2, A-3) FAILS on a helper's return as the where, as the helper …; digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building… | 1 |
| builder-widen | widen | 5 | digest-key spelling census — builders and their callers (A-4b) passes on a caller of a fu…; digest-key spelling census — builders and their callers (A-4b) passes on a caller of a fu… | 1 |
| consumer-site-weaken | weaken | 10 | digest-key spelling census — builders and their callers (A-4b) passes when both are liste…; digest-key spelling census — builders and their callers (A-4b) passes when both are liste… | 1 |
| consumer-local-weaken | weaken | 20 | formerly unread shapes (A-2, A-3) FAILS on a helper's return as the where, as the helper …; digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building… | 1 |
| consumer-local-widen | widen | 2 | digest-key spelling census — builders and their callers (A-4b) passes on a caller of a ca…; real repository passes against the real repo | 1 |
| consumer-import-weaken | weaken | 2 | digest-key spelling census — builders and their callers (A-4b) FAILS on the caller of a b…; digest-key spelling census — builders and their callers (A-4b) FAILS on the caller throug… | 1 |
| consumer-import-widen | widen | 1 | digest-key spelling census — builders and their callers (A-4b) passes on a same-named loc… | 1 |
| consumer-callee-widen | widen | 2 | digest-key spelling census — builders and their callers (A-4b) passes on a method call of…; digest-key spelling census — builders and their callers (A-4b) passes on a call through a… | 1 |
| onelevel-widen | widen | 1 | digest-key spelling census — builders and their callers (A-4b) passes on a caller of a ca… | 1 |
| c2-weaken | weaken | 18 | lookups, whatever the receiver FAILS on a computed key bound by let (an unpinned key: flo…; an unpinned computed key in a filter (A-7) FAILS on an unpinned computed key in a where o… | 1 |
| c2-widen | widen | 97 | digest lookup detection does not analyse a where without a digest key (passes unlisted); digest lookup detection does not analyse a cursor without a digest key (passes unlisted) | 1 |
| c2-unresolved-weaken | weaken | 2 | lookups, whatever the receiver FAILS on a computed key bound by let (an unpinned key: flo…; an unpinned computed key in a filter (A-7) FAILS on an unpinned computed key in a where o… | 1 |
| c2-where-weaken | weaken | 16 | lookups, whatever the receiver FAILS on a computed key bound by let (an unpinned key: flo…; an unpinned computed key in a filter (A-7) FAILS on an unpinned computed key in a where o… | 1 |
| c2-relation-weaken | weaken | 2 | an unpinned computed key in a filter (A-7) FAILS on an unpinned computed key in a direct …; an unpinned computed key in a filter (A-7) passes once the opaque position is listed opaq… | 1 |
| helper-dup-violation | weaken | 83 | lookups, whatever the receiver FAILS on a computed key bound by let (an unpinned key: flo…; the summary line and the fatal outcome reports violations as the exact set of lines plus … | 1 |
| helper-fatal-summary | weaken | 1 | the summary line and the fatal outcome stops on a single FAIL line, and no violation summ… | 1 |

`git status --short` of the real tree at the end holds only this batch's files and the other agent's (raw-sql, workers,
check-raw-sql-usage); no mutation touched it.

## Deviations from the plan

- Existing cells changed because C1 / C2 make their old expectation a deny: "digest written as data" and "replacedByHash
  written as data" now use a resolved declaring receiver (`tx.apiKey`, `tx.extensionToken` with a schema that declares
  `replacedByHash` swapped into that one cell); "digest key outside any filter position" is now listed with `calls: 2`;
  "computed key bound by let on an unresolved receiver (declared residual)" is now a deny (floating string plus opaque filter).
  All other existing cells are untouched and green.
- C2 applies to an unresolved receiver too (the plan's reach sentence only matters if it does); the label reads `unresolved`.
- A builder call is counted as a site even when it sits inside a counted call of the same function (the plan states the
  same-key exemption for keys only).
- `callers of a class's extends` and a few other value positions are in the reference arm (`ExpressionWithTypeArguments`);
  a decorator argument string is a `string` key, not a default-arm one, so A-1b's decorator pin is a role cell.
- The census runs only on files where `mayHoldDigestKey` holds (a digest word or a backslash), the same reach the walk has.
- The direct to-one relation callback keeps `opaqueIf` (it only receives logical spreads, where C2 has nothing to add).
- Failure text: UNLISTED names floating keys and builder calls only when there are some (existing cell patterns keep matching);
  COUNT_MISMATCH always names all four counts.

# Batch B2: C3 static SQL rules, C4, C5, remaining C6 items

## Real-repo figures (summary line)

- `files=1095 token-models=13 analysed=45 manifest=45 digest-keys=60 placed=51 floating=9 sql-literals=136 token-table-literals=7 sql-files=228 sql-qualifying=5`.
- 136 SQL-bearing literals and 7 naming a token table: the plan's probe figures. No W1-W6 refusal on any real literal, and no SQL in `src` rewritten (A-9c).
- SQL files read: 217 migration files + 4 initdb + 7 `scripts/*.sql` (228; `ls prisma/migrations/*/migration.sql | wc -l`, `ls infra/postgres/initdb/*.sql | wc -l`, `ls scripts/*.sql | wc -l`). Exactly the 5 function-body migrations qualify (the plan's probe). No `nonBearerHashFields` entry is needed. The schema checks pass as is.
- Timing (median of 3, interleaved): B1 state 7.73 s, B2 state 8.02 s (+0.3 s).

## New manifest entries

- `sqlObjects` (5), each written after reading the migration:
  - `20260227050000_tenant_id_trigger_defaults_phase8`: the tenant-resolution and enforcement functions and the triggers on every table; they fill or check `tenant_id` from the owning row's user, team or entry id; token tables appear only as names in lists.
  - `20260228020000_force_rls_and_scim_trigger_phase9`: redefines `resolve_tenant_id_from_row` (adds `scim_group_mappings`); returns a tenant id.
  - `20260321110000_convert_id_columns_to_uuid_type`: the same function with uuid casts.
  - `20261102000000_share_creator_admitted` and `20261108000000_share_admission_policy_and_personal_entry`: `share_creator_admitted(share id)` reads one `password_shares` row by id plus team entry, membership and policy rows and returns a boolean; it never selects by the share's digest.
- `pgPools` (4): `src/lib/prisma.ts`, `src/workers/audit-anchor-publisher.ts`, `src/workers/audit-outbox-worker.ts`, `src/workers/retention-gc-worker/index.ts`; each builds a pool for `createPrismaClient` and never calls `pool.query`.
- `nonBearerHashFields`: empty.

## Self-test

- Cells: 485 before B2, 755 after. The base fixture schema was rewritten (`@map` on digest fields, `@@map` tables, a `replacedByHash` field on `ExtensionToken`); all 485 cells stayed green and the B1 cell that swapped a schema is simplified. The base fixture gained a benign migration, `raw-sql.ts` with `TOKEN_TABLE_NAMES`, a `pool-factory`, and the three manifest sections (merged by `fixture()` like `models`).
- Verification, exit codes: gate 0; `vitest` on the gate self-test 0 (755 passed); `check-raw-sql-usage.mjs` 0; `check-gate-selftest-coverage.sh` 0; `check-mjs-imports.mjs` 0; `vitest` on `sql-scan` and `check-raw-sql-usage` self-tests 0 (317 passed); eslint on the gate 0; `check-doc-paths.mjs` 0. `lib/` is untouched.

## Red proofs (scratch copy `scratchpad/batchB2/slot0..3`, only the SQL-related cells selected with `-t`)

- Base green on the scratch copy: 288 selected cells, 0 failed. A deliberate syntax error in the scratch gate: 0 passed, 288 failed (the test loads the scratch gate). Restored; `cmp` identical to the real gate.
- 159 one-step mutations of the scratch gate, one per clause arm in both directions where an arm has both; each followed by the selected cells. Every mutation turned at least one cell red (exit 1) except one equivalent mutant, below. "weaken" = detects less, "widen" = detects more.
- Mutations that first turned nothing red and were fixed by adding a cell to the real self-test, then re-run red: `lit-trusted-import-widen` (aliased import / local function of the name), `tokenrel-sub-widen` and `tokenrel-widen` (a bound-parameter relation, and a non-token alias, next to a token table), `w5-boundary-widen` (a name that ends a longer word), `w6-trusted-widen` (`DISTINCT FROM ${t}` in a `$queryRaw`), `schema-unique-name-weaken` (a field named `...Hash` mapped to another column), `plain-insert-select-weaken` (INSERT ... VALUES holding a SELECT), `w5-case-weaken` (spec fixed).
- (Corrected in "Self-check fixes" below: `sqlobj-dollar-body-weaken` is not an equivalent mutant; a tight-glued dollar body separates it.)
- `ONLY` special-casing in `sqlRelations` was equivalent (ONLY is itself a relation keyword), so the line was deleted rather than proved.
- Result per mutation (red count; two example cells; exit status is 1 for every row):

| Mutation | Direction | Red cells | Examples (cell names) | Exit |
|----------|-----------|-----------|-----------------------|------|
| lit-tag-weaken | weaken | 26 | raw SQL: W1 whole-row projections FAILS on a * on a token table; raw SQL: W1 whole-row projections FAILS on a qualified .* on a token alias | 1 |
| lit-trusted-weaken | weaken | 19 | raw SQL: W1 whole-row projections FAILS on a * in a trustedSql template that names no tok…; raw SQL: W2 a token table's name or alias outside relation position FAILS on an alias of … | 1 |
| lit-trusted-import-widen | widen | 2 | raw SQL: trustedSql is recognised by import, not by spelling FAILS on a trustedSql templa…; raw SQL: trustedSql is recognised by import, not by spelling passes on a local function o… | 1 |
| lit-unsafe-weaken | weaken | 14 | raw SQL: W1 whole-row projections FAILS on RETURNING * on a token table; raw SQL: W4 dynamic SQL and object definitions FAILS on EXECUTE in a literal that names n… | 1 |
| lit-query-weaken | weaken | 1 | the pg driver's query and pool factory (A-11) reads the literal argument as SQL (a * on a… | 1 |
| query-nonliteral-weaken | weaken | 9 | the pg driver's query and pool factory (A-11) a property access with a variable; the pg driver's query and pool factory (A-11) a property access with a template with a su… | 1 |
| query-prop-weaken | weaken | 7 | the pg driver's query and pool factory (A-11) a property access with a variable; the pg driver's query and pool factory (A-11) a property access with a template with a su… | 1 |
| query-elem-weaken | weaken | 3 | the pg driver's query and pool factory (A-11) an element access with a pinned key with a …; the pg driver's query and pool factory (A-11) an element access with a pinned key with a … | 1 |
| names-name-weaken | weaken | 24 | raw SQL: W1 whole-row projections FAILS on a * on a token table; raw SQL: W1 whole-row projections FAILS on a qualified .* on a token alias | 1 |
| names-string-weaken | weaken | 3 | raw SQL: W5 a token table's name inside a string FAILS on a token table named in a string; raw SQL: W5 a token table's name inside a string FAILS on a name in another case | 1 |
| gate-trusted-weaken | weaken | 19 | raw SQL: W1 whole-row projections FAILS on a * in a trustedSql template that names no tok…; raw SQL: W2 a token table's name or alias outside relation position FAILS on an alias of … | 1 |
| gate-names-widen | widen | 3 | raw SQL: W1 whole-row projections passes on a * in a literal that names no token table; raw SQL: W1 whole-row projections passes on RETURNING * on a table that is not a token ta… | 1 |
| w4-execute-weaken | weaken | 2 | raw SQL: W4 dynamic SQL and object definitions FAILS on EXECUTE in a literal that names n…; raw SQL: W4 dynamic SQL and object definitions FAILS on EXECUTE in a trustedSql template | 1 |
| w4-prepare-weaken | weaken | 1 | raw SQL: W4 dynamic SQL and object definitions FAILS on PREPARE in a literal that names n… | 1 |
| w4-do-weaken | weaken | 1 | raw SQL: W4 dynamic SQL and object definitions FAILS on a statement-initial DO in a liter… | 1 |
| w4-do-widen | widen | 3 | raw SQL: W2 a token table's name or alias outside relation position passes on ON CONFLICT…; raw SQL: W4 dynamic SQL and object definitions FAILS on CREATE RULE in a literal that nam… | 1 |
| w4-create-weaken | weaken | 5 | raw SQL: W4 dynamic SQL and object definitions FAILS on CREATE FUNCTION in a literal that…; raw SQL: W4 dynamic SQL and object definitions FAILS on CREATE OR REPLACE VIEW in a liter… | 1 |
| w4-alter-weaken | weaken | 1 | raw SQL: W4 dynamic SQL and object definitions FAILS on ALTER FUNCTION in a literal that … | 1 |
| w4-modifiers-weaken | weaken | 2 | raw SQL: W4 dynamic SQL and object definitions FAILS on CREATE OR REPLACE VIEW in a liter…; raw SQL: W4 dynamic SQL and object definitions FAILS on CREATE MATERIALIZED VIEW in a lit… | 1 |
| w4-kinds-widen | widen | 1 | raw SQL: W4 dynamic SQL and object definitions passes on CREATE TABLE and ALTER TABLE | 1 |
| w4-call-weaken | weaken | 4 | raw SQL: W4 dynamic SQL and object definitions FAILS on query_to_xml(...) in a literal th…; raw SQL: W4 dynamic SQL and object definitions FAILS on table_to_xml_and_xmlschema(...) i… | 1 |
| w4-call-widen | widen | 1 | raw SQL: W4 dynamic SQL and object definitions passes on a column named like dblink witho… | 1 |
| w4-tsstat-weaken | weaken | 1 | raw SQL: W4 dynamic SQL and object definitions FAILS on ts_stat(...) in a literal that na… | 1 |
| rel-distinct-weaken | weaken | 1 | raw SQL: W6 the syntax around a substituted table FAILS on IS DISTINCT FROM <substitution> | 1 |
| rel-fromfn-weaken | weaken | 2 | raw SQL: W6 the syntax around a substituted table FAILS on trim(x FROM <substitution>); raw SQL: W6 the syntax around a substituted table FAILS on extract(f FROM <substitution>) | 1 |
| rel-from-widen | widen | 49 | raw SQL: W1 whole-row projections FAILS on a * on a token table; raw SQL: W1 whole-row projections FAILS on a qualified .* on a token alias | 1 |
| rel-update-weaken | weaken | 1 | raw SQL: relation position, alias and qualifier arms FAILS on FOR UPDATE <token table> (a… | 1 |
| rel-chain-widen | widen | 2 | raw SQL: W2 a token table's name or alias outside relation position FAILS on an alias on …; raw SQL: W2 a token table's name or alias outside relation position passes on a schema-qu… | 1 |
| rel-comma-widen | widen | 1 | raw SQL: relation position, alias and qualifier arms passes on a relation followed by a c… | 1 |
| rel-rparen-widen | widen | 1 | raw SQL: relation position, alias and qualifier arms passes on a relation ended by a clos… | 1 |
| rel-semi-widen | widen | 1 | raw SQL: relation position, alias and qualifier arms passes on a relation ended by a semi… | 1 |
| rel-into-widen | widen | 4 | raw SQL: W2 a token table's name or alias outside relation position passes on INSERT INTO…; raw SQL: W2 a token table's name or alias outside relation position passes on ON CONFLICT… | 1 |
| rel-paren-weaken | weaken | 1 | raw SQL: W6 the syntax around a substituted table FAILS on <substitution>(args) in relati… | 1 |
| rel-qident-widen | widen | 2 | raw SQL: relation position, alias and qualifier arms FAILS on a quoted alias in a value p…; raw SQL: relation position, alias and qualifier arms passes on a quoted alias qualifying … | 1 |
| rel-value-weaken | weaken | 3 | raw SQL: W6 the syntax around a substituted table FAILS on <substitution>::text in relati…; raw SQL: W6 the syntax around a substituted table FAILS on <substitution>(args) in relati… | 1 |
| rel-cast-weaken | weaken | 1 | raw SQL: W6 the syntax around a substituted table FAILS on <substitution>::text in relati… | 1 |
| rel-subscript-weaken | weaken | 1 | raw SQL: relation position, alias and qualifier arms FAILS on <substitution>[1] in relati… | 1 |
| alias-as-weaken | weaken | 1 | raw SQL: W3 a column alias list on a token relation FAILS on AS alias(columns) after a to… | 1 |
| alias-follow-weaken | weaken | 1 | raw SQL: W2 a token table's name or alias outside relation position passes on FROM <subst… | 1 |
| alias-qident-weaken | weaken | 1 | raw SQL: relation position, alias and qualifier arms FAILS on a quoted alias in a value p… | 1 |
| tokenrel-sub-weaken | weaken | 3 | raw SQL: W2 a token table's name or alias outside relation position FAILS on an alias of …; raw SQL: W2 a token table's name or alias outside relation position FAILS on an alias of … | 1 |
| tokenrel-sub-widen | widen | 1 | raw SQL: relation position, alias and qualifier arms passes on a bound-parameter relation… | 1 |
| tokenrel-widen | widen | 2 | raw SQL: relation position, alias and qualifier arms passes on a bound-parameter relation…; raw SQL: relation position, alias and qualifier arms passes on the alias of a table that … | 1 |
| w3-weaken | weaken | 2 | raw SQL: W3 a column alias list on a token relation FAILS on AS alias(columns) after a to…; raw SQL: W3 a column alias list on a token relation FAILS on alias(columns) after a subst… | 1 |
| w1-weaken | weaken | 8 | raw SQL: W1 whole-row projections FAILS on a * on a token table; raw SQL: W1 whole-row projections FAILS on a qualified .* on a token alias | 1 |
| w1-count-widen | widen | 4 | raw SQL: W1 whole-row projections passes on count(*) on a token table; raw SQL: W1 whole-row projections passes on count(*) in a trustedSql template | 1 |
| w1-count-weaken | weaken | 1 | raw SQL: relation position, alias and qualifier arms FAILS on max(*) (only count(*) is ex… | 1 |
| w1-line-weaken | weaken | 2 | raw SQL: relation position, alias and qualifier arms FAILS on a * on the second line of a…; raw SQL: relation position, alias and qualifier arms FAILS on a substitution assembling a… | 1 |
| w2-asrelation-widen | widen | 37 | raw SQL: W1 whole-row projections FAILS on a * on a token table; raw SQL: W1 whole-row projections FAILS on a qualified .* on a token alias | 1 |
| w2-aliasdecl-widen | widen | 11 | raw SQL: W1 whole-row projections FAILS on a qualified .* on a token alias; raw SQL: W2 a token table's name or alias outside relation position passes on an alias qu… | 1 |
| w2-table-weaken | weaken | 8 | raw SQL: W2 a token table's name or alias outside relation position FAILS on a token tabl…; raw SQL: W2 a token table's name or alias outside relation position FAILS on TABLE <token… | 1 |
| w2-star-weaken | weaken | 1 | raw SQL: W1 whole-row projections FAILS on a qualified .* on a token alias | 1 |
| w2-columns-weaken | weaken | 4 | raw SQL: W2 a token table's name or alias outside relation position FAILS on an alias qua…; raw SQL: W2 a token table's name or alias outside relation position FAILS on an alias of … | 1 |
| w2-columns-widen | widen | 6 | raw SQL: W2 a token table's name or alias outside relation position passes on an alias qu…; raw SQL: W2 a token table's name or alias outside relation position passes on the table's… | 1 |
| w2-alias-weaken | weaken | 10 | raw SQL: W2 a token table's name or alias outside relation position FAILS on to_jsonb(ali…; raw SQL: W2 a token table's name or alias outside relation position FAILS on alias::text | 1 |
| w2-alias-dot-widen | widen | 1 | raw SQL: relation position, alias and qualifier arms passes on a member named like the al… | 1 |
| w2-alias-columns-widen | widen | 1 | raw SQL: relation position, alias and qualifier arms FAILS on an alias qualifying a colum… | 1 |
| w2-alias-sub-widen | widen | 1 | raw SQL: W2 a token table's name or alias outside relation position passes on a substitut… | 1 |
| w2-table-columns-widen | widen | 1 | raw SQL: relation position, alias and qualifier arms FAILS on a qualifier naming a column… | 1 |
| w5-weaken | weaken | 4 | raw SQL: W5 a token table's name inside a string FAILS on a token table named in a string; raw SQL: W5 a token table's name inside a string FAILS on a name in another case | 1 |
| w5-case-weaken | weaken | 1 | raw SQL: W5 a token table's name inside a string FAILS on a name in another case | 1 |
| w5-boundary-widen | widen | 1 | raw SQL: W5 a token table's name inside a string passes on a name that is only the end of… | 1 |
| w5-boundary-after-widen | widen | 1 | raw SQL: W5 a token table's name inside a string passes on a longer word containing the n… | 1 |
| w6-trusted-widen | widen | 1 | raw SQL: W6 the syntax around a substituted table passes on a bound parameter after DISTI… | 1 |
| w6-loose-weaken | weaken | 3 | raw SQL: W6 the syntax around a substituted table FAILS on IS DISTINCT FROM <substitution>; raw SQL: W6 the syntax around a substituted table FAILS on trim(x FROM <substitution>) | 1 |
| w6-value-weaken | weaken | 3 | raw SQL: W6 the syntax around a substituted table FAILS on <substitution>::text in relati…; raw SQL: W6 the syntax around a substituted table FAILS on <substitution>(args) in relati… | 1 |
| w6-qualifier-weaken | weaken | 3 | raw SQL: W6 the syntax around a substituted table FAILS on a substituted qualifier naming…; raw SQL: W6 the syntax around a substituted table FAILS on a quoted substituted qualifier… | 1 |
| w6-qualifier-columns-weaken | weaken | 2 | raw SQL: W6 the syntax around a substituted table FAILS on a substituted qualifier naming…; raw SQL: W6 the syntax around a substituted table FAILS on a quoted substituted qualifier… | 1 |
| w6-qualifier-columns-widen | widen | 2 | raw SQL: W2 a token table's name or alias outside relation position passes on a substitut…; raw SQL: W6 the syntax around a substituted table passes on a substituted qualifier namin… | 1 |
| w6-qualifier-star-weaken | weaken | 1 | raw SQL: relation position, alias and qualifier arms FAILS on a * qualified by a substitu… | 1 |
| w6-adjacent-weaken | weaken | 5 | raw SQL: W6 the syntax around a substituted table FAILS on a substitution assembling a na…; raw SQL: W6 the syntax around a substituted table FAILS on a substitution directly follow… | 1 |
| w6-adjacent-before-weaken | weaken | 3 | raw SQL: W6 the syntax around a substituted table FAILS on a substitution assembling a na…; raw SQL: relation position, alias and qualifier arms FAILS on a substitution directly aft… | 1 |
| w6-adjacent-after-weaken | weaken | 2 | raw SQL: W6 the syntax around a substituted table FAILS on a substitution directly follow…; raw SQL: relation position, alias and qualifier arms FAILS on a substitution directly fol… | 1 |
| w6-adjacent-widen | widen | 21 | raw SQL: W2 a token table's name or alias outside relation position FAILS on an alias of …; raw SQL: W2 a token table's name or alias outside relation position FAILS on an alias of … | 1 |
| w6-adjacent-digit-weaken | weaken | 1 | raw SQL: relation position, alias and qualifier arms FAILS on a substitution directly fol… | 1 |
| w6-adjacent-dollar-weaken | weaken | 1 | raw SQL: relation position, alias and qualifier arms FAILS on a substitution directly aft… | 1 |
| w6-adjacent-line-weaken | weaken | 1 | raw SQL: relation position, alias and qualifier arms FAILS on a substitution assembling a… | 1 |
| ttn-missing-weaken | weaken | 2 | TOKEN_TABLE_NAMES must equal the schema's token tables FAILS on a token table missing fro…; TOKEN_TABLE_NAMES must equal the schema's token tables FAILS on a name swapped for anothe… | 1 |
| ttn-extra-weaken | weaken | 2 | TOKEN_TABLE_NAMES must equal the schema's token tables FAILS on a name that is not a toke…; TOKEN_TABLE_NAMES must equal the schema's token tables FAILS on a name swapped for anothe… | 1 |
| ttn-element-weaken | weaken | 1 | TOKEN_TABLE_NAMES must equal the schema's token tables FAILS on an element that is not a … | 1 |
| ttn-freeze-weaken | weaken | 272 | raw SQL passes on literal raw SQL that does not name a digest column; raw SQL FAILS on raw SQL naming TOKEN_HASH in upper case (the column rule is case-insensi… | 1 |
| ttn-freeze-alias-weaken | weaken | 1 | TOKEN_TABLE_NAMES must equal the schema's token tables passes on the module's own freeze … | 1 |
| ttn-export-weaken | weaken | 1 | TOKEN_TABLE_NAMES must equal the schema's token tables is fatal when the list is declared… | 1 |
| ttn-array-weaken | weaken | 1 | TOKEN_TABLE_NAMES must equal the schema's token tables is fatal when the list is not an a… | 1 |
| schema-column-weaken | weaken | 1 | schema checks (A-10) is fatal when a digest-key field maps to another column | 1 |
| schema-mapped-weaken | weaken | 1 | schema checks (A-10) is fatal when another field is mapped to a digest column | 1 |
| schema-coverage-weaken | weaken | 1 | schema checks (A-10) is fatal when no field maps to a digest column | 1 |
| schema-view-weaken | weaken | 1 | schema checks (A-10) is fatal on a view block | 1 |
| schema-unique-field-weaken | weaken | 2 | schema checks (A-10) is fatal on a unique String field ending in hash; schema checks (A-10) is fatal on a unique String field whose column ends in hash | 1 |
| schema-unique-composite-weaken | weaken | 1 | schema checks (A-10) is fatal on a @@unique member ending in digest | 1 |
| schema-unique-type-widen | widen | 1 | schema checks (A-10) passes on a unique field that is not a String | 1 |
| schema-unique-digestkey-widen | widen | 280 | raw SQL passes on literal raw SQL that does not name a digest column; raw SQL FAILS on raw SQL naming TOKEN_HASH in upper case (the column rule is case-insensi… | 1 |
| schema-unique-name-weaken | weaken | 1 | schema checks (A-10) is fatal on a unique String field whose name ends in hash but whose … | 1 |
| schema-unique-column-weaken | weaken | 1 | schema checks (A-10) is fatal on a unique String field whose column ends in hash | 1 |
| schema-unique-listed-weaken | widen | 3 | schema checks (A-10) is fatal on a unique String field ending in hash; schema checks (A-10) is fatal on a unique String field whose column ends in hash | 1 |
| schema-unique-unlisted-weaken | weaken | 3 | schema checks (A-10) is fatal on a unique String field ending in hash; schema checks (A-10) is fatal on a unique String field whose column ends in hash | 1 |
| schema-references-weaken | weaken | 1 | schema checks (A-10) is fatal on a relation that references a digest key | 1 |
| nonbearer-stale-weaken | weaken | 1 | schema checks (A-10) FAILS on a listed field that no longer exists (stale) | 1 |
| nonbearer-reason-weaken | weaken | 1 | schema checks (A-10) FAILS on a listed field with a short reason | 1 |
| sqlfile-dollar-weaken | weaken | 2 | database objects defined in SQL files (A-10) FAILS on an unterminated dollar quote with n…; database objects defined in SQL files (A-10) passes on an unterminated dollar quote once … | 1 |
| sqlfile-initdb-weaken | weaken | 2 | database objects defined in SQL files (A-10) FAILS on a qualifying statement in infra/pos…; database objects defined in SQL files (A-10) passes on infra/postgres/initdb/01-extra.sql… | 1 |
| sqlfile-scripts-weaken | weaken | 2 | database objects defined in SQL files (A-10) FAILS on a qualifying statement in scripts/e…; database objects defined in SQL files (A-10) passes on scripts/extra.sql once listed | 1 |
| sqlfile-nomigration-weaken | weaken | 1 | database objects defined in SQL files (A-10) is fatal when there is no migration to read | 1 |
| sqlfile-unlisted-weaken | weaken | 28 | database objects defined in SQL files (A-10) FAILS on a function naming a token table wit…; database objects defined in SQL files (A-10) FAILS on a function with a single-quoted bod… | 1 |
| sqlfile-reason-weaken | weaken | 1 | database objects defined in SQL files (A-10) FAILS on an entry with a short reason | 1 |
| sqlfile-stale-weaken | weaken | 1 | database objects defined in SQL files (A-10) FAILS on a stale entry (a listed file that n… | 1 |
| sqlobj-depth-weaken | weaken | 1 | database objects defined in SQL files (more shapes) FAILS on strings nested one level pas… | 1 |
| sqlobj-depth-widen | widen | 5 | database objects defined in SQL files (A-10) FAILS on a routine body holding EXECUTE with…; database objects defined in SQL files (A-10) FAILS on a DO block creating a view that nam… | 1 |
| sqlobj-dollar-body-weaken | weaken | 0 |  | 0 |
| sqlobj-kind-modifiers-weaken | weaken | 3 | database objects defined in SQL files (A-10) FAILS on a materialized view naming a token …; database objects defined in SQL files (A-10) passes on a materialized view naming a token… | 1 |
| sqlobj-kind-weaken | weaken | 24 | database objects defined in SQL files (A-10) FAILS on a function naming a token table wit…; database objects defined in SQL files (A-10) FAILS on a function with a single-quoted bod… | 1 |
| sqlobj-kind-table-weaken | weaken | 23 | database objects defined in SQL files (A-10) FAILS on a function naming a token table wit…; database objects defined in SQL files (A-10) FAILS on a function with a single-quoted bod… | 1 |
| sqlobj-kind-digest-weaken | weaken | 1 | database objects defined in SQL files (more shapes) FAILS on a function naming only a dig… | 1 |
| sqlobj-execute-weaken | weaken | 2 | database objects defined in SQL files (A-10) FAILS on a routine body holding EXECUTE with…; database objects defined in SQL files (A-10) passes on a routine body holding EXECUTE onc… | 1 |
| sqlobj-execute-widen | widen | 2 | database objects defined in SQL files (A-10) FAILS on a trigger on a token table with no …; database objects defined in SQL files (A-10) passes on a trigger with EXECUTE FUNCTION on… | 1 |
| sqlobj-do-weaken | weaken | 2 | database objects defined in SQL files (A-10) FAILS on a DO block creating a view that nam…; database objects defined in SQL files (A-10) passes on a DO block creating a view that na… | 1 |
| sqlobj-do-names-widen | widen | 1 | database objects defined in SQL files (A-10) passes on a DO block that creates nothing th… | 1 |
| sqlobj-do-creates-widen | widen | 1 | database objects defined in SQL files (more shapes) passes on a DO block naming a token t… | 1 |
| sqlobj-plain-weaken | weaken | 19 | database objects defined in SQL files (A-10) FAILS on a copy (CREATE TABLE AS) with no en…; database objects defined in SQL files (A-10) FAILS on a copy (INSERT ... SELECT) with no … | 1 |
| sqlobj-plain-widen | widen | 13 | database objects defined in SQL files (A-10) passes on CREATE TABLE naming a digest colum…; database objects defined in SQL files (A-10) passes on ADD COLUMN without GENERATED, with… | 1 |
| sqlobj-refs-weaken | weaken | 2 | database objects defined in SQL files (A-10) FAILS on a foreign key to a digest column wi…; database objects defined in SQL files (A-10) passes on a foreign key to a digest column o… | 1 |
| sqlobj-generated-weaken | weaken | 2 | database objects defined in SQL files (A-10) FAILS on a generated column with no entry; database objects defined in SQL files (A-10) passes on a generated column once listed | 1 |
| sqlobj-refs-widen | widen | 1 | database objects defined in SQL files (A-10) passes on a REFERENCES clause that names no … | 1 |
| sqlobj-generated-widen | widen | 2 | database objects defined in SQL files (more shapes) passes on a generated column that rea…; database objects defined in SQL files (more shapes) passes on a generated column that rea… | 1 |
| plain-drop-weaken | weaken | 1 | database objects defined in SQL files (A-10) passes on DROP INDEX, with no entry | 1 |
| plain-insert-select-weaken | weaken | 1 | database objects defined in SQL files (more shapes) FAILS on an INSERT ... VALUES whose v… | 1 |
| plain-insert-upsert-weaken | weaken | 2 | database objects defined in SQL files (A-10) FAILS on a seed that upserts over a digest c…; database objects defined in SQL files (A-10) passes on a seed that upserts over a digest … | 1 |
| plain-insert-values-weaken | weaken | 1 | database objects defined in SQL files (more shapes) FAILS on an INSERT with no VALUES and… | 1 |
| plain-index-weaken | weaken | 1 | database objects defined in SQL files (A-10) passes on CREATE INDEX, with no entry | 1 |
| plain-unique-weaken | weaken | 1 | database objects defined in SQL files (A-10) passes on CREATE INDEX, with no entry | 1 |
| plain-ctas-weaken | weaken | 2 | database objects defined in SQL files (A-10) FAILS on a copy (CREATE TABLE AS) with no en…; database objects defined in SQL files (A-10) passes on a copy (CREATE TABLE AS) once list… | 1 |
| plain-ctas-widen | widen | 2 | database objects defined in SQL files (A-10) passes on CREATE TABLE naming a digest colum…; database objects defined in SQL files (more shapes) passes on a generated column that rea… | 1 |
| plain-ctas-depth-widen | widen | 1 | database objects defined in SQL files (more shapes) passes on a generated column that rea… | 1 |
| plain-alter-add-weaken | weaken | 7 | database objects defined in SQL files (A-10) passes on ADD COLUMN without GENERATED, with…; database objects defined in SQL files (A-10) passes on ADD CONSTRAINT and DROP CONSTRAINT… | 1 |
| plain-alter-dropcol-weaken | weaken | 1 | database objects defined in SQL files (A-10) passes on DROP COLUMN, with no entry | 1 |
| plain-alter-dropcons-weaken | weaken | 1 | database objects defined in SQL files (A-10) passes on ADD CONSTRAINT and DROP CONSTRAINT… | 1 |
| plain-alter-only-widen | widen | 1 | database objects defined in SQL files (more shapes) passes on ALTER TABLE ONLY, with no e… | 1 |
| plain-alter-ifexists-widen | widen | 1 | database objects defined in SQL files (more shapes) passes on ALTER TABLE IF EXISTS, with… | 1 |
| plain-alter-schema-widen | widen | 1 | database objects defined in SQL files (more shapes) passes on a schema-qualified ALTER TA… | 1 |
| plain-alter-comma-weaken | weaken | 1 | database objects defined in SQL files (more shapes) FAILS on an ALTER TABLE whose second … | 1 |
| pool-unlisted-weaken | weaken | 3 | manifest sections FAILS when a section is absent but the code needs an entry; the pg driver's query and pool factory (A-11) FAILS on an importer with no pgPools entry | 1 |
| pool-stale-weaken | weaken | 2 | the pg driver's query and pool factory (A-11) FAILS on a stale entry (a listed file that …; the pg driver's query and pool factory (A-11) FAILS on an entry in a fixture with no pool… | 1 |
| pool-reason-weaken | weaken | 1 | the pg driver's query and pool factory (A-11) FAILS on an entry with a short reason | 1 |
| pool-importer-fns-widen | widen | 4 | the pg driver's query and pool factory (A-11) FAILS on a namespace import; the pg driver's query and pool factory (A-11) FAILS on a default import | 1 |
| pool-importer-type-widen | widen | 1 | the pg driver's query and pool factory (A-11) is not an importer by a type-only import | 1 |
| pool-ns-weaken | weaken | 2 | the pg driver's query and pool factory (A-11) FAILS on a namespace import; the pg driver's query and pool factory (A-11) FAILS on a relative specifier | 1 |
| pool-default-weaken | weaken | 1 | the pg driver's query and pool factory (A-11) FAILS on a default import | 1 |
| pool-reexport-weaken | weaken | 2 | the pg driver's query and pool factory (A-11) FAILS on a named re-export; the pg driver's query and pool factory (A-11) FAILS on an export * | 1 |
| pool-importeq-weaken | weaken | 1 | the pg driver's query and pool factory (A-11) FAILS on an import-equals | 1 |
| pool-dynamic-weaken | weaken | 2 | the pg driver's query and pool factory (A-11) FAILS on a dynamic import; the pg driver's query and pool factory (A-11) FAILS on a require | 1 |
| pool-ref-prop-weaken | weaken | 5 | the pg driver's query and pool factory (A-11) FAILS on a value of query in an importer; the pg driver's query and pool factory (A-11) FAILS on a .call of query in an importer | 1 |
| pool-ref-elem-weaken | weaken | 1 | the pg driver's query and pool factory (A-11) FAILS on an element access value of query i… | 1 |
| pool-ref-destructure-weaken | weaken | 1 | the pg driver's query and pool factory (A-11) FAILS on a destructuring of query in an imp… | 1 |
| pool-direct-weaken | weaken | 6 | the pg driver's query and pool factory (A-11) FAILS on a value of query in an importer; the pg driver's query and pool factory (A-11) FAILS on a .call of query in an importer | 1 |
| pool-direct-widen | widen | 2 | the pg driver's query and pool factory (A-11) passes on a direct call with a literal in a…; the pg driver's query and pool factory (A-11) passes on a direct literal call inside pool… | 1 |
| pool-scope-importer-weaken | weaken | 6 | the pg driver's query and pool factory (A-11) FAILS on a value of query in an importer; the pg driver's query and pool factory (A-11) FAILS on a .call of query in an importer | 1 |
| pool-scope-factory-weaken | weaken | 1 | the pg driver's query and pool factory (A-11) FAILS on a value reference to query inside … | 1 |
| count-naming-weaken | weaken | 1 | database objects defined in SQL files (A-10) counts the SQL files and the qualifying ones… | 1 |
| count-literals-weaken | weaken | 1 | database objects defined in SQL files (A-10) counts the SQL files and the qualifying ones… | 1 |

## Decisions and deviations (B2)

- Manifest entries of the new sections are objects with a `reason` (as `models`), including `pgPools`, where the plan says "file path to reason". A missing section is an empty one (as `models`); a present non-object section is fatal.
- A missing `pool-factory` is not fatal: the importer set is derived from import specifiers, so such a fixture passes with an empty `pgPools` and a listed file is stale.
- `TOKEN_TABLE_NAMES`: a missing, unexported or non-array declaration is fatal; a non-literal element and each set difference are violation lines (a swapped name is a declared pair).
- The gate imports `normalizeDollarTags` from `check-migration-rls-dml.mjs` (exported, import-safe) instead of copying it; an unrecognised or unterminated dollar quote becomes a finding. Strings nested more than 8 deep qualify the file (fail closed).
- The names `renderSql` and `trustedSql` are each named once in the gate as constants, so check-raw-sql-usage's measured literal exemption (one each) still holds; no new raw-sql name appears as a literal.
- W6 adjacency and W1 apply to every `trustedSql` template, so a multiplication or a `*` there fails (as the plan states).
- `UPDATE` after `FOR`, `ON`, `DO`, `KEY`, `OF`, `OR`, `AFTER` or `BEFORE` is not a relation keyword; the only cell that separates this arm is the contrived `FOR UPDATE <token table>` lock clause.

# Self-check fixes

Self-test cells: 755 before, 962 after (gate self-test); the real-repo summary line is unchanged
(`digest-keys=60 placed=51 floating=9 sql-literals=136 token-table-literals=7 sql-files=228 sql-qualifying=5`).
Exit codes: gate 0; vitest on the gate, check-raw-sql-usage and sql-scan self-tests 0 (1279 passed); check-raw-sql-usage 0;
check-gate-selftest-coverage 0; check-mjs-imports 0; eslint on the gate 0; check-doc-paths 0.

## Security

- R55, in-band sentinel: a SQL-bearing literal whose own text holds U+E000 now fails as `SQL_SENTINEL` before any rule runs
  (the real character hid a quoted alias from W2). The SQL-file path fails closed the same way (a finding for a file holding U+E000).
  Cells: deny in an Unsafe literal, a `$queryRaw` template, a trustedSql template and a SQL file (the character is written as ``
  in the test source); allow twins without it; a cell showing the ordinary alias is refused by W2. Red proofs `sentinel-weaken`, `sentinel-file-weaken`.
- R47, quoted function names: W4's call rules and `count(*)` read a function name through `functionName`: an unquoted word folds to lower
  case, a quoted name is taken as written (`"ts_stat"(`, `"query_to_xml"(`, `pg_catalog."query_to_xml"(`, `"count"(*)`), and the XML pattern no longer
  carries the `i` flag (a quoted upper-case name is another, absent function). Cells and red proofs `fn-qident-weaken/widen`, `fn-word-weaken`,
  `xml-regex-flag-widen`, `w4-called-ts-weaken`, `count-qident-weaken`.
- Sweep of every other decision on `TOKEN.WORD` in the SQL code, and the decision:
  - relation / alias / chain names, token-table names, digest-column names, substituted qualifiers: already read WORD and QIDENT (`isNameToken`, `isNamedToken`); no change.
  - W4 `EXECUTE`, `PREPARE`, statement-initial `DO`, `CREATE` / `ALTER` and the object kinds and modifiers: SQL keywords; a quoted keyword is an identifier; WORD only.
  - W4 call names (`query_to_xml*` ..., `dblink*`, `ts_stat`) and `count`: function names; QIDENT too (fixed).
  - the `trim` / `extract` / `substring` / `overlay` FROM exclusion: special syntax; `"trim"(x FROM y)` is no such form; WORD only.
  - `DISTINCT` before FROM, `AS`, the relation keywords, the follow-set, the UPDATE-after-X words: keywords; WORD only.
  - C4 `CREATE` / `ALTER TABLE` / `DROP` / `INSERT` / `VALUES` / `SELECT` / `REFERENCES` / `GENERATED` / `EXECUTE` / `DO` / `UPDATE`: keywords; WORD only.
  - W1 `*`, W6 DOT / OP tokens: not names.

## Testing

- `sqlobj-dollar-body-weaken` was not equivalent: without the dollar-tag branch of `stringBody`, a tight-glued body (`$$SELECT ... FROM api_keys$$`,
  `$q$...$q$`) loses its first and last word. Deny cells for both forms with an allow twin; red proof `stringbody-tag-weaken`. The earlier log claim is withdrawn.
- One cell per member of every keyword set, written first, then proved by removing each member (`member-*` rows below: 135 removals — the members of the keyword sets, the plain-`CREATE` modifier list and the 6 alternatives of W4's call pattern). Removing a member from the OLD cells survived (zero red) for 105 members; those are the members cells were added for:
  - `DECLARED_NAME_PARENTS` (8): ClassDeclaration, ClassExpression, EnumDeclaration, FunctionExpression, ImportClause, ImportEqualsDeclaration, ModuleDeclaration, NamespaceImport.
  - `TYPE_DECLARATIONS` (2): TypeAliasDeclaration, TypeParameter.
  - `VALUE_PARENTS` (36): ArrayLiteral, As, Await, Binary, CaseClause, ComputedPropertyName, Conditional, Decorator, Delete, Do, ElementAccess, ExportAssignment, ExpressionStatement, ForIn, ForOf, For, If, JsxExpression, JsxSpreadAttribute, New, NonNull, Parenthesized, PostfixUnary, PrefixUnary, Satisfies, SpreadAssignment, SpreadElement, Switch, TaggedTemplate, TemplateSpan, Throw, TypeAssertion, TypeOf, Void, While, Yield.
  - `ARGUMENT_WRAPPERS` (4): As, NonNull, Parenthesized, Satisfies.
  - `NON_RELATION_UPDATE_PREV` (7): AFTER, BEFORE, DO, KEY, OF, ON, OR.
  - `RELATION_FOLLOW` (30): CROSS, DEFAULT, EXCEPT, FETCH, FOR, FULL, GROUP, HAVING, INNER, INTERSECT, JOIN, LATERAL, LEFT, LIMIT, NATURAL, OFFSET, ON, ORDER, OUTER, OVERRIDING, RETURNING, RIGHT, SELECT, SET, TABLESAMPLE, UNION, USING, VALUES, WINDOW, WITH. (A follow word differs from an alias only when it recurs, so the cell repeats the word: `FROM api_keys W x W y`.)
  - `NON_RELATION_FROM_FUNCTIONS` (2): overlay, substring.
  - `OBJECT_MODIFIERS` (8): CONSTRAINT, EVENT, GLOBAL, LOCAL, RECURSIVE, TEMP, TEMPORARY, UNLOGGED (cells for W4 and for C4).
  - plain `CREATE` modifiers (5): GLOBAL, LOCAL, TEMP, TEMPORARY, UNLOGGED.
  - W4's XML pattern (3): cursor_to_xml, database_to_xml, schema_to_xml; the `*_and_xmlschema` / `*xmlschema` / `dblink_*` variants each have a cell.
  No member was unreachable or redundant, so none was removed from the code.
- The two B1/B2 cells that asserted a fatal with a substring (no migration to read; a section that is not an object) now use `expectFatal` with the whole line;
  `run()` returns the fixture root and `expectFatal` accepts a function of it for a line that names the root. No other new cell uses `expectFail`.
- check-raw-sql-usage `sqlTable` twins, reproduced on a scratch copy (`scratchpad/batchB3/rsu`): base 246 passed. Weaken (remove `sqlTable` from RAW_SQL_NAMES):
  4 red (`sqlTable(a)` without an import; `globalThis["sqlTable"] = fn`; function declaration named `sqlTable`; parameter named `sqlTable`). Widen (treat `sqlTable` as tag-only like `trustedSql`):
  1 red (`allow: sqlTable ordinary call`).
- Stale temp roots: the self-test now sweeps `bearer-passkey-gate-*` roots older than an hour in a top-level `beforeAll` (a killed run leaves them); a cell covers it
  (removes a two-hour-old root, keeps a fresh one and an unrelated old directory). No global setup was touched.

## Documentation

- `scripts/checks/raw-sql-usage.txt` now lists `sqlTable` among the sensitive names; the gate header names `sqlTable` among the spliced items and documents SQL_SENTINEL and quoted function names.
- Manifest `sqlObjects` reasons re-read against all five migrations: phase 9 (and phase 8) resolve a row's tenant from the user, owner, team, entry, share or grant id inside the row; the uuid migration
  re-creates three functions (resolve, enforce, owner-membership), not one; the two share migrations are as described. All five reasons rewritten.

## Red-proof table (144 one-step mutations; scratch copy `scratchpad/batchB3/slot0..3`, cells selected by `-t`; exit status 1 for every row)

Base green (181 census cells, 444 SQL cells) and a deliberate syntax error (0 passed, 539 failed) were run first; the scratch gate was `cmp`-identical to the real one.

| Mutation | Direction | Red cells | Examples (cell names) | Exit |
|----------|-----------|-----------|-----------------------|------|
| member-TYPE_DECLARATIONS-SyntaxKindInterfaceDeclaration | member | 2 | digest-key spelling census — roles (A-1) passes on an interface member and a parameter an…; digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-TYPE_DECLARATIONS-SyntaxKindTypeAliasDeclaration | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-TYPE_DECLARATIONS-SyntaxKindTypeParameter | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-DECLARED_NAME_PARENTS-SyntaxKindVariableDeclaration | member | 45 | digest-key spelling census — roles (A-1) FAILS on a shorthand property over a local bindi…; digest-key spelling census — roles (A-1) passes on a const and its reference (a binding, … | 1 |
| member-DECLARED_NAME_PARENTS-SyntaxKindParameter | member | 4 | digest-key spelling census — roles (A-1) passes on a parameter of a nested function (a bi…; digest-key spelling census — roles (A-1) passes on a parameter named as a digest key (a b… | 1 |
| member-DECLARED_NAME_PARENTS-SyntaxKindFunctionDeclaration | member | 1 | digest-key spelling census — roles (A-1) passes on a function declaration and its call (a… | 1 |
| member-DECLARED_NAME_PARENTS-SyntaxKindFunctionExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-DECLARED_NAME_PARENTS-SyntaxKindClassDeclaration | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-DECLARED_NAME_PARENTS-SyntaxKindClassExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-DECLARED_NAME_PARENTS-SyntaxKindEnumDeclaration | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-DECLARED_NAME_PARENTS-SyntaxKindModuleDeclaration | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-DECLARED_NAME_PARENTS-SyntaxKindImportClause | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-DECLARED_NAME_PARENTS-SyntaxKindNamespaceImport | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-DECLARED_NAME_PARENTS-SyntaxKindImportEqualsDeclaration | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindCallExpression | member | 2 | digest-key spelling census — roles (A-1) passes on a function declaration and its call (a…; digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindNewExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindBinaryExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindPrefixUnaryExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindPostfixUnaryExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindConditionalExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindParenthesizedExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindAsExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindSatisfiesExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindNonNullExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindTypeAssertionExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindAwaitExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindYieldExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindTypeOfExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindVoidExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindDeleteExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindSpreadElement | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindSpreadAssignment | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindArrayLiteralExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindElementAccessExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindTaggedTemplateExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindTemplateSpan | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindArrowFunction | member | 2 | digest-key spelling census — roles (A-1) passes on a parameter of a nested function (a bi…; digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindComputedPropertyName | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindReturnStatement | member | 7 | digest-key spelling census — roles (A-1) FAILS on a destructured property; digest-key spelling census — roles (A-1) FAILS on a reference with no visible binding | 1 |
| member-VALUE_PARENTS-SyntaxKindThrowStatement | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindExpressionStatement | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindIfStatement | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindWhileStatement | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindDoStatement | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindForStatement | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindForInStatement | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindForOfStatement | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindSwitchStatement | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindCaseClause | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindExportAssignment | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindJsxExpression | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindJsxSpreadAttribute | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindDecorator | member | 1 | digest-key spelling census — every member of the binding, value and type sets passes on a… | 1 |
| member-VALUE_PARENTS-SyntaxKindExpressionWithTypeArguments | member | 2 | digest-key spelling census — roles (A-1) FAILS on a class's extends expression with no vi…; digest-key spelling census — roles (A-1) passes on a const extended by a class (a binding… | 1 |
| member-ARGUMENT_WRAPPERS-SyntaxKindArrayLiteralExpression | member | 3 | digest-key spelling census — builders and their callers (A-4b) FAILS on a helper building…; digest-key spelling census — builders and their callers (A-4b) passes when both are liste… | 1 |
| member-ARGUMENT_WRAPPERS-SyntaxKindParenthesizedExpression | member | 1 | digest-key spelling census — every argument wrapper of a builder string treats a string i… | 1 |
| member-ARGUMENT_WRAPPERS-SyntaxKindAsExpression | member | 1 | digest-key spelling census — every argument wrapper of a builder string treats a string i… | 1 |
| member-ARGUMENT_WRAPPERS-SyntaxKindSatisfiesExpression | member | 1 | digest-key spelling census — every argument wrapper of a builder string treats a string i… | 1 |
| member-ARGUMENT_WRAPPERS-SyntaxKindNonNullExpression | member | 1 | digest-key spelling census — every argument wrapper of a builder string treats a string i… | 1 |
| member-RELATION_KEYWORDS-FROM | member | 90 | raw SQL: W1 whole-row projections FAILS on a * on a token table; raw SQL: W1 whole-row projections FAILS on a qualified .* on a token alias | 1 |
| member-RELATION_KEYWORDS-JOIN | member | 3 | raw SQL: W2 a token table's name or alias outside relation position passes on a join; raw SQL: relation position, alias and qualifier arms passes on the alias of a table that … | 1 |
| member-RELATION_KEYWORDS-UPDATE | member | 3 | raw SQL: W2 a token table's name or alias outside relation position passes on UPDATE ... …; raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2) treats UPDATE aft… | 1 |
| member-RELATION_KEYWORDS-INTO | member | 4 | raw SQL: W2 a token table's name or alias outside relation position passes on INSERT INTO…; raw SQL: W2 a token table's name or alias outside relation position passes on ON CONFLICT… | 1 |
| member-RELATION_KEYWORDS-ONLY | member | 2 | raw SQL: relation position, alias and qualifier arms passes on FROM ONLY <token table>; raw SQL: every relation keyword a token table after ONLY is in relation position | 1 |
| member-NON_RELATION_FROM_FUNCTIONS-trim | member | 2 | raw SQL: W6 the syntax around a substituted table FAILS on trim(x FROM <substitution>); raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2) FAILS on trim(x F… | 1 |
| member-NON_RELATION_FROM_FUNCTIONS-extract | member | 2 | raw SQL: W6 the syntax around a substituted table FAILS on extract(f FROM <substitution>); raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2) FAILS on extract(… | 1 |
| member-NON_RELATION_FROM_FUNCTIONS-substring | member | 1 | raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2) FAILS on substrin… | 1 |
| member-NON_RELATION_FROM_FUNCTIONS-overlay | member | 1 | raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2) FAILS on overlay(… | 1 |
| member-NON_RELATION_UPDATE_PREV-FOR | member | 2 | raw SQL: relation position, alias and qualifier arms FAILS on FOR UPDATE <token table> (a…; raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2) treats UPDATE aft… | 1 |
| member-NON_RELATION_UPDATE_PREV-ON | member | 1 | raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2) treats UPDATE aft… | 1 |
| member-NON_RELATION_UPDATE_PREV-DO | member | 1 | raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2) treats UPDATE aft… | 1 |
| member-NON_RELATION_UPDATE_PREV-KEY | member | 1 | raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2) treats UPDATE aft… | 1 |
| member-NON_RELATION_UPDATE_PREV-OF | member | 1 | raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2) treats UPDATE aft… | 1 |
| member-NON_RELATION_UPDATE_PREV-OR | member | 1 | raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2) treats UPDATE aft… | 1 |
| member-NON_RELATION_UPDATE_PREV-AFTER | member | 1 | raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2) treats UPDATE aft… | 1 |
| member-NON_RELATION_UPDATE_PREV-BEFORE | member | 1 | raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2) treats UPDATE aft… | 1 |
| member-RELATION_FOLLOW-WHERE | member | 2 | raw SQL: W2 a token table's name or alias outside relation position passes on FROM <subst…; raw SQL: every word of the relation follow-set WHERE after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-SET | member | 1 | raw SQL: every word of the relation follow-set SET after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-ON | member | 1 | raw SQL: every word of the relation follow-set ON after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-USING | member | 1 | raw SQL: every word of the relation follow-set USING after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-VALUES | member | 1 | raw SQL: every word of the relation follow-set VALUES after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-RETURNING | member | 1 | raw SQL: every word of the relation follow-set RETURNING after a token relation is no ali… | 1 |
| member-RELATION_FOLLOW-SELECT | member | 1 | raw SQL: every word of the relation follow-set SELECT after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-DEFAULT | member | 1 | raw SQL: every word of the relation follow-set DEFAULT after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-OVERRIDING | member | 1 | raw SQL: every word of the relation follow-set OVERRIDING after a token relation is no al… | 1 |
| member-RELATION_FOLLOW-JOIN | member | 1 | raw SQL: every word of the relation follow-set JOIN after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-INNER | member | 1 | raw SQL: every word of the relation follow-set INNER after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-LEFT | member | 1 | raw SQL: every word of the relation follow-set LEFT after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-RIGHT | member | 1 | raw SQL: every word of the relation follow-set RIGHT after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-FULL | member | 1 | raw SQL: every word of the relation follow-set FULL after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-CROSS | member | 1 | raw SQL: every word of the relation follow-set CROSS after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-NATURAL | member | 1 | raw SQL: every word of the relation follow-set NATURAL after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-LATERAL | member | 1 | raw SQL: every word of the relation follow-set LATERAL after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-OUTER | member | 1 | raw SQL: every word of the relation follow-set OUTER after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-UNION | member | 1 | raw SQL: every word of the relation follow-set UNION after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-INTERSECT | member | 1 | raw SQL: every word of the relation follow-set INTERSECT after a token relation is no ali… | 1 |
| member-RELATION_FOLLOW-EXCEPT | member | 1 | raw SQL: every word of the relation follow-set EXCEPT after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-GROUP | member | 1 | raw SQL: every word of the relation follow-set GROUP after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-ORDER | member | 1 | raw SQL: every word of the relation follow-set ORDER after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-HAVING | member | 1 | raw SQL: every word of the relation follow-set HAVING after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-LIMIT | member | 1 | raw SQL: every word of the relation follow-set LIMIT after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-OFFSET | member | 1 | raw SQL: every word of the relation follow-set OFFSET after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-FETCH | member | 1 | raw SQL: every word of the relation follow-set FETCH after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-FOR | member | 1 | raw SQL: every word of the relation follow-set FOR after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-WINDOW | member | 1 | raw SQL: every word of the relation follow-set WINDOW after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-WITH | member | 1 | raw SQL: every word of the relation follow-set WITH after a token relation is no alias | 1 |
| member-RELATION_FOLLOW-TABLESAMPLE | member | 1 | raw SQL: every word of the relation follow-set TABLESAMPLE after a token relation is no a… | 1 |
| member-OBJECT_KINDS-FUNCTION | member | 15 | raw SQL: W4 dynamic SQL and object definitions FAILS on CREATE FUNCTION in a literal that…; raw SQL: W4 dynamic SQL and object definitions FAILS on ALTER FUNCTION in a literal that … | 1 |
| member-OBJECT_KINDS-PROCEDURE | member | 3 | raw SQL: W4 dynamic SQL and object definitions FAILS on CREATE PROCEDURE in a literal tha…; database objects defined in SQL files (A-10) FAILS on a procedure naming a token table wi… | 1 |
| member-OBJECT_KINDS-VIEW | member | 30 | raw SQL: W4 dynamic SQL and object definitions FAILS on CREATE OR REPLACE VIEW in a liter…; raw SQL: W4 dynamic SQL and object definitions FAILS on CREATE MATERIALIZED VIEW in a lit… | 1 |
| member-OBJECT_KINDS-TRIGGER | member | 7 | database objects defined in SQL files (A-10) FAILS on a trigger on a token table with no …; database objects defined in SQL files (A-10) passes on a trigger on a token table once li… | 1 |
| member-OBJECT_KINDS-RULE | member | 3 | raw SQL: W4 dynamic SQL and object definitions FAILS on CREATE RULE in a literal that nam…; database objects defined in SQL files (A-10) FAILS on a rule on a token table with no ent… | 1 |
| member-OBJECT_MODIFIERS-OR | member | 4 | raw SQL: W4 dynamic SQL and object definitions FAILS on CREATE OR REPLACE VIEW in a liter…; database objects defined in SQL files (more shapes) FAILS on CREATE OR REPLACE FUNCTION n… | 1 |
| member-OBJECT_MODIFIERS-REPLACE | member | 4 | raw SQL: W4 dynamic SQL and object definitions FAILS on CREATE OR REPLACE VIEW in a liter…; database objects defined in SQL files (more shapes) FAILS on CREATE OR REPLACE FUNCTION n… | 1 |
| member-OBJECT_MODIFIERS-TEMP | member | 2 | raw SQL: W4 object modifiers, every word FAILS on TEMP; database objects in SQL files: every CREATE modifier FAILS on CREATE TEMP of an object na… | 1 |
| member-OBJECT_MODIFIERS-TEMPORARY | member | 2 | raw SQL: W4 object modifiers, every word FAILS on TEMPORARY; database objects in SQL files: every CREATE modifier FAILS on CREATE TEMPORARY of an obje… | 1 |
| member-OBJECT_MODIFIERS-RECURSIVE | member | 2 | raw SQL: W4 object modifiers, every word FAILS on RECURSIVE; database objects in SQL files: every CREATE modifier FAILS on CREATE RECURSIVE of an obje… | 1 |
| member-OBJECT_MODIFIERS-MATERIALIZED | member | 5 | raw SQL: W4 dynamic SQL and object definitions FAILS on CREATE MATERIALIZED VIEW in a lit…; database objects defined in SQL files (A-10) FAILS on a materialized view naming a token … | 1 |
| member-OBJECT_MODIFIERS-CONSTRAINT | member | 2 | raw SQL: W4 object modifiers, every word FAILS on CONSTRAINT; database objects in SQL files: every CREATE modifier FAILS on CREATE CONSTRAINT of an obj… | 1 |
| member-OBJECT_MODIFIERS-EVENT | member | 2 | raw SQL: W4 object modifiers, every word FAILS on EVENT; database objects in SQL files: every CREATE modifier FAILS on CREATE EVENT of an object n… | 1 |
| member-OBJECT_MODIFIERS-UNLOGGED | member | 2 | raw SQL: W4 object modifiers, every word FAILS on UNLOGGED; database objects in SQL files: every CREATE modifier FAILS on CREATE UNLOGGED of an objec… | 1 |
| member-OBJECT_MODIFIERS-GLOBAL | member | 2 | raw SQL: W4 object modifiers, every word FAILS on GLOBAL; database objects in SQL files: every CREATE modifier FAILS on CREATE GLOBAL of an object … | 1 |
| member-OBJECT_MODIFIERS-LOCAL | member | 2 | raw SQL: W4 object modifiers, every word FAILS on LOCAL; database objects in SQL files: every CREATE modifier FAILS on CREATE LOCAL of an object n… | 1 |
| member-CREATE_PLAIN_MODIFIERS-UNIQUE | member | 1 | database objects defined in SQL files (A-10) passes on CREATE INDEX, with no entry | 1 |
| member-CREATE_PLAIN_MODIFIERS-GLOBAL | member | 1 | database objects in SQL files: every CREATE modifier passes on CREATE GLOBAL TABLE naming… | 1 |
| member-CREATE_PLAIN_MODIFIERS-LOCAL | member | 1 | database objects in SQL files: every CREATE modifier passes on CREATE LOCAL TABLE naming … | 1 |
| member-CREATE_PLAIN_MODIFIERS-TEMP | member | 1 | database objects in SQL files: every CREATE modifier passes on CREATE TEMP TABLE naming a… | 1 |
| member-CREATE_PLAIN_MODIFIERS-TEMPORARY | member | 1 | database objects in SQL files: every CREATE modifier passes on CREATE TEMPORARY TABLE nam… | 1 |
| member-CREATE_PLAIN_MODIFIERS-UNLOGGED | member | 1 | database objects in SQL files: every CREATE modifier passes on CREATE UNLOGGED TABLE nami… | 1 |
| member-XML-query_to_xml | member | 8 | raw SQL: W4 dynamic SQL and object definitions FAILS on query_to_xml(...) in a literal th…; raw SQL: W4 dynamic SQL and object definitions FAILS on query_to_xml in a literal that na… | 1 |
| member-XML-table_to_xml | member | 4 | raw SQL: W4 dynamic SQL and object definitions FAILS on table_to_xml_and_xmlschema(...) i…; raw SQL: W4 function calls, every name the pattern admits FAILS on table_to_xml(...) | 1 |
| member-XML-cursor_to_xml | member | 2 | raw SQL: W4 function calls, every name the pattern admits FAILS on cursor_to_xml(...); raw SQL: W4 function calls, every name the pattern admits FAILS on cursor_to_xmlschema(..… | 1 |
| member-XML-schema_to_xml | member | 3 | raw SQL: W4 function calls, every name the pattern admits FAILS on schema_to_xml(...); raw SQL: W4 function calls, every name the pattern admits FAILS on schema_to_xml_and_xmls… | 1 |
| member-XML-database_to_xml | member | 3 | raw SQL: W4 function calls, every name the pattern admits FAILS on database_to_xml(...); raw SQL: W4 function calls, every name the pattern admits FAILS on database_to_xml_and_xm… | 1 |
| member-XML-dblink | member | 4 | raw SQL: W4 dynamic SQL and object definitions FAILS on dblink(...) in a literal that nam…; raw SQL: W4 function calls, every name the pattern admits FAILS on dblink(...) | 1 |
| sentinel-weaken | weaken | 3 | raw SQL: the substitution marker U+E000 in a literal FAILS on U+E000 inside a quoted alia…; raw SQL: the substitution marker U+E000 in a literal FAILS on U+E000 in a $queryRaw templ… | 1 |
| sentinel-file-weaken | weaken | 1 | raw SQL: the substitution marker U+E000 in a literal FAILS on U+E000 in a SQL file | 1 |
| fn-qident-weaken | weaken | 4 | raw SQL: a quoted function name is the same function (W4, W1) FAILS on a quoted "ts_stat"; raw SQL: a quoted function name is the same function (W4, W1) FAILS on a quoted "query_to… | 1 |
| fn-qident-widen | widen | 1 | raw SQL: a quoted function name is the same function (W4, W1) passes on a quoted upper-ca… | 1 |
| fn-word-weaken | weaken | 1 | raw SQL: a quoted function name is the same function (W4, W1) FAILS on an unquoted upper-… | 1 |
| xml-regex-flag-widen | widen | 1 | raw SQL: a quoted function name is the same function (W4, W1) passes on a quoted upper-ca… | 1 |
| w4-called-ts-weaken | weaken | 2 | raw SQL: W4 dynamic SQL and object definitions FAILS on ts_stat(...) in a literal that na…; raw SQL: a quoted function name is the same function (W4, W1) FAILS on a quoted "ts_stat" | 1 |
| count-qident-weaken | weaken | 1 | raw SQL: a quoted function name is the same function (W4, W1) treats a quoted "count"(*) … | 1 |
| stringbody-tag-weaken | weaken | 2 | database objects in SQL files: every CREATE modifier FAILS on a tightly glued untagged do…; database objects in SQL files: every CREATE modifier FAILS on a tightly glued tagged doll… | 1 |
