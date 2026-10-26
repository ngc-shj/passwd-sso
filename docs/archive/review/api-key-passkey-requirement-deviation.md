# Coding Deviation Log: api-key-passkey-requirement

## Carried-forward plan findings

- **F46/T34** (`opaque-where`): settled by building. The gate's real-repo run classifies seven
  `opaque-where` functions, one more than the plan's seed: `vault/delegation/check#GET` spreads
  a `DelegationSession` relation filter into an `McpAccessToken` `where`. It filters by row id,
  never by digest. Removing `transition` from the manifest fails the gate as `UNLISTED`.
- **T31** (fail-closed route limiters without Redis): settled by building. The integration file
  passes all 21 cells with `REDIS_URL` empty, as well as with Redis.

## C7 — decisions taken inside the contract's latitude

The plan left fixture construction and exact spellings to Phase 2.

- **Spreads:** every spread in a `where` on a token model is opaque, including conditional
  spreads. The plan's seeded members depend on this.
- **Raw SQL:** checked more broadly than "raw SQL whose text mentions the column".
  - `token_hash`/`code_hash` is refused in any string, template or regular-expression literal
    in non-test `src`, because an interpolated fragment is invisible at the call site. So are
    `U&` / `UESCAPE` (code review round 2).
  - `$queryRawUnsafe`/`$executeRawUnsafe` must take a literal or `renderSql(trustedSql…)`.
  - `$queryRaw`/`$executeRaw` must be template tags.
- **Dynamic imports:** an `import()` with a specifier the gate cannot read fails. The two
  existing shapes are accepted: a const bound to a string literal, and a `.json` template.
- **Exemption pin:** a constant in the gate, not a manifest entry, so a fourth exempt site is a
  contract change rather than a data edit.
- **`per-use-gated` is stricter than the text:**
  - the gate `if` has no `else`, and its consequent returns an `ok: false` literal;
  - that literal has exactly one `ok` and no spread.
- **Manifest:** every entry carries `calls`, not only `opaque-where`. A function with an opaque
  site must be classed `opaque-where`, and an `opaque-where` entry with nothing opaque left
  fails as `STALE_OPAQUE`.

## Side-fixes discovered during verification

- **Limiter indices in tests:** `extension-token.ts` now imports `passkey-gate.ts`, whose
  module-level `createRateLimiter` call shifted `mock.results` indices. Four route tests now pick
  their limiter by its options rather than by position: `extension/token`, `mobile/token`,
  `extension/token/exchange`, `mobile/token/refresh`.
- **Prose that a gate counts:** a first wording of those comments spelled the
  `failClosedOnRedisError` literal that `check-fail-closed-routes-have-test.sh` counts. The
  comments were reworded, and the count is back to 72.
- **Dead code in `mobile-token.ts`:** removing `validateIosTokenDpop` left an unused
  `DPOP_VERIFY_ERROR` re-export and the DPoP imports; both are removed. A grep confirms nothing
  imported the re-export.
- **Stale comments:** the `user-session-invalidation.test.ts` comment saying operator tokens
  have no membership check is updated, as is the `validateOperatorToken` doc comment.

## CI parity

`extract-ci-checks.sh` against `scripts/pre-pr.sh` finds two gates that run only in CI:
`check-npm-audit.mjs` and `check-terraform-test-count.mjs`. This diff touches neither
dependencies nor Terraform. Anti-Deferral: they cannot be affected by this change, and they are
pre-existing CI-only gates, not gaps this PR opens.

## Step 2-4 / 2-5 fixes

- **`check-raw-sql-usage` measured exemption:** the C7 gate spells `renderSql` and `trustedSql`
  as data to recognise the accepted unsafe-raw argument shape, and `check-raw-sql-usage`'s
  RAW_SQL_NAMES literal clause refused them. That clause gains a per-(file, literal, exact
  count) exemption table, mirroring its existing `UNSCANNED_LITERAL_EXEMPTIONS`. It has one entry
  (this gate, one of each name). An unmeasured name or a count drift still denies. Self-test
  cells cover allow, unmeasured and drift, and the allow cell was red-proved by removing the entry.
- **C7 runtime:** the gate took about 36 s because ts-morph's `isExported()` consults the type
  checker, which builds a Program and resolves every module. It now uses the syntactic
  `hasExportKeyword()` and takes about 5 s, with an identical result (28/28). Measured on the
  real repo (1044 files): `isExported` at every export test 35.8 s and 36.3 s; only in the
  attribution helper 7.8 s; `hasExportKeyword` 5.2 s (code review F3).
  - Cost: an `export { name }` list does not count as exported for attribution. Such a const
    then attributes to its enclosing function, or fails as unattributable; it never passes
    silently.
- **Self-check findings fixed:**
  - auth-surface-matrix rows cite subjects instead of stale line ranges (R29);
  - the `V1Forbidden` comment no longer claims SA tokens are gated (R49);
  - deny cells on mutating handlers assert that the write did not run (RT8);
  - the CLI passkey message lives in one helper (R2);
  - the `authOrToken` doc comment lists the new variant.
- **Unit red proofs** (scratch copy), each turning its suite red:
  - the helper returning `false`;
  - the gate removed from `validateApiKey`, from `validateOperatorToken`, and from
    `validateExtensionToken`;
  - `lastUsedAt` written before the gate, in `validateApiKey` and in `validateExtensionToken`;
  - the write put back into the DPoP helper;
  - the exemption ignored.
- **Integration red proofs:** the agent ran two, both red: the gate removed from
  `validateApiKey`, and the audit limiter check deleted.

## Code review round 1 — C7 decisions

- **Relation fields vs delegates (S1):** a token-model delegate may only be used as
  `<ref>.<member>(...)`; any other reference fails. `x.<handle>.<name>` still passes when
  `<name>` is not a delegate member, because a row's relation field has the same spelling as a
  delegate handle (`s.mcpAccessToken.mcpClient` in `vault/delegation`). The member set is closed
  (filtering and writing method names plus `fields`), and `$extends` is refused so it stays
  closed.
- **Residual (S1), closed in round 2:** a computed element access with a non-literal key
  (`tx[name].findUnique(...)`) was not refused. Round 2 made lookup detection independent of
  the receiver, and refuses a where-taking method on such an element access (below).

## Code review round 2 — C7 mechanism change

The user's decision was to change the mechanism (C1, N1, N2).

- **Lookups no longer depend on the receiver (C1, N1).** Any call is a lookup when an
  argument holds a `tokenHash`/`codeHash` key under a filter position:
  - the top-level `where` / `cursor` / `having` (`having` added: it is a filter too);
  - a relation `where` under `include` / `select` / `_count.select`, recursively;
  - a nested-write filter under `data` or an upsert's `create` / `update`: `connect`,
    `disconnect`, `set`, `delete`, `deleteMany`, and the `where` of `update`, `updateMany`,
    `upsert`, `connectOrCreate`.

  One walk decides both lookup and opacity, carrying the position's model, or null where the
  receiver does not resolve. Nothing else decides whether a call is a lookup, so the old
  receiver test is gone from lookup detection. Receiver resolution remains for one purpose:
  scoping opacity and crediting model coverage. Its refusals (the delegate-reference rule,
  `$extends`) remain for that purpose.
  - Real-repo effect: the emergency-access accept and reject handlers each gain a second site,
    the CAS `transition({ where: { id, tokenHash } })` on the row they found. They are now
    `calls: 2`; both are still `exempt`. No ungated user-bound lookup was found.
- **Opacity beyond `where`.** On a token model, or a model with a direct relation to one,
  these positions are opaque when the gate cannot read them: an argument, a `select` /
  `include` (each relation's own arguments, recursively), and the `data` of a create / update /
  upsert with its nested writes.
  - "Reaches by relation" is taken as one hop: the token models, plus every model with a
    relation field to one (23 of the 60 models). Transitive reach covers 57 models. With
    neither refinement below, it made 41 real-repo functions opaque, against 16 for one hop.
  - One hop is also the scoping the kept `where` rule already uses: a spread in a non-token
    model's `where` is not opaque either.
  - Two refinements bring 16 to 11 (transitive reach with both would be 18). Both read the
    code; neither guesses:
    - `createMany` / `updateMany` and their AndReturn forms take scalar columns only (Prisma's
      contract), so their `data` cannot hide a nested write.
    - A spread in a non-filter position is read in place when its value is readable:
      `...(c ? {a} : {})`, `...(c && {a})`, or a `const`-bound literal.
  - A spread in a filter stays opaque by the earlier decision, so no seeded `opaque-where`
    entry changed.
  - The 11 new `opaque-where` entries were each read at the site. Nine are scalar-only
    `Record<string, unknown>` update maps or the `toBlobColumns` / `toOverviewColumns`
    helpers. The other two are Auth.js's `updateUser` rest object and the retention sweep's
    computed `select` key over a closed column union.
- **Receivers.** A where-taking delegate method on an element access whose key is neither a
  literal nor a `const`-bound string fails. A `const`-bound handle is followed, in the receiver
  and in the delegate-reference scan, as a `const`-bound `where` is. Nothing in the real repo
  has that spelling.
- **Raw SQL (N2).**
  - `U&` / `UESCAPE` (any case, as written or cooked) are refused in any literal.
  - Regular-expression literals are scanned for the column names too, because a regex's
    `.source` is its text.
  - `renderSql` throws when its rendered text matches `/(?:token|code)_hash/i`. This is the
    run-time half for identifiers spliced through `trustedSql` / `sqlIdentifier` / `joinSql`,
    which no source literal shows. The pattern is spelled with a group so that it is not
    itself a refused literal.
  - No call site renders such text today. The `renderSql` callers are the retention-GC sweep,
    the outbox worker, and `scripts/migrate-account-tokens-to-encrypted.ts` (the third was
    missed in round 2, NF4). The first two take identifiers from registry constants and webhook
    table names, the script touches only the `accounts` token columns, and non-test `src` holds
    no `token_hash` / `code_hash` literal, because C7 refuses one.
  - The header's old claim, "its text is literal and scanned", is rewritten. The literal parts
    are scanned; the spliced parts are checked by `renderSql`.
- **Inline gates (M1).** An `inlineGate` must hold `if (<gate>(...))` or
  `if (await <gate>(...))`, the condition exactly that call, with no `else`. The consequent
  must return a refusal literal:
  - `ok: false`;
  - or no `ok` and an `error`;
  - or no `ok` and a string `type` other than `"success"`.

  The three real inline gates have these shapes: `{ ok: false, … }`,
  `{ error: "access_denied", … }` and `{ type: "passkey_required", … }`.
- **Runtime:** measured on the same host, back to back, with the real repo (1044 files):
  - before this change: 6.1 s;
  - after: 6.5–7.2 s, depending on load.

  The profile puts the extra ~0.6 s in the argument walk, mostly the shared `objectLiterals`
  mutation check. A call on no known delegate is walked only in a file that spells a digest
  key or holds a backslash (an escape could spell one).
- **Self-test:** 262 cells. Each new rule has a deny cell and a paired allow cell.
  Each was red-proved by removing or weakening its clause on a scratch copy, and every mutation
  turned its cells red.

### Residuals (Anti-Deferral)

Superseded by "Code review round 3 — residuals" below. Round 3 found two of the round-2
statements untrue: "a lookup through one is found" holds only where the filter is readable,
and "the only raw SQL on a token table" omitted the retention-GC sweep.

## Code review round 3 — C7 fixes and declaration

The user's decision: fix the cheap items and the overstated claims, declare C7 as a
best-effort detection gate, and record the rest as residuals. A follow-up issue owns
exhaustive coverage.

- **Control class, declared (R49).** C7 is a best-effort detection gate (the tripwire
  class) over Prisma query-builder digest lookups and raw-SQL literal text. It is not an
  enforceable boundary. The enforcement is the per-use gate inside each validator
  (`passkeyGateBlocks`), pinned by the validators' unit and integration tests and by review.
  The gate header and the plan's C7 say the same.
- **Unicode escapes at run time (S3-1/NF3).**
  - `renderSql` also refuses rendered text matching `/u(?:&|escape)/i`, through an `exec`
    captured at load, like the digest check. The group keeps the pattern from being a literal
    C7 refuses. Respelling it `/u&|uescape/i` on a scratch copy fails C7 at that line.
  - `u &` with a space is not refused. This matches the static rule's set: PostgreSQL reads
    the prefix only when the ampersand directly follows the `U`, so `u & b` is an identifier
    and an operator.
  - Deny cells: `${sqlIdentifier("u")}&"token\005fhash"`, `uescape` through an identifier,
    and an upper-case `ESCAPE` after a `u` identifier.
  - Allow cells: `SELECT a & b`, `u & b`, and a literal `'escape'`.
- **Stable refusal codes (NF2).**
  - `renderSql`'s refusals carry `code`: `RAW_SQL_DIGEST_COLUMN` or `RAW_SQL_UNICODE_ESCAPE`
    (`RAW_SQL_REFUSAL_CODE`).
  - The digest predicate is exported as `namesDigestColumn`.
  - `validateRegistry` refuses, at boot, a registry identifier the predicate matches. That
    covers table, cutoff, key, provenance and predicate columns, under the same code.
- **Tamper cells (T3-1).** With `RegExp.prototype.exec`/`test` replaced to report no
  match, `renderSql` still refuses the digest splice. Replaced to report a match, it still
  renders `SELECT 1`.
- **`replacedByHash` (S3-5).** `replacedByHash` / `replaced_by_hash` join the digest key
  set, the column rule, the digest-spelling pre-filter, and `renderSql`'s pattern.
  - The real repo has one use, the rotation CAS's `data: { replacedByHash }` in
    `oauth-server.ts`. That is a write, so the gate still passes with 39/39 and no new entry.
- **Computed keys (S3-4).** A computed key is read when it names a string literal or a
  `const` bound to one (`{ [k]: h }` with `const k = "tokenHash"`). No real-repo result
  changed: the retention sweep's computed `select` key is a loop variable, still opaque.
- **Self-test (T3-2, T3-3, T3-4).**
  - An upper-case `TOKEN_HASH` deny cell pins the rule's `/i`.
  - The overload cell builds its variant with `swap`.
  - `LOOKUP_IN_OTHER` matches the whole message,
    `#lookup (lines N) — 1 digest lookup(s), 0 opaque site(s).`. Under a mutation that
    reports opaque sites on unresolved receivers, the old `.*1 digest lookup` stayed green on
    all 7 receiver cells, and the anchored pattern turned 3 red.
  - The self-test has 271 cells.
- **Red proofs (scratch copy), each turning its cells red:**
  - `renderSql`:
    - the Unicode check removed;
    - its `/i` dropped;
    - the pattern widened to `u\s*` and to a bare `&|escape`, which turns the allow cells
      red;
    - an uncaptured `.test` on the digest pattern (both tamper cells red);
    - an uncaptured `.exec` on the Unicode pattern;
    - `code` dropped;
    - `replaced_by` dropped.
  - `validateRegistry`:
    - the digest check removed;
    - the predicate-column loop removed;
    - a predicate widened to `/token|hash/`, which turns the real-registry allow cells red.
  - The gate:
    - `replacedByHash` dropped from the key set;
    - `replacedByHash` dropped from the pre-filter alone;
    - `replaced_by_hash` dropped from the column rule;
    - the column rule's `/i` dropped;
    - computed keys read by `literalName` again;
    - `constString` accepting a `let`, which turns the residual-pin cell red;
    - a no-op `swap` in the overload cell.
- **Runtime:** 6.9–7.1 s on the real repo (1044 files).

### Code review round 3 — residuals (Anti-Deferral)

Each residual is a spelling C7 does not see. Recovery for every one is the validators'
per-use gate, their tests, and review.

- **A digest key in a filter value C7 cannot read, under a filter whose model is unresolved
  or not a token model (S3-2).** The values are:
  - a spread, whatever its operand: `...(c && {k})`, `...(c ? {k} : {})`, or a
    `const`-bound literal;
  - a `&&` / `||` / `??` expression;
  - a helper's return, including inside `AND` / `OR`;
  - a computed key not pinned to a string.

  The filters are:
  - any call whose receiver the model resolution does not follow, including a relation
    filter under that call's top-level `where`;
  - a model that is not a token model, including a relation filter to a model that is not
    one.

  There the key is neither a lookup nor refused as opaque. Probed on a scratch copy:
  - unseen: 10 shapes: an `&&` spread, a conditional spread, an `&&` value, a
    helper, a const spread, an `&&` under `OR`, a helper under `AND`, an `&&` spread on `Note`,
    one under an unresolved one-hop `apiKeys.some`, and one under `Profile.user`;
  - seen: a bare conditional `where` and a `const`-bound `where` are lookups;
  - refused: the same `&&` spread or helper under `User.apiKeys.some` (a token model) is
    opaque.

  This corrects two round-2 claims. "A lookup through one is found" holds only for readable
  filters. "Parameter-passed delegates are all covered" (the round-2 resolution in the
  code-review log) holds only for readable filters too.
  - Worst case: a new user-bound validator finds its row through such a value, skips
    `passkeyGateBlocks`, and C7 stays green. A passkey-required tenant's member keeps using
    that credential, and I1 is broken for it with no signal from this gate.
  - Likelihood: low, though the gate cannot measure it.
    - Every manifest entry outside `opaque-where` has at least one lookup C7 sees, because a
      function whose only sites are opaque fails as `OPAQUE_WHERE`. So each listed validator
      reads its digest through a readable filter.
    - Rounds 1–2 read every manifest function.
  - Cost to fix (measured on a scratch copy against the real repo): refuse an unreadable
    filter value on every model, not only token models. That changes the three
    `opaqueIf(TOKEN_MODELS.has(…))` calls in `walkWhere` / `readRelationFilter`.
    - Analysed functions go from 39 to 365: 326 new `UNLISTED`, plus 15 `OPAQUE_WHERE` and 24
      `COUNT_MISMATCH` on existing entries.
    - Runtime is unchanged at 6.9 s. Also walking every call, without the digest-spelling
      pre-filter, gives 366 at 7.2 s.
    - Each of those functions would need an `opaque-where` entry, so the manifest's signal
      drowns.
    - The round-2 cost (refuse handle strings, or a type-resolved Program) does not touch
      `walkWhere`, so it would not close this residual.
    - Exhaustive coverage needs dataflow across calls and files, which the follow-up issue
      owns.
- **Reflective delegate spellings** (`Reflect.get(tx, "apiKey")`, `Object.values(tx)`, a
  delegate a function returns, a parameter not named by its handle). Lookups are found only
  where the filter is readable (above), and opaque positions are not refused.
  - Worst case: a validator that reaches its delegate this way and filters through an
    unreadable value has no site C7 attributes at all, so it needs no manifest entry.
  - Likelihood: low. C7 refuses every way to take a token-model delegate as a value by its
    handle (property, pinned element access, destructuring), so such a delegate must come
    from a reflective or dynamic spelling. In non-test `src`, `Reflect.get` appears only in
    the client proxy in `src/lib/prisma.ts`, which forwards every property generically, and
    no `tx[…]` / `prisma[…]` element access exists.
  - Cost to fix: resolving these receivers needs a type-resolved Program. Program
    construction made the gate take about 36 s (round 1's `isExported` measurement). It would
    restore opacity for these receivers only. The lookup-detection half is the residual
    above, and its cost.
- **Opaque values more than one relation hop from a token model** (a `data` or projection on
  a model with no token relation that hides a nested write or filter through one that has).
  - Worst case: a nested lookup hidden two models deep in an unreadable `data` or
    `include`.
  - Likelihood: low. The 7 functions a transitive closure would surface today hold 0 digest
    lookups and 1 opaque site each. Each site is a non-literal `data` / `create` / `update` on
    `DirectorySyncConfig`, `Folder`, `Tag`, `TeamFolder`, `TeamPolicy`, `TeamTag` or
    `TenantMember`, in update handlers.
  - Cost to fix (re-measured): switch `TOKEN_ADJACENT` to the transitive closure (57 of 60
    models). That adds 7 `UNLISTED` functions today (46 analysed), and an entry for most
    future update routes on the 34 models it adds.
- **Raw SQL that never names the column:**
  - whole-row projections compared or searched as values (`to_jsonb(t)`, `row_to_json(t)`,
    `t::text`, `t.*`);
  - dynamic SQL built inside the statement (`EXECUTE format(...)`);
  - views, functions or triggers defined in `prisma/migrations`.

  - Worst case: a digest matched against a whole-row value, or through a database function,
    with no column name in `src`.
  - Likelihood: low. Raw SQL is allowlisted file by file (`check-raw-sql-usage`), and each
    file is reviewed. Raw SQL that touches a token table today:
    - the retention-GC sweep's expiry and age deletes on 11 token tables, built by
      `renderSql` from registry cutoff and key columns, which `validateRegistry` now checks
      against the digest predicate at boot;
    - three files' `password_shares` view-count `UPDATE`s, each `WHERE "id" = ${share.id}`.
  - Cost to fix: a SQL parser over every raw literal plus the migrations, which is a
    different control.
- **Raw SQL through the pg driver (S3-3).** A `createPool` / `createClient` result's
  `.query(...)` is outside C7's raw-method rule, so its SQL argument is unconstrained:
  - a column name split across a concatenation (`"token_" + "hash"`) is not seen;
  - `renderSql` is not on that path.

  A literal naming the column is still refused by the literal rule.
  - Worst case: a new module runs a digest lookup through `pool.query` with a split column
    name, ungated, and C7 stays green.
  - Likelihood: low. Facts today:
    - non-test `src` has no `.query(` call (grep; the `.query` hits are object properties);
    - `createClient` has no caller;
    - the four `createPool` callers use the pool only for `.on("error")`,
      `createPrismaClient(pool)` and `.end()`: `src/lib/prisma.ts`, the retention-GC,
      audit-outbox and audit-anchor-publisher workers;
    - check-bypass-rls refuses a pg Pool/Client built outside `pool-factory`.
  - Cost to fix: refusing a `.query(...)` call in non-test `src` matches 0 sites today
    (grep). It would need the escape checks the raw-method rule already has: element access,
    `.call` / `.apply`, and a value reference. That is not built or measured; the follow-up
    issue owns it.
