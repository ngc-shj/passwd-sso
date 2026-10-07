# Coding Deviation Log: raw-sql-ident-branded-type

## Step 0 commit

`015751acd` — characterization tests committed before any C2 change. After C2,
`git diff 015751acd -- <Step 0 test files>` may only wrap the actual value in
`renderSql(...)`; expected strings must be byte-identical.

## D-1 — Migration script SQL builders extracted in Step 0

`buildAccountsSelectSql` / `buildAccountUpdateSql` return today's strings and are
called from `main()`. Between Step 0 and C2 the old gate reports
`UNRESOLVED_SQL_ARG` for these two calls (a function-call argument); C2 replaces
them with `renderSql(trustedSql…)` and D replaces the gate. Transitional only.

## D-2 — loadEnv() stays at module scope in the migration script

Plan Step 0 asked whether `loadEnv()` is harmless on import. It only populates
`process.env` (same as `scripts/tenant-domain.ts`), so it stays outside the CLI guard.

## D-3 — Two registries instead of one (C1)

C1 says "a module-private `WeakMap<object, string>`". The implementation keeps two
(identifiers, fragments) so `renderSql` accepts only a fragment without storing a
discriminant on the value (which would break "no own property holds text").
`trustedSql` / `joinSql` accept either kind as a part.

## D-4 — Keyword list captured from the dev Postgres 16 catalog

The R/T list (101 words) was read with a read-only `pg_get_keywords()` query and
embedded; `raw-sql-reserved-keywords.integration.test.ts` proves set equality by
behaviour (every catalog R/T word rejected; every other `^[a-z_]+$` catalog word
accepted), since the list itself is not exported (C1 export surface).

## D-5 — Non-literal `import()` / `require()` moved from deny to the residual (C3)

C3 said a non-literal `import()` / `require()` argument anywhere in a scanned file
denies. Implemented literally, it reds three unrelated files that load modules by a
computed specifier on purpose: `scripts/check-env-docs.ts` (4 sites, tsx loader on an
absolute path), `src/i18n/messages.ts` (2, i18n namespace loader),
`src/lib/crypto/crypto-client.ts` (1, WASM module name). No plan round measured this
clause's reach. It is now in the declared residual with "a loader under another name
invoked with a non-literal specifier", which it is a member of: the gate cannot tell
what a computed specifier loads, and under C3's threat model loading `raw-sql.ts` that
way is deliberate obfuscation, which review owns. Literal `import()` / `require()` of
`raw-sql.ts` still denies. The two self-test rows became allow rows marked residual.

## D-6 — `.map(sqlIdentifier)` passed the function as a value

C2 wrote `entry.keyColumns.map(sqlIdentifier)` (3 sites in `sweep.ts`); `RAW_SQL_NAMES`
correctly denies passing the function as an argument. Rewritten as
`.map((c) => sqlIdentifier(c))`.

## D-7 — `src/lib/prisma/raw-sql.ts` added to the Layer 1 allowlist

Its header comment names `$queryRawUnsafe` / `$executeRawUnsafe`, which Layer 1's
textual trigger matches although the file issues no raw-SQL call.

## D-8 — `/index` specifier allow fixture dropped

`raw-sql.ts` is a file, not a directory, so no specifier for it can take the
`/index` form; the fixture would have passed for the wrong reason. Replaced by
relative-specifier variants.

## D-9 — Enum disjointness checked against a measured name set

The gate compares schema enum names with 21 non-enum export names of
`@prisma/client` and its runtime package (`raw`, `sql`, `join`, `Sql`, `empty`,
`dmmf`, `DbNull`, …), embedded in the gate; it fails closed on a collision.

## D-10 — Keyword integration test cast `catcode` to text

`pg_get_keywords().catcode` is Postgres `"char"`, which Prisma cannot deserialize;
the query casts it (`catcode::text`). Red-proven on a scratch copy: dropping `with`
from the embedded list fails "rejects every word the live catalog reports as catcode
R or T".

## D-11 — D-5 narrowed to a measured allowlist (code review round 1)

Non-literal `import()` / `require()` is no longer a blanket residual: the seven
measured sites are allowlisted by file and count (`NON_LITERAL_IMPORT_ALLOWLIST`);
any other site, or a count change in an allowlisted file, denies.

## D-12 — Specifier resolution moved onto the filesystem (code review round 4)

The plan's gate resolved specifiers by path math and treated only test-path
shapes as unscanned. Rounds 3 and 4 found five divergences from the real
loaders (directory-shaped specifiers, case-folded credit, code outside the scan
roots, percent-encoding, `..` above the root), so the resolver was replaced
rather than patched again: one `resolveOnDisk` walks Node/TS candidates in
order against exact-case directory listings. A canonical raw-sql.ts import is
credited only when it lands exactly on `src/lib/prisma/raw-sql.ts`;
UNSCANNED_IMPORT denies any target outside the scanned set except `.json` and
four measured per-literal exemptions. A `.`/`..`-only literal outside a
module-specifier position (the scripts/ repo-root idiom) is judged by what that
ancestor directory can load instead of per-file exemptions.
