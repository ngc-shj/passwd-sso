# Plan Review: rls-refusal-metric
Date: 2026-11-16
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screen skipped (Ollama unavailable); deduplication done manually.

## Functionality Findings

- **F-01 [Major, design]** (converged with S1) — Refusal counting exists only while `rls_bypass_enforced()` is true. #921's zero window is observed before the flip (report mode), and an un-flip returns to report mode; in both, a role/database `client_min_messages=error` still silences every report. Objective/SC1 overclaimed removal of #921's precondition. → Resolved: plan scoped to enforcing mode; report-mode dependence on the WARNING stated; canary labelled enforcing-only; alerts.md "Reports keep counting after an un-flip" qualified.
- **F-02 [Major, design]** (converged with S3, T-F4, T-F5) — Module-load `new pg.Client()` probe breaks three `vi.mock("pg")` suites (`src/__tests__/lib/prisma.test.ts`, `src/lib/prisma.test.ts`, `src/workers/audit-outbox-worker.test.ts`); `client.connection.on` breaks bare-EventEmitter connect fixtures (`pool-factory.test.ts`, `src/__tests__/lib/prisma.test.ts`); `kind` breaks exact-shape sink assertions. Pool-path behaviour without `connection` unstated. → Resolved: lazy memoized probe at first `createPool`/`createClient`; `Client`/`native` overrides refused in `checkedConfig`; every affected test file listed; fail-closed cells added (A7).
- **F-03 [Minor, design]** — A throwing sink inside the `errorMessage` emit can stop pg settling the query or escape the parser. → Resolved: sink invocation wrapped (both listeners), content not logged on catch.
- **F-04 [Minor, design]** — No helper to take a refusal that the code under test swallows. → Resolved: `expectSwallowedBypassRefusal` added (C3); `failOnReports` message names it.
- **F-05 [Minor, prose]** — Docs member set incomplete (security-review.md:262, tenant-boundary-matrix.md:100-103, threat-model.md:93, deployment.md:196-198, alerts.md "only trace" and unparsed paragraph). → Resolved: added to C5.
- **F-06 [Minor, Adjacent]** (converged with T-F9) — see T-F9.
- **F-07 [Minor, design]** (converged with S5) — C4 omits psql runbooks that open bypasses outside the factory. → Resolved: listed as documented exceptions.

## Security Findings

- **S1 [Major]** — merged into F-01.
- **S2 [Minor, design]** — `where.includes("rls_bypass_admits")` accepts verified forgeries (outer `SQL statement` frame comment; `pg_temp.rls_bypass_admits`). Two listeners would each carry their own source check (R48). → Resolved: one shared source predicate for both listeners: the innermost frame (first line of `where`) must contain `public.rls_bypass_admits(text)`; substring elsewhere → unparsed; arbitrary-SQL forgery declared out of scope.
- **S3 [Minor, Adjacent]** — merged into F-02.
- **S4 [Minor, design]** — pool-path listener registers after pg's own. → Resolved: `prependListener`.
- **S5 [Minor, prose]** — C4 exceptions grep scoped to `src scripts` (misses `prisma/seed.ts`, `e2e/helpers/db.ts`, `load-test/setup/seed-load-test-users.mjs`); "five log groups = processes above" miscounted (nine). → Resolved.
- **S6 [Minor, design]** — Known-gap (a) member set should come from `pg_proc`; add runtime arbitrary SQL `DO … EXCEPTION`. → Resolved.

## Testing Findings

- **T-F1 [Major, design]** — `rls-bypass-grants.integration.test.ts:165-187` uses a raw `pool-factory-exempt` `pg.Pool` with `expectBypassRefusal`; C3's new check would fail it. → Resolved: explicit `{ counted: false }` opt-out asserting an empty refusal buffer; helper self-test.
- **T-F2 [Major, design]** — The `where` red-proof cannot fail (plain 42501 has no matching message). → Resolved: look-alike cells (unit + integration `DO` block) and `mockWarn` not-called assertion.
- **T-F3 [Major, design]** — Red-proofs not per clause. → Resolved: per-clause red-proof table (A9).
- **T-F4 [Major, design]** — merged into F-02.
- **T-F5 [Major, design]** — merged into F-02 (A7).
- **T-F6 [Major, design]** — A5 not pinned to one connection; session-level SET leaks. → Resolved: `SET LOCAL` inside one interactive tx on a factory pool.
- **T-F7 [Major, design]** — Negative cell lacks privilege precondition and SQLSTATE assertion. → Resolved.
- **T-F8 [Major, design]** — stderr sink line never matched against the filter. → Resolved: A4 runs both sinks through `matchesFilterPattern` with `TerraformConfig`, with a deny pair.
- **T-F9 [Major, prose]** — `operator-scripts-rds-shaped.integration.test.ts:562` asserts the underscore spelling and can never fail. → Resolved: regex over the dotted `_logType`s, red-proved.
- **T-F10 [Minor]** — allow cells (localized `where`, length boundaries, `{}`). → Resolved (A1).
- **T-F11 [Minor]** — A2 should assert behaviour on unconnected clients. → Resolved.
- **T-F12 [Minor, prose]** — registrant list omits test registrants; "~20" unmeasured. → Resolved: counts replaced with commands.

## Adjacent Findings
- S3 (testing/availability) → F-02. F-06 (testing) → T-F9.

## Quality Warnings
None (manual merge; every finding carried file/line evidence and, where probed, the probe script path).

## Recurring Issue Check

### Functionality expert
R1 Checked — no issue · R2 Checked · R3 F-05 · R4–R9 N/A · R10 Checked · R11 N/A · R12 Checked (see F-05) · R13–R15 N/A · R16 Checked · R17 Checked · R18 N/A · R19 F-02 · R20–R21 N/A · R22 F-04 · R23–R28 N/A · R29 Checked (line citations correct; overclaim in F-01) · R30–R31 N/A · R32 N/A · R33 N/A · R34 F-06 · R35 Checked (canary deferred under V1) · R36–R40 N/A/Checked · R41 F-01 · R42 F-07 · R43–R46 N/A · R47 Checked · R48 Checked · R49 F-01 · R50 Checked · R51 N/A · R52 F-02 · R53 N/A · R54 N/A · R55 Checked · R56–R57 N/A

### Security expert
R1 n/a · R2 OK · R3 S2 · R4–R9 n/a · R10 OK · R11 n/a · R12 OK · R13 n/a · R14 checked · R15 n/a · R16 OK · R17 OK · R18 n/a · R19 S3 · R20–R28 n/a · R29 checked · R30–R33 n/a · R34 OK · R35 OK (SC2) · R36 OK · R37–R39 n/a · R40 OK · R41 OK · R42 S5, S6 · R43–R46 n/a · R47 S2 · R48 S2 · R49 S1 · R50 OK · R51 n/a · R52 checked · R53–R54 n/a · R55 OK · R56–R57 n/a · RS1 n/a · RS2 OK · RS3 OK · RS4 OK · RS5 n/a · RS6 OK

### Testing expert
R1 N/A · R2 OK · R3 F1/F4 · R4–R18 N/A · R19 F4 · R20–R28 N/A · R29 F12 · R30–R32 N/A · R33 OK · R34 F9 · R35 OK · R36–R41 N/A · R42 F12 · R43–R49 N/A/OK · R50 F6 · R51–R57 N/A · RT1 F4 · RT2 OK · RT3–RT4 N/A · RT5 F6 · RT6 F5 · RT7 F2/F3 · RT8 F7 · RT9 N/A · RT10 F10 · RT11 F6

---

# Round 2
Date: 2026-11-16

## Changes from Previous Round
Plan rewritten to resolve all round-1 findings (scoped to enforcing mode, shared source predicate, prependListener, lazy probe, C3 helpers, repo-wide C4, extended docs list, per-clause red-proofs). Orchestrator verified by execution that the WARNING's `where` is also `PL/pgSQL function public.rls_bypass_admits(text) line 19 at RAISE`.

## Findings (all round-1 findings verified resolved by their filers; functionality corrected its round-1 claim about the raw-pool cell)

- **N-01 / T2-4 / T2-5 [Minor, design, R19]** — unlisted fixtures: unqualified `where` (pool-factory.test.ts, pool-factory.metric-filter.test.ts, src/__tests__/lib/prisma.test.ts), bare-EventEmitter connect cells, `default`-shaped pg mock. → Resolved: C2 lists them by command; ja fixture marked as constructed (no translations on the worktree server).
- **N-02 / R2-S3 [Minor, design, R48/R55]** — `mentioned` ambiguous for an unqualified innermost frame; one reading drops every report silently if the function loses its `SET search_path`. → Resolved: `mentioned` includes the first line; search_path dependency commented; A1 drift cells + A9 mutation.
- **N-03 / R2-S1 [Minor, design]** — sink try/catch could make a failing sink read as zero. → Resolved: fixed content-free unparsed line on stderr in a nested try; A1 cell.
- **R2-S2 [Minor, design/prose, R49]** — memo must cache success only; probe proves listener API presence, not event name. → Resolved (merged with T2-2).
- **T2-1 [Major, design]** — listener-order assertion vacuous on unconnected clients; no mutation for `prependListener` → `.on`. → Resolved: pool cell with a preceding throwing listener; identity assertion dropped; A9 row.
- **T2-2 [Major, design]** — failure memoization unspecified; A7 not isolatable. → Resolved: success-only memo, throws-twice cell, own file with resetModules/doMock, probe-once allow cell, test seam.
- **T2-3 [Minor, design]** — createClient per-instance check redundant. → Resolved: removed.
- **T2-6 [Major, design]** — swallow-in-tx outcome unpinned. → Resolved: explicit BEGIN/ROLLBACK on a factory pool client (no Prisma commit-on-aborted dependence); helper contract `fn` must resolve + self-test; post-tx `SHOW` leak check.
- **T2-7 [Minor, design]** — `^` anchor and over-strict probe mutations. → Resolved: A1 prefix cells, A9 rows.
- **T2-8 [Major, design]** — A8 red-proof could fail at import. → Resolved: mutated script in a git-ignored in-repo path via `redProofOverride`; red run must show `rls.bypass_refused` on stderr.

## Recurring Issue Check (round 2)
- Functionality: R3 N-01 · R19 N-01 · R48 N-02 · R55 N-02 · all others Checked/N/A as round 1 (R29 re-derived: pg_proc set, C4 grep, 10 registrants, `where` text).
- Security: R49 R2-S2 · R50 R2-S2 · R55 R2-S1 · R52 checked (stricter predicate drops no real report, definer path probed) · RS1–RS6 as round 1.
- Testing: R19 T2-4/T2-5 · R42 T2-4 · R50 T2-6/T2-8 · RT1 T2-5 · RT7 T2-1/T2-2/T2-3/T2-7/T2-8 · RT10 T2-2/T2-7 · RT11 OK (SET LOCAL + post-tx check).

---

# Round 3
Date: 2026-11-16

## Changes from Previous Round
Round-2 findings applied (fallback line on sink failure, success-only probe memo, unqualified-frame drift cells, A2 throwing-listener pool cell, A5 explicit BEGIN/ROLLBACK, A8 red-proof via redProofOverride). All three experts verified every round-2 resolution; no Critical or Major findings.

## Findings (all Minor)
- **R3-S2 / N3-01 [Minor, design]** (converged) — fallback line bypassed the shared unparsed rate-limit slot. → Resolved: gated on the shared slot; A1 two-failures cell; A9 row.
- **R3-S1 [Minor, prose]** — alerts.md unparsed paragraph must name a throwing log sink as a cause. → Resolved in C5.
- **N3-02 / R3-1 [Minor, design]** (converged) — post-tx `SHOW` on "the same pool" could hit another backend; compare against a baseline; leftover "interactive transaction" wording. → Resolved: same checked-out client, baseline read before BEGIN, `SET LOCAL`→`SET` A9 row.
- **N3-03 [Minor, prose]** — negative cells' observation mechanism unnamed. → Resolved: explicit buffer drain + empty assertions.
- **R3-2 [Minor, design]** — ≥1-refusal clause of `expectSwallowedBypassRefusal` lacked a self-test. → Resolved: A6 cell + A9 row.
- **R3-3 [Minor, prose]** — probe-once spy must count `createPool` calls only. → Resolved.
- **R3-4 [Minor, design]** — look-alike `DO` cell must assert the 42501 + exact message first. → Resolved.

## Recurring Issue Check (round 3)
- Functionality: R1/R3 N3-01 · R50 N3-02 · R22 N3-03 · others Checked/N/A (R19 fixture command reproduces 7 lines; R29 re-derived).
- Security: R37 R3-S1 · RS2 R3-S2 · R29 checked (awslogs ships stderr; check-worker-logtype / check-console-sinks scope) · others OK/n/a.
- Testing: R50 R3-1 · RT7 R3-1/R3-2 · RT8 R3-4 · RT10 OK · RT11 OK · others OK/N/A.

---

# Round 4
Date: 2026-11-16

## Changes from Previous Round
Round-3 Minor findings applied (fallback rate-limited on the shared slot, alerts.md sink-failure cause, A5 same-client baseline check, explicit buffer drains, helper ≥1-refusal self-test, createPool-only probe spy, look-alike cell asserts 42501 first).

## Findings
Functionality: No findings. Security: No findings. Testing: No findings.

Plan review complete after 4 rounds; all contracts locked.
