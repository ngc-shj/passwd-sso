# Plan Review: auth-passkey-policy-fail-closed
Date: 2026-07-20
Review round: 1

## Changes from Previous Round
Initial review.

## Summary
0 Critical, 1 Major, 8 Minor. All three experts independently verified the core design: the fail-closed bundle produces `passkeyEnforcementBlocks === true` (gate blocks → exempt setup page, no loop/lockout), the happy path is unchanged, consumers accept the bundle, and the R42 member-set is complete (single enforcement fail-open at `auth.ts`; all `derivePasskeyState` gates already fail-closed via throw).

## Functionality Findings
- **F1 (Minor)** — Self-heal during a sustained outage: the setup page is reachable-but-non-functional (register endpoints need DB); user is parked, not locked out. Plan documents ≤30s over-block but frames self-heal only as cache expiry. → doc clarification.
- **F2 (Minor)** — `fetchFavicons` already reset-to-false in the catch (pre-existing, cosmetic). Plan claim confirmed accurate. No action.

## Security Findings
- **MIN-1 (Minor)** — R42 table compresses the `derivePasskeyState` 7-site fan-out into one row; plan's grep misses the `derivePasskeyState(` call form. All 7 sites independently verified fail-closed. → add a second grep line + enumerate for reproducibility.
- **MIN-2 (Minor)** — Fetch failure now forces tenant-wide fail-closed blocking but logs at `warn`. Consider `error` level / page-worthy alerting. Not blocking.
- No Critical findings; nothing to escalate.

## Testing Findings
- **F2 (Major)** — Missing coverage: a `requirePasskey=true` tenant + user who HAS a passkey must NOT block (`passkeyEnforcementBlocks === false`). T2 asserts value pass-through, not the negative verdict; a fix clobbering `hasPasskey` would go undetected. → add T2b.
- **F1 (Minor)** — T1 must import the REAL `passkeyEnforcementBlocks` (do NOT `vi.mock`/re-implement) — keep RT5 auditable.
- **F3 (Minor)** — T1 must assert ALL FOUR fail-closed field values (not just `requirePasskey`); with `enabledAt=null` the predicate short-circuits, so the verdict alone doesn't exercise the grace branch (INV-2 provability).
- **F4 (Minor)** — Define the fail-closed bundle once (`const FAIL_CLOSED`) to avoid T1/T2 drift (RT3).
- **F5 (Minor, RT1)** — T3 log assertion is NOT implementable: the logger mock returns fresh spies per `getLogger()` call. Need a hoisted stable `mockWarn`.

## Adjacent Findings
- Testing F5 (RT1) touches `src/auth.test.ts` mock topology (adjacent to implementation).
- Security MIN-2 (log level) adjacent to functionality/ops.

## Recurring Issue Check
### Functionality expert
- R38: PASS — plan is the direct remediation; bundle yields `passkeyEnforcementBlocks===true`.
- R42: PASS — independently re-derived (9 files), single enforcement fail-open (M1) confirmed.
- R43: PASS — widens the BLOCK set only, never GRANT; fail-safe; ≤30s over-block bounded by cache TTL.

### Security expert
- R38: PASS — sole fail-open (M1) closed; all other paths fail-closed; no residual async/error fail-open.
- R42: PASS with Minor — re-derived 10 sites, all covered; table under-enumerated (MIN-1) but coverage complete.
- R43: PASS — blocks more, never grants more; explicitly fail-safe.
- RS3: PASS/N/A — no new external input; bundle server-produced + `SessionInfoSchema`-validated.

### Testing expert
- RT5: ADDRESSED but implicit (F1) — make the real-predicate import explicit.
- RT7: PARTIALLY — INV-2 direction not provable unless all four fields asserted (F3).
- RT8: ADDRESSED (strongest part) — T1 asserts field mutation + production verdict.
- RT3: not addressed, low impact (F4).
- RT1: ONE DIVERGENCE — logger mock fresh-spy (F5); callback-extraction + `mockWithBypassRls`-reject verified accurate.
