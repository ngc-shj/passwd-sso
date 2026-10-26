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
  - `token_hash`/`code_hash` is refused in any string or template literal in non-test `src`,
    because an interpolated fragment is invisible at the call site.
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
- **Residual (S1):** a computed element access with a non-literal key (`tx[name].findUnique(...)`)
  is not refused. Refusing it would refuse every computed member access in `src`.
  - Anti-Deferral: the worst case is a new validator written in that spelling escaping C7. The
    likelihood is low: no such spelling exists today, and the house style names delegates
    literally. Closing it needs a type-resolved Program, the ~36 s cost the gate was just rid of.
    Code review sees it.
