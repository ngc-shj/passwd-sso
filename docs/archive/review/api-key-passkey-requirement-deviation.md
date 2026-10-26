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
  - No call site renders such text today. The only `renderSql` callers are the retention-GC
    sweep and the outbox worker. Their identifiers come from registry constants and webhook
    table names, and non-test `src` holds no `token_hash` / `code_hash` literal, because C7
    refuses one.
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

- **Reflective delegate spellings** (`Reflect.get(tx, "apiKey")`, `Object.values(tx)`, a
  delegate a function returns, a parameter not named by its handle). A lookup through one is
  found; its opaque positions are not refused.
  - Worst case: a new validator passes the digest through an unreadable `where` on such a
    delegate, and C7 never sees it.
  - Likelihood: low. No such spelling exists, and `$extends` and the delegate-reference rule
    keep delegates named.
  - Cost to fix: refusing token-handle strings outside property positions would refuse the
    model lists in `src/lib/tenant-rls-grants.ts`, which spell those handles as data. Resolving
    the spelling instead needs a type-resolved Program, about 36 s.
- **Opaque values beyond one relation hop**, and a spread in a non-token model's `where`.
  - Worst case: a nested lookup hidden two models deep in an unreadable `data` or `include`.
  - Likelihood: low. A validator reads its token row directly, and every real lookup is a
    top-level `where`.
  - Cost to fix: switch `TOKEN_ADJACENT` to the transitive closure (one line). That adds 7
    scalar-only `opaque-where` entries now, and one for almost every future update route on
    the 34 other related models. The manifest's signal would drown in them.
- **A computed key under a filter** of a call that does not resolve to a token model
  (`{ [k]: h }`).
  - Worst case: a computed `tokenHash` key on an unresolved receiver.
  - Likelihood: very low. The walk meets one computed filter key in `src`: the retention
    sweep's, a closed union of retention columns.
  - Cost to fix: refusing a computed key under every filter of every call. The gate would
    then have to walk every call in every file, which the digest-spelling pre-filter avoids
    today. The runtime cost is unmeasured.
- **Raw SQL that never names the column:**
  - whole-row projections compared or searched as values (`to_jsonb(t)`, `row_to_json(t)`,
    `t::text`, `t.*`);
  - dynamic SQL built inside the statement (`EXECUTE format(...)`);
  - views, functions or triggers defined in `prisma/migrations`.

  - Worst case: a digest matched against a whole-row value, or through a database function,
    with no column name in `src`.
  - Likelihood: low. Raw SQL is allowlisted file by file (`check-raw-sql-usage`), and each
    such file is reviewed. The only raw SQL on a token table is three files' `password_shares`
    view-count `UPDATE`s, each `WHERE "id" = ${share.id}`.
  - Cost to fix: a SQL parser over every raw literal plus the migrations, a different control.
    Recovery is the raw-SQL allowlist review and the validators' tests.
