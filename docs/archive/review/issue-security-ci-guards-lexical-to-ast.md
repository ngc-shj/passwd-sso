# Promote security CI guards from lexical (string/regex) to AST matching

## Summary

Several security CI guards decide whether a route/file satisfies a
security-relevant invariant by testing whether a **string or regex appears
anywhere in the source text**. Because the match is lexical, a comment, a
string literal, or an unused import that merely *contains* the token satisfies
the guard — even though no real call site exists. The runtime is currently
correct in every case, so this is a **guard-strength (false-negative) gap**,
not a live vulnerability. This issue tracks migrating these guards to AST-aware
checks that assert the actual call/argument, and doing it as one unified pass
rather than piecemeal.

## Affected guards

### 1. `route-policy-manifest.test.ts` assertion 8b/8c — operator-gated route requirements
- `src/__tests__/proxy/route-policy-manifest.test.ts:290-302` (8b) and `:313` (8c)
- Uses `source.includes("verifyAdminToken(")`, `source.includes("requireMaintenanceOperator(")`, `source.includes("createRateLimiter(")`, `source.includes("checkRateLimitOrFail(")`, and `/failClosedOnRedisError:\s*true/.test(source)`.
- False negative: any of these tokens sitting in a comment or unused import satisfies the requirement without a real call. In particular `failClosedOnRedisError: true` is text-matched, not verified to be the argument of the *same* `createRateLimiter` call that the route actually uses.
- AST target: assert a real `createRateLimiter({ failClosedOnRedisError: true })` call expression and a real `checkRateLimitOrFail({ limiter: ... })` call, not just token presence.

### 2. `route-policy-manifest.test.ts` assertion 7 — side-effecting GET / destructive classification
- `src/__tests__/proxy/route-policy-manifest.test.ts:77-78,213,230`
- `DELETE_SIGNAL` / `WRITE_PRIMITIVE` are regexes over source text. Same lexical class: a matching token in a comment/string would mis-signal. (Lower priority — these are already documented two-tier heuristics.)

### 3. `check-raw-sql-usage.mjs` ident marker — validator-guards-value gap (Security Minor-2 from triangulate)
- `scripts/checks/check-raw-sql-usage.mjs` (marker mechanism ~`:148-155`, self-documented RESIDUAL ~`:418-442`)
- A `// raw-sql-ident:` marker naming a validator present *anywhere in the file* passes even if that validator does not guard the interpolated value at that call site. Same lexical ceiling.
- AST target (or type-level, see below): confirm the interpolated expression is the *return* of an identifier-validation call, not merely that a validator name appears in the file.

## Candidate approaches

- **AST matching** (ts-morph / typescript compiler API) for guards 1 and 2: match call expressions and their argument object literals structurally.
- **Branded types** for guard 3 (the P4 item from the triangulate review): `type SafeSqlIdentifier = string & { readonly __brand: "SafeSqlIdentifier" }`; the validator returns `SafeSqlIdentifier` and the raw-SQL helper accepts only that type. This moves the "value was validated" guarantee from a lexical marker into the type system. This belongs with the broader **worker policy manifest / raw SQL helper type design** work, so guard 3 should be scoped together with that.

## Why one unified pass, not piecemeal

- 8b/8c and assertion 7 already share the `source.includes` / regex idiom; upgrading only part of one assertion leaves inconsistent detection strength inside a single test file.
- Guard 3 (raw SQL) is entangled with the worker-policy-manifest / branded-type design layer (triangulate P4), which is itself a "sit down and design it" task, not a one-line fix.
- Doing all three at once lets a single AST-helper (or shared ts-morph setup) serve every guard, and keeps the "small, safe, focused" property of the tenant-scoped-rate-limit PR intact by keeping this out of it.

## Non-goals / current status

- No runtime vulnerability is implied — the maintenance routes verified in the tenant-scoped-rate-limit PR do carry the real calls with real `failClosedOnRedisError: true` and tenant-scoped keys.
- This is deferred from the PR `test/maintenance-rate-limit-tenant-key-guards` per reviewer agreement (finding 2 = guard 1 above; finding was Low severity).
