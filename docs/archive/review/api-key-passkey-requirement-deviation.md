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
