# Plan Review: stale-override-floors
Date: 2026-08-05 (round 1) / 2026-08-06 (round 2)
Review rounds: 3

## Changes from Previous Round

Initial review.

## Orchestrator Reproduction of Round-1 Claims

Every load-bearing claim below was re-executed by the orchestrator before the plan
was revised, rather than accepted from the sub-agents. Script:
`scratchpad/verify-round1.mjs` and `scratchpad/derive-v2.mjs` (throwaway; no
tracked file was modified).

**Confirmed:**

| Claim | Reproduction |
|---|---|
| `collectScopes` drops the `"."` key entirely | fixture `{'@crxjs/vite-plugin':{'.':'^2.7.1','rollup':'^2.80.0'}}` → `byPackage` holds only `rollup`; `unparseable` is `[]`. The `"."` pin appears in neither. |
| The entry census is 24 pins + 1 scope opener, 18 distinct names | executed walk over the three tracked manifests. The plan's 23 / 15 are both wrong. |
| `extension/package.json` has a `$ref` pin and a nested scope | `{"rollup":"$rollup","@crxjs/vite-plugin":{"rollup":"^2.80.0"},"undici":">=7.29.0 <8"}`; `$rollup` → `^4.62.3` (devDependencies). |
| An unbounded `>=` pin intersects a future band | `intersects(">=8.5.23", ">= 9.0.0 < 9.1.0")` → `true`. |
| The `<=` band tie flips the boundary | `intersects(">=8.5.23","<= 8.5.23")` → `true`; `"< 8.5.23"` → `false`. |
| Deleting `normalizeBand` throws rather than mis-answering | `intersects("^4.12.27", ">= 4.11.8, < 4.12.27")` → `Invalid comparator: >=4.11.8,`. |
| Object / null / number / array pins throw in `semver.intersects` | all four throw; `validRange({})` → `null`; `validRange("")` → `"*"`. |
| `actionlint` is absent from the repository | `rg -l actionlint scripts/ .github/` → no match. |
| `check-workflow-supply-chain.mjs` cannot enforce C5's `continue-on-error` ban | `runsVerifier = /audit\s+signatures/ \|\| (/npm\s+view/ && /attestations/)` — the new workflow matches neither. |
| `GHSA-r28c-9q8g-f849` (high) intersects both postcss pins | live API: `type=reviewed`, band `<= 8.5.17`, patched `8.5.18`. |
| One advisory carries bands for several packages | `GHSA-r5fr-rjxr-66jc` → `lodash`, `lodash-es`, `lodash-amd`, `lodash.template`, with two different bands and floors. |

**Partially refuted by measurement — this changes the remedy, so it is recorded
rather than folded silently into the fix:**

1. **F4's "unremediable permanent red" from `first_patched_version: null`.**
   Measured across all 18 overridden packages, filtering withdrawn advisories and
   filtering `vulnerabilities[]` to the subject package: **306 live vulnerability
   entries, of which 0 have `first_patched_version: null`.** Both examples the
   experts cited (`lodash` `GHSA-8p5q-j9m2-g8wr`, `effect` `GHSA-6hr9-4692-fch9`)
   are **withdrawn**. The withdrawn filter alone removes every live instance.
   Consequence: the withdrawn filter is required and the null-patch branch must be
   defined, but the proposed dated exemption file (`override-floor-exempt.txt`
   with `STALE_EXEMPT` anti-drift) has **zero live instances to serve** and is not
   built. Recorded as SC-E with the measurement.
2. **F4's claim that an unbounded `>=` pin has "no achievable green".**
   Measured: `intersects(">=8.5.23 <9", ">= 9.0.0 < 9.1.0")` → `false`, and
   `intersects(">=9.1.0", ">= 9.0.0 < 9.1.0")` → `false`. Two remedies exist —
   raise the floor above the band, or bound the pin below it. The observation
   (an unbounded pin intersects future bands) is correct and is addressed by
   naming both remedies in the violation message and the runbook; the conclusion
   (a wedge) is not, so C1 does **not** preemptively bound the five open-ended
   pins — that is a resolution-behavior change with a real cost and no live
   trigger.
3. **F7's "1 unreviewed advisory".** Measured: **0 live unreviewed advisories**
   across the 18 packages once withdrawn entries are excluded. The `::`-prefix
   output-sanitization remedy is still adopted (cheap, defence in depth); the
   reviewed/unreviewed tagging machinery is not.

Instrument note: the orchestrator's own first derivation reported **21 of 21
entries as members** — a total-coverage result that was an artifact of feeding
comma-separated advisory bands to `semver`. It was disbelieved and corrected
before any finding was raised from it. The same trap is now a locked C4 case.

## Findings

### F1 — Severity: Critical — The member-set derivation never walked two of the repo's override entries, and every count it reports is wrong
**Problem.** The plan states "23 override entries" and "15 distinct packages" (VE-3, AC-3.4, scenario 4). Independent derivation from tracked manifests at `8d688731c` shows **24/25 string-pin entries** and **17-18 distinct packages**. The scratchpad derivation skipped `extension/package.json → "@crxjs/vite-plugin"` and `extension/package.json → "rollup": "$rollup"`. Both agents note that AC-3.4 hardcodes this undercount as a pass condition. The six-member set (M1–M6) and required floors are verified correct, but the surface covered and the derived numbers are not.
**Impact.** AC-3.4 (the R53 headroom measurement) actively rewards the bug it was written to forbid: a correct walker reports 24/25 entries and fails AC-3.4; a buggy walker that skips nested scopes passes it. VE-3's rate-limit budget (15/60 vs 17/60) under-calculates local run frequency. Scenario 4's narrative is likewise wrong.
**Recommended action.** Replace all three numbers with figures produced by the committed gate, not the scratchpad. Add AC-3.0 to verify M1–M6 reproduction. Deny side: a `--report` run that omits the nested or `$ref` entries must fail AC-3.4. Red-prove each clause separately by deleting the `$ref` resolution branch and the nested-scope recursion branch on scratchpad copies. Route `MANIFEST_DISCOVERY_FALLBACK`, `MANIFEST_UNPARSEABLE`, and entry-count drift to named refusals rather than smaller counts.
*(Flagged by: Functionality, Security)*

### F2 — Severity: Major — The locked `advisoriesFor` shape drops package identity, causing foreign band bleed
**Problem.** C3 locks `advisoriesFor: (pkg) => Array<{id, severity, summary, bands: Array<{range, patched}>}>`. Nothing mandates filtering `vulnerabilities[]` to `package.name === pkg`. The GitHub API returns foreign bands (e.g., 10 of `lodash`'s 11 advisories carry bands for `lodash-es`, `lodash-amd`, `lodash.template`; `nodemailer` carries a Maven coordinate). The flattened shape makes this filtering unrecoverable downstream. Agents note the stub shape diverges from the raw API, and without an exact name filter, foreign bands intersect live pins.
**Impact.** A foreign band that intersects a pin produces a violation naming the right package with the wrong package's `first_patched_version`, sending the operator to raise a floor that fixes nothing. This replicates the exact "reds for a reason that has nothing to do with the tree" failure I-5.4 was written to prevent.
**Recommended action.** Mandate exact `package.name === pkg` filtering in the network shell before flattening. Widen the stub to pass raw API objects or add a `package` field to `bands` that `findStaleFloors` asserts. Add a canary check on a known package to validate response shape and host. Route `package.ecosystem !== "npm"` or missing name fields to `FOREIGN_BAND_REJECTED`.
*(Flagged by: Functionality, Security)*

### F3 — Severity: Major — Scope-opening override entries carry an object `pin`; C3 never defines how they are judged
**Problem.** `collectScopes` recurses into object-valued overrides and pushes the parent key into `byPackage` with `pin: {object}`. C3/I-3.1 requires every entry to be judged, but passing an object to `semver.intersects` throws a `TypeError`. The plan never states whether scope-openers are violations, skips, or excluded. It happens to fire today only because `@crxjs/vite-plugin` has 0 published advisories, making the `intersects` call unreachable.
**Impact.** The zero-member headroom claim rests on an accident of the advisory database. A reviewer cannot tell if the gate should be green or red at HEAD. An implementer will likely invent an untracked `continue` branch, risking silent drops of the `"."` form (F8) and future non-string pin types.
**Recommended action.** Explicitly classify object-value entries as **scope openers (no pin)**. They are excluded from version judgment but their children are judged. `--report` must list them as `scope (no pin)`. Route `pin === null`, empty object, or array to `PIN_SHAPE_UNRECOGNISED`. Ensure the exclusion is tied to the scope actually yielding children, not just `typeof`.
*(Flagged by: Functionality, Security)*

### F4 — Severity: Major — Withdrawn advisories and `first_patched_version: null` create an unremediable permanent red
**Problem.** C3 fires on every advisory and forbids suppression lists or severity filters. The API returns **6 withdrawn advisories** and **13 `first_patched_version: null` entries** across the 18 overridden packages. Two are on live overridden packages (`lodash`, `effect`). Neither intersects current pins today, but the mechanism is unguarded. A null patch means no floor to raise; a withdrawn advisory is not a live band.
**Impact.** An intersecting withdrawn or unpatched advisory produces a violation with **no floor to raise**. Consumer 1's contract requiring a "required floor" becomes unsatisfiable. The gate goes permanently red on every PR with no legal remediation, wedging operations and forcing bypasses (I-5.3).
**Recommended action.** Define explicit handling in C3: skip withdrawn advisories; for `null` patches, output `NO_PATCH_AVAILABLE` and route to a dated, keyed exemption file (e.g., `override-floor-exempt.txt`) with a staleness check. Route absent/missing fields to `ADVISORY_SHAPE_UNRECOGNISED`. Preserve the no-severity-filter property by keying exemptions to specific GHSA IDs.
*(Flagged by: Functionality, Security)*

### F5 — Severity: Major — Synchronous core cannot be wired to async fetcher; package list is discoverable only inside the core
**Problem.** C3 locks `findStaleFloors` as synchronous with a sync callback, but `fetchAdvisories` is async. `main()` is `void`. The set of packages to fetch is only known after walking manifests inside `findStaleFloors`. There is no exported enumeration step to decouple discovery from I/O, creating an unresolvable circularity.
**Impact.** Phase 2 must invent an unnamed contract, guaranteeing a deviation in the most load-bearing file. It breaks I-3.3 ("`findStaleFloors` performs no I/O") and C4's testing strategy.
**Recommended action.** Export `collectOverridePins(manifests) -> Array<{manifest, scopePath, name, key, pin}>`. Have `main` await `fetchAdvisories` for distinct names into a `Map`, then pass the `Map` to a still-synchronous `findStaleFloors`. Route missing keys in the map to `QUERY_FAILED`, not `[]`. Preserve I-3.3 and N2 by keeping the async boundary in `main`.
*(Flagged by: Functionality, Security)*

### F6 — Severity: Major — Truncation, query failure, and `--report` are declared but unreachable from the locked shapes
**Problem.** `advisoriesFor` returns only an array, with no field for `Link: rel="next"` truncation or query errors. `--report` is required by Consumer 4/AC-3.4 to list every entry but `findStaleFloors` returns `string[]` of violations only. Exit code semantics for `--report` are undefined, risking operator pipe-swallowing (`|| true`) or exit-code masking in workflows.
**Impact.** Three declared behaviors ship with cases that cannot be implemented as specified. An implementer will add unnamed exports or silently convert runbook instructions into pass/fail-only outputs. Truncation/query failures become silent greens.
**Recommended action.** Change the core return type to structured rows `{manifest, scopePath, key, name, pin, status: "clean"|"stale"|"undecidable", advisories, requiredFloor}`. Add an explicit failure representation to `advisoriesFor` (`{ok: false, reason}`). Specify `--report` exits 1 on non-empty members, 0 on clean. Add a forbidden pattern in C5 for `--report` in workflows, and provide `--print` if exit-0 listing is ever needed.
*(Flagged by: Functionality, Security)*

### F7 — Severity: Major — C2's `collectScopes` `pin` export ships with no test; AC-2.1 is green regardless of correctness
**Problem.** C2 adds a `pin` field to `byPackage` entries. The 25 existing self-tests only check `scopePath`, `depth`, and violation arrays; none read or assert `pin`. AC-2.1 ("25 cases pass unedited") is satisfied whether the field was added, added wrongly, or not added at all. The `unparseable` routing logic is also unverified against the new field.
**Impact.** A load-bearing primitive changes with zero test coverage for its new shape, violating I-2.2 and RT6. The disjointness gate's hazard-1 check relies on this primitive's output shape.
**Recommended action.** Add additive assertions for `pin` in the existing test suite. Assert `pin` value for string pins and `{}`/object for scope openers. Mutate the push order to verify `unparseable` isolation. Do not edit the 25 existing cases (AC-2.1).
*(Flagged by: Security)*

### F8 — Severity: Major — I-3.1's "no entry is silently skipped" is falsified by `collectScopes` dropping `"."` keys
**Problem.** `collectScopes` begins its loop with `if (key === ".") continue;`. In npm, `"."` inside a nested scope is a valid version pin for the parent package itself. The existing self-test at `check-override-key-disjointness.test.mjs:116` confirms this drop is deliberate for the disjointness gate, but I-3.1 explicitly requires `$ref` and nested-scope pins to be judged. No `"."` key exists today, making this latent.
**Impact.** A future CVE response using `"."` to pin a nested parent creates an override the gate cannot see, reporting green. This replicates the exact failure shape the plan exists to close.
**Recommended action.** Surface `"."` entries in a `selfPins` array attributed to the enclosing scope's parent package name. Judge them against that package's bands. Route top-level `"."` to `DOT_KEY_AT_TOP_LEVEL` and object-valued `"."` to `DOT_KEY_NOT_A_RANGE`. Preserve the disjointness gate's deliberate exclusion of `"."` from its own overlap arithmetic.
*(Flagged by: Functionality)*

### F9 — Severity: Major — Mutation proof covers 2 of ≥8 clauses; 5 denies lack allow pairs; `<=` tie untested
**Problem.** AC-4.3 names two mutations, but the gate has ≥8 decision clauses. The named `normalizeBand` mutation is unsatisfiable: deleting it converts an intersect-violation to a throw-violation, leaving the case green. Five deny cases lack paired allow cases. Axes are never combined, and the `<=` band tie (`semver.intersects(">=8.5.23", "<= 8.5.23")` = true) is untested.
**Impact.** The regression test for trap 1 is blind. False denies on untested axes will block merges without a path to green, creating pressure to edit or disable the gate.
**Recommended action.** Redefine the comma case as an allow pair (pin above band). Add 5 allow pairs for existing denies. Combine axes (`$ref` + comma band, nested + boundary, open-ended + `<=`). Test the `<=` tie explicitly. Mutate one clause at a time on scratchpad copies. Assert content over `toHaveLength`.
*(Flagged by: Security)*

### F10 — Severity: Major — No request timeout, retry policy, or `timeout-minutes`; transient faults wedge every PR
**Problem.** Neither CI job specifies steps or `timeout-minutes`. The gate imports `semver` (a root devDependency), failing on bare checkouts. The network shell makes unretried requests to `api.github.com`. A transient 5xx or DNS failure produces the same red as a stale floor. I-5.3 forbids paths filters, so this hits every PR.
**Impact.** Jobs fail for infra reasons. A hung request runs for 6 hours. Transient failures wedge merges, violating fail-closed intent and creating operational pressure to soften the gate.
**Recommended action.** Specify `actions/checkout`, `setup-node`, `npm ci --ignore-scripts`. Add `timeout-minutes: 5`. Implement bounded retry (3x, exponential, on 5xx/transport only, never on 4xx) with `AbortSignal`. Route distinct failures to `ADVISORY_QUERY_TIMEOUT`, `ADVISORY_QUERY_FAILED`. Preserve fail-closed: unretried failures are `undecidable`, never clean.
*(Flagged by: Functionality, Security)*

### F11 — Severity: Minor — Actionlint missing, no local discovery path, and severity terminology mismatches
**Problem.** AC-5.2 names `actionlint`, which does not exist in the repo. C5's `continue-on-error` prohibition has no enforcing check (`runsVerifier` excludes the new workflow). There is no local discovery path; developers only learn of stale floors from CI. The derivation table uses `npm audit`'s "moderate" instead of the API's "medium", and omits `GHSA-r28c-9q8g-f849` (high) for postcss members.
**Impact.** AC-5.2 passes by omission. A later PR can mask the gate's exit. Developers lack immediate feedback. The narrative understates exposure, risking misjudged merge urgency.
**Recommended action.** Replace AC-5.2 with existing checks (`check-actions-sha-pinned.sh`, `check-workflow-supply-chain.mjs`) and add an explicit `continue-on-error` check for the new job. Add an opt-in `pre-pr` step gated on a token probe that prints a skip message or reds with a stale floor. Regenerate the census from `--report`, list all intersecting GHSA IDs, and update all prose/fixtures to use `low|medium|high|critical`.
*(Flagged by: Functionality, Security)*

### F12 — Severity: Minor — `resolveRefPin` is specified to throw where the plan requires a violation
**Problem.** C3's signature says `resolveRefPin` throws if a `$ref` is absent. I-3.1/N5/C4 require a recorded violation. A throw crashes `main`, aborting all subsequent manifest judgments. Consumer 1 cannot assert on returned strings because execution halts.
**Impact.** One bad `$ref` prevents the rest of the tree from being checked, shrinking the report and violating I-3.1's enumeration guarantee.
**Recommended action.** Change return type to `{ok: true, range} | {ok: false, reason}`. Let `findStaleFloors` convert failures to violation rows. Route duplicate `$ref` resolutions to `PIN_RESOLUTION_TIE`. Preserve that judging continues across all manifests after one failure.
*(Flagged by: Functionality)*

---

## Recurring Issue Check

Preserved verbatim from each expert. Not deduplicated — these are the evidence that each check was performed.

### Functionality expert

- R1: OK — C2's reuse of `collectScopes` is genuinely possible. I read the real function: the additive `pin` field on `byPackage` entries is transparent to `findOverlappingKeys` (destructures `{key, range}`) and `findAmbiguousEdges` (reads `.range`), and no test in the 25 does a deep-equal on a `byPackage` entry (only on `scopePath`, `depth`, and violation arrays), so AC-2.1 holds. Follow-on gaps in what the primitive *drops* are F2 and F7, not reimplementation.
- R2: OK — no constant is duplicated; the `BE_VER` ↔ override coupling stays single-sourced and the plan correctly identifies that `check-dockerfile-prisma-pin.sh:68` reads only `/^brace-expansion@>=3/`, which M4/M5 do not touch (verified against the script).
- R3: Finding — F1 (two override entries in `extension/package.json` never examined) and F8 (the postcss members' advisory sets). Otherwise complete: the new gate and workflow are auto-covered by `check-actions-sha-pinned.sh`, `check-workflow-supply-chain.mjs`, `check-gate-selftest-coverage.sh`, `check-doc-paths.mjs` (scans `docs/**/*.md`, so C6's file is in range) and CODEOWNERS' `/scripts/checks/**` glob — no registration lists to update.
- R4: N/A — no event or notification dispatch in this change.
- R5: N/A — no database transactions.
- R6: N/A — no cascade deletes.
- R7: N/A — no E2E selectors touched.
- R8: N/A — no UI.
- R9: N/A — no fire-and-forget work.
- R10: OK — C3 importing from `check-override-key-disjointness.mjs` is a one-way edge; the disjointness gate imports nothing from C3.
- R11: N/A — no display/subscription grouping.
- R12: N/A — no enum or action group.
- R13: N/A — no re-entrant dispatch.
- R14: N/A — no DB roles or grants.
- R15: N/A — no migrations.
- R16: Finding — F12 (`timeout` prescribed in AC-4.3, absent on the macOS host VE-4 designates) and F11 (the gate's `semver` devDependency makes it run locally but not from a bare CI checkout — the classic parity gap).
- R17: OK — the two helper-adoption surfaces (`collectScopes`, `semver.intersects`) are both correctly routed through the shared primitive by N3/N4.
- R18: OK — no allowlist or safelist needs a new entry; `gate-selftest-debt.txt` deliberately gains none (AC-4.2).
- R19: OK — C2's change is additive, so no existing mock or fixture needs updating; AC-2.1 pins that with "no test-file edit".
- R20: N/A — no mechanical multi-statement edit.
- R21: Finding (contributing to F1) — the member set came from an uncommitted scratchpad script whose output was not re-verified by the committed gate; I re-derived it independently and the six members reproduce, but the entry and package counts do not.
- R22: OK — the plan does not invert perspective on `check-override-key-disjointness.mjs`; it correctly treats it as the established primitive.
- R23: N/A — no UI input.
- R24: N/A — no migration.
- R25: N/A — no persist/hydrate pair.
- R26: N/A — no disabled UI state.
- R27: N/A — no user-facing numeric range.
- R28: N/A — no toggle labels.
- R29: Finding — F1 ("23 entries" → 24/25; "15 distinct packages" → 18), F8 (incomplete advisory attribution; `severity` is `"medium"` not `"moderate"` in the API's vocabulary). Verified-correct claims: "35 advisories for undici" (exactly 35), "7 advisories for brace-expansion" (exactly 7), full-scope root `npm audit` = `{"moderate":1}` with `hono` the sole finding, cli and extension full-scope both 0, and all six lock-resolved versions (hono 4.12.31, @hono/node-server 2.0.11, root postcss 8.5.25, brace-expansion 1.1.18 / 2.1.4, cli postcss 8.5.23).
- R30: OK — no autolink footguns in the cited paths.
- R31: N/A — no destructive operation.
- R32: N/A — no long-running runtime artifact; the scheduled workflow is a cron sweep, and AC-5.3 requires an observed dispatch run.
- R33: OK — I enumerated all seven workflow files. Only `ci.yml` carries PR-triggered gate jobs; `ci-integration.yml`, `codeql.yml`, `dependency-signatures.yml`, `refactor-phase-verify.yml`, `release.yml`, `tls-fixture-expiry.yml` have no duplicate structure this job must be added to. `ci.yml` has a single `concurrency` group at workflow level (inherited), no aggregator/"all checks passed" job, and its `changes` path filter is opt-in via `needs: changes` — so I-5.3's no-filter decision is implementable without touching the `changes` job. No in-repo required-check list exists.
- R34: OK — no adjacent pre-existing bug is deferred; SC-A through SC-D each carry a reason and an owner.
- R35: OK — AC-5.3 requires an observed `gh workflow run`, not an inference from well-formed YAML.
- R36: OK — the plan forbids severity filters and suppression lists (C3 forbidden patterns, AC-3.4). F4 notes that closing every escape hatch without a no-fix path creates a wedge, which is a gap in the *exit*, not a suppression.
- R37: N/A — no user-facing strings.
- R38: Finding (F4) — a persisted fail-closed wedge with no reset path: a withdrawn or unpatched advisory intersecting a live pin reds every PR with no legal remediation.
- R39: N/A — no secret or key material.
- R40: Finding (F3, F6) — cross-boundary shape defects: `advisoriesFor`'s `bands` carries no package identity (F3), and carries neither a truncation nor an error channel (F6).
- R41: Finding (F6) — `--report` is declared and cited by three consumers with no backing path in the locked signature.
- R42: Finding (F1) — I recomputed the class over every tracked manifest including nested scopes, `$ref` pins, the `"."` form and `lastIndexOf('@')` scoped-name splitting. The six-member set is correct; the surface walked to produce it was not.
- R43: N/A — no security boundary widened.
- R44: OK — both jobs read the gate's exit status directly, and C5 forbids `continue-on-error: true`. F9 notes that this particular forbidden pattern has no gate behind it (`check-workflow-supply-chain.mjs`'s rule applies only to verifier-running workflows), which is a coverage note rather than a masked exit.
- R45: OK, measured — 18 sequential requests, 6.8 s wall clock, 840 KB. Linear in the override set, not super-linear; no timeout risk. (C5 sets no `timeout-minutes`, noted in F14's remedy.)
- R46: N/A — no binding resolution in a security analyzer.
- R47: Finding (F13) — the two version-window regexes adjudicate a surface form far narrower than the reasons attached to them; the real adjudicator is `semver.intersects` in C3, which is the correct delegation.
- R48: Finding (F3) — the network shell and the pure core would decide "is this band about this package" by different (and in the shell's case, unstated) semantics.
- R49: Finding (F7) — I-3.1's "no entry is silently skipped" is falsified by `collectScopes`'s `"."` skip, which the existing self-test at line 116 pins as deliberate. Honest declarations elsewhere: C1's "not a control — a data correction", C3's "not an enforceable boundary", C5's "the schedule half is detection".
- R50: Finding — F9 (AC-5.2 names a nonexistent linter), F1 (AC-3.4's count is unproducible by a correct implementation), F6 (three C4 cases cannot be written against the locked shape). AC-1.2's post-state was checkable and I verified it is reachable: cli and extension full-scope audits are already 0, and root is 1 (hono) which C1 clears.
- R51: N/A — no name-vs-object re-resolution.
- R52: OK — C2 widens `collectScopes`'s output additively and AC-2.1 re-audits the primitive by requiring the 25 existing cases green with no edit.
- R53: OK on the headroom method, Finding on its input (F1) — the gate lands with 0 members and no suppressions, which I independently confirmed by simulating C1's six edits and re-intersecting every pin (post-C1 members = 0). The entry count that AC-3.4 measures against is wrong.
- R54: N/A — no ambient suspension context.
- R55: Finding (F4, F6) — `first_patched_version: null` is an in-band sentinel that collides with a legitimate domain value ("no fix exists"), and an empty `bands` array collides with both "no advisories" and "fetch returned nothing".
- R56: N/A — no progress marker.
- R57: OK — pagination is refused rather than cursor-walked (I-3.5), and I confirmed the API omits `Link` entirely when the result fits at `per_page=100` for all 18 packages, so the fail-closed form is silent-when-healthy for real rather than by assumption.

### Security expert

| Rule | Status |
|---|---|
| R1 Shared utility reimplementation | OK — N4/C2 mandate reuse of `collectScopes`; forbidden pattern on a second walker is present. |
| R2 Constants hardcoded in multiple places | OK — floors live only in the manifests; `BE_VER` coupling is asserted by `check-dockerfile-prisma-pin.sh` (verified, reads `/^brace-expansion@>=3/` at line 68). |
| R3 Incomplete pattern propagation | **F1, F2** — pin forms (`"."`, nested) not propagated to the new control. |
| R4 Event/notification dispatch gaps | n/a. |
| R5 Missing transaction wrapping | n/a. |
| R6 Cascade delete orphans | n/a. |
| R7 E2E selector breakage | n/a. |
| R8 UI pattern inconsistency | n/a. |
| R9 Transaction boundary for fire-and-forget | n/a. |
| R10 Circular module dependency | OK — C3 imports C2's exports one way. |
| R11 Display group ≠ subscription group | n/a. |
| R12 Enum/action group coverage gap | OK — no severity filter (C3 forbidden pattern verified against the moderate M1 case). |
| R13 Re-entrant dispatch loop | n/a. |
| R14 DB role grant completeness | n/a. |
| R15 Hardcoded env values in migrations | n/a. |
| R16 Dev/CI environment parity | OK — VE-1 states pre-pr does not cover the gate, in three places. |
| R17 Helper adoption coverage | OK. |
| R18 Config allowlist synchronization | **F6** — the forbidden-pattern list for C5 is not synchronized with the weakening forms the plan itself introduces (`--report`). |
| R19 Test mock alignment | OK — AC-2.1 requires the 25 existing cases green unedited. |
| R20 Multi-statement preservation | n/a. |
| R21 Subagent completion vs verification | n/a. |
| R22 Perspective inversion for established helpers | **F8** — the established helper's object-valued entry is inherited without stating its meaning in the new consumer. |
| R23 Mid-stroke input mutation | n/a. |
| R24 Migration mixing additive + strict | n/a. |
| R25 Persist/hydrate symmetry | n/a. |
| R26 Disabled-state UI without cue | n/a. |
| R27 Numeric range in user strings | n/a. |
| R28 Toggle label grammar | n/a. |
| R29 Citation / derived-claim accuracy | **F5** — omitted HIGH advisory on both postcss pins; "15 distinct packages" is 17; 21/23/24 inconsistency. GHSA ids and bands that *are* cited verified correct against the live API; the `npm audit --omit=dev --audit-level=high` claim verified at `.github/workflows/ci.yml`; full-scope root `npm audit` verified `{"moderate":1,"high":0,"critical":0}`, sole finding `hono`. |
| R30 Markdown autolink footguns | OK. |
| R31 Destructive ops without confirmation | OK — `npm install --package-lock-only` in three trees rewrites tracked lockfiles only; no `rm -rf node_modules`; AC-1.3 requires an unexpected diff to be explained before merge. |
| R32 Runtime artifact without boot smoke test | OK — AC-5.3 requires an observed `gh workflow run`. |
| R33 CI change applied to one config not its duplicates | OK — both the weekly workflow and the PR job are specified; `dependency-signatures.yml` is the cited precedent and matches. |
| R34 Pre-existing bug deferred without cost | **F4** (open-ended pins pre-exist and are carried forward uncosted). |
| R35 Production component without manual test plan | OK — VE-1/VE-4 give the manual paths. |
| R36 Suppression / markerless weakening | **F3, F6** — `--report`, `\|\| true`, pipe-swallowed status, and an input-driven permanent green are all unforbidden; only `continue-on-error` and a severity filter are. |
| R37 Internal jargon in user strings | n/a. |
| R38 State machine fail-open | n/a. |
| R39 Secret zeroization | n/a. |
| R40 Serialization shape vs strict consumer | **F3** — no schema validation of the advisory document. |
| R41 Declared capability without backing path | **F8** — I-3.1's "no entry silently skipped" has no backing path for object pins. |
| R42 Class-membership derivation | **F1, F2** — `"."` form and the nested pin were never examined; AC-3.4's count codifies the omission. Independently re-derived: 24 pins + 1 scope opener. |
| R43 Fix-induced boundary widening | OK — checked: `hono@4.12.34` and `4.13.0` and `@hono/node-server@2.1.0` all carry `dist.signatures` **and** SLSA provenance attestations, single unchanged maintainer `yusukebe`; no raised floor crosses a major; `npm audit signatures` runs in all three audit jobs and in the weekly sweep. Related unbounded-pin widening reported as **F4**. |
| R44 Gate exit status through a lossy channel | **F6**. |
| R45 Gate scaling super-linearly | OK — 17 requests, bounded; VE-3 budget under-counted (folded into F5). |
| R46 Scope-blind binding resolution | **F1** — `"."` is resolved by position, not by the scope's parent binding. |
| R47 Surface-form adjudication | Assessed and largely OK: `semver.intersects` is the authoritative interpreter (N3), and the normalizer was executed against the spellings that matter — `>= 1.0.0-beta, < 2.0.0` → false (correct), `= 1.2.3` / `=1.2.3` / `" = 1.2.3 "` all → `validRange "1.2.3"` (correct), `*` and `>= 0` → `*` → intersects true (fail-closed), `null`/`undefined` → throws (fail-closed), and **`""` → `validRange "*"` → intersects true**, i.e. an empty band reds rather than passing. Boundary `^4.12.34` vs `< 4.12.34` → false, `<= 4.12.34` → true, both correct. No fail-open spelling found. Residual surface-form risk is in the fields *around* the band (**F7**). |
| R48 Parallel adjudicators | Assessed: `npm audit`, Trivy, Dependabot and this gate answer overlapping questions. The plan names the divergence correctly. One gap: cross-package band bleed. Measured — 11 advisories returned for `lodash`/`nodemailer` carry bands for `lodash-es`, `lodash-amd`, `lodash.template`, `lodash.unset`, `rubygems:lodash-rails`, `maven:org.webjars.npm:nodemailer`. None intersects today's pins, but C3's normalized `advisoriesFor` shape **drops the per-vulnerability package name**, making the filter impossible downstream. Specify that the network shell filters `vulnerabilities[].package.ecosystem === "npm" && .package.name === pkg` before flattening, and that `first_patched_version` is read from the **matching** entry. Folded into F3's boundary validation. |
| R49 Claim stronger than implementation | **F3** ("the gate reds rather than passing wrongly" on a response-shape change — no mechanism), **F8**. Control classes are otherwise declared correctly and unusually well. |
| R50 Verification preconditions unverified | OK — AC-5.3 requires an observed run; VE-5 corrects the Trivy misconception by measurement. |
| R51 Decision bound to a name not the object | **F8** — the scope-opener decision is bound to `typeof`, not to whether the scope yielded pins. |
| R52 Control reach extended without re-auditing the control | **F1** — C2 widens `collectScopes` and the audit of the primitive itself surfaced the `"."` skip, which was harmless for the disjointness gate but is fail-open for C3. `discoverManifests` audited separately: `git ls-files 'package.json' '*/package.json'` **does** match nested paths (verified in a throwaway repo), so its comment is accurate; not a finding. |
| R53 Threshold without headroom measurement | Partially OK — no threshold and no suppression list, which is the right shape; but the headroom is measured over the under-counted set (**F2**) and is structurally unstable for the open-ended pins (**F4**). |
| R54 Control suspension via ambient context | **F3** — proxy / `GITHUB_API_URL` / CA env is exactly ambient-context suspension of this control. |
| R55 In-band sentinel | **F4** — `first_patched_version: null` (13 of 263 vulnerability entries measured) is both "no patch exists" and the plan's "required floor" field. Related: `[]` as both "no advisories" and "green" (**F3**). |
| R56 Progress-marker heal direction | n/a. |
| R57 Ordering key without total order | n/a. |
| RS1 Timing-safe comparison | n/a — no credential comparison. |
| RS2 Rate limiter on new routes | n/a — no new route; API-side rate limit handled by AC-3.3 (403 only; other codes folded into F3 clause 3). |
| RS3 Input validation at boundaries | **F7**, and the schema-validation half of **F3**. |
| RS4 PII in committed artifacts | OK — no emails or personal data in the plan or the proposed artifacts. |
| RS5 Untrusted external security parameter without floor/whitelist | **F3**. |
| RS6 Escape-character ordering | OK — the only transform is `/,\s*/g → " "`, single-pass, no escape sequences, and its failure direction was executed (empty/`*`/null all fail closed). |

### Testing expert

| Rule | Status |
|---|---|
| R1 Shared utility reimplementation | OK — N4 + C2's forbidden `function collectScopes` pattern reuse the disjointness walker rather than copying it. |
| R2 Constants hardcoded in multiple places | Fires — "23 entries" (AC-3.4) and "15 distinct packages" (VE-3) are hardcoded derived counts, both wrong; see F2. |
| R3 Incomplete pattern propagation | OK — C1 covers all six members across all three manifests; AC-1.3 regenerates all three lockfiles. |
| R4 Event/notification dispatch gaps | N/A — no event dispatch in scope. |
| R5 Missing transaction wrapping | N/A — no DB writes. |
| R6 Cascade delete orphans | N/A. |
| R7 E2E selector breakage | N/A — no UI surface. |
| R8 UI pattern inconsistency | N/A. |
| R9 Transaction boundary for fire-and-forget | N/A. |
| R10 Circular module dependency | OK — C3 imports C2 one-way; no back-edge. |
| R11 Display group ≠ subscription group | N/A. |
| R12 Enum/action group coverage gap | Fires (minor) — the API severity enum is `low/medium/high/critical`, not npm's `moderate`; see F13. |
| R13 Re-entrant dispatch loop | N/A. |
| R14 DB role grant completeness | N/A. |
| R15 Hardcoded env-specific values in migrations | N/A. |
| R16 Dev/CI environment parity | Fires — gate is CI-only with no local discovery path; see F12. |
| R17 Helper adoption coverage | OK — C3 is the only new consumer of the extended primitive. |
| R18 Config allowlist/safelist sync | Fires (minor) — no exemption file exists for an unfixable advisory; see F8 clause 3. |
| R19 Test mock alignment with helper additions | Fires — `collectScopes` gains `pin` with no test asserting it; see F7. |
| R20 Multi-statement preservation in mechanical edits | N/A. |
| R21 Subagent completion vs verification | N/A — no subagent work in this plan. |
| R22 Perspective inversion for established helpers | OK — the plan reuses `semver.intersects` rather than re-deriving intervals (N3). |
| R23 Mid-stroke input mutation | N/A. |
| R24 Migration mixing additive + strict constraint | N/A. |
| R25 Persist/hydrate symmetry | N/A. |
| R26 Disabled-state UI without cue | N/A. |
| R27 Numeric range hardcoded in user-facing strings | N/A. |
| R28 Toggle/switch label grammar | N/A. |
| R29 Citation / derived-claim accuracy | Fires — the "23 entries", "15 packages", and "(moderate)" claims are all contradicted by measurement; see F2, F13. AC-6.2 correctly requires every documented command be run. |
| R30 Markdown autolink footguns | OK. |
| R31 Destructive ops without confirmation | Fires (minor) — AC-3.2 mutates tracked manifests with no cleanup on the failure path; see F6. |
| R32 Long-running runtime artifact without boot smoke test | Fires — no test ever executes the gate as a process; see F3. |
| R33 CI config change applied to one config not its duplicates | OK — C5 wires both the PR job and the scheduled workflow; I-5.3 correctly refuses a paths filter. |
| R34 Pre-existing bug deferred without cost-justification | OK — SC-A/B/C/D each name an owner or a reason. |
| R35 Production component without manual test plan | N/A — no admin IA change. |
| R36 Suppression as substitute for fix | Watch — the plan's "zero suppressions" posture is correct, but F8's unfixable-red state creates the pressure that produces one. |
| R37 Internal jargon in user-facing strings | OK — violation strings name package, GHSA id, floor. |
| R38 Non-terminal state / fail-open supersession | Fires — a null-patched advisory is a state with no exit; see F8. |
| R39 Lifecycle secret zeroization | N/A. |
| R40 Cross-boundary serialization shape vs strict consumer | Fires (Critical) — the stub shape is not the API shape; see F1. |
| R41 Declared capability without a working backing path | Fires — C4 cases 10 and 11 cannot be written against the declared `advisoriesFor` signature; see F3. |
| R42 Class-membership derivation | Partially fires — the member-set primitive is stated well, but M1–M6 come from the retired scratchpad and are never re-derived by the gate; see F2 (AC-3.0). |
| R43 Fix-induced security-boundary widening | OK — floors move up only; no key added (I-1.2), verified by AC-1.5. |
| R44 Gate exit status read through a lossy channel | Fires (minor) — the `continue-on-error` prohibition has no enforcing check; see F10. |
| R45 Gate scaling super-linearly | OK on cost (measured: 18 sequential requests ≈ 8.8s), fires on bounding — no request timeout or `timeout-minutes`; see F9. |
| R46 Scope-blind binding resolution | OK — nested scopes are walked with explicit `depth`, inherited from the sibling gate. |
| R47 Surface-form adjudication where an interpreter defines meaning | OK — `semver.intersects` is the adjudicator; band strings normalized for separator syntax only. |
| R48 Parallel adjudicators deciding one predicate | Fires — the retired scratchpad script and the gate are two implementations of one predicate; closed only by adding AC-3.0 (see F2). |
| R49 Claim stronger than the implementation | OK — the plan is explicit that only M1 is a live exposure and that the gate is not an enforceable boundary. |
| R50 Verification preconditions unverified | Fires — AC-2.1 (F7), AC-3.4 (F2), AC-5.2 (F11) are each green regardless of whether the work happened. |
| R51 Decision bound to a name, not the object | Fires — the advisory band is bound to the queried package name by an untested filter; see F1. |
| R52 Control reach extended without re-auditing the control | OK — AC-1.5 re-runs the disjointness gate rather than assuming it. |
| R53 Numeric threshold without headroom measurement | Fires — AC-3.4's "0 members" is real, but the "23 entries" it is measured against is asserted from a buggy instrument; see F2. |
| R54 Control suspension through ambient context | OK — no ambient bypass; token presence changes rate limit only, not the verdict. |
| R55 In-band sentinel colliding with a legitimate value | Fires — `first_patched_version: null` is an in-band sentinel with no defined handling; see F8. |
| R56 Progress-marker heal direction | N/A. |
| R57 Ordering/cursor key without total order | Watch — `per_page=100` with no `sort`/`direction` given; if GitHub's default ordering changes, the fail-closed truncation check still holds, so no finding. |
| RT1 Mock-reality divergence | **Fires (Critical)** — F1. Verified against the live API. |
| RT2 Testability verification | Satisfied — every finding names an executable test or command; F3 and F6 exist because the plan's own cases are *not* executable. |
| RT3 Shared constant in tests | Fires — AC-3.4's "23" is a hardcoded derived count used as a pass criterion; see F2 clause 1 (derive it in the test). |
| RT4 (not in scope index) | N/A. |
| RT5 Test call-path includes production primitive | **Fires (Major)** — `fetchAdvisories`, `main()`, and `--report` are reachable only in production; F1, F3. |
| RT6 New exports without test diff | Fires — C2's `pin` (F7) and C3's four exports, of which `resolveRefPin` gets 2 cases and `normalizeBand` 1 with the wrong polarity (F4). |
| RT7 Guard proven able to fail | **Fires (Major)** — AC-4.3 covers 2 of ≥8 clauses and its `normalizeBand` mutation is unsatisfiable as written; AC-3.2 is not executable; F4, F6. |
| RT8 Vacuous denial-path test | Partially satisfied — C3's Consumer-1 walkthrough correctly demands content over length, but the rule is stated in C3 and not restated in C4's invariants, and "required floor" is unsatisfiable for null-patched advisories; F5 clause 3, F8. |
| RT10 Guard tested only on deny side | **Fires (Major)** — five deny cases unpaired, axes never combined, `<=` band tie untested; F5. |
| RT9 Parallel-implementation twin drift | Fires — the scratchpad derivation is retired in favour of the gate (good), but its output is never re-derived by the replacement; closed by AC-3.0 in F2. |
| RT11 Fixture outlives its run | Fires (minor) — C4 uses in-memory objects so no filesystem escape, but AC-3.2 mutates tracked manifests with no cleanup on the abort path; F6 clause 3. Verified the house pattern is `mkdtempSync(tmpdir())` + `afterEach rmSync`. |

## Quality Warnings
No findings failed the quality gates. All merged findings contain concrete file paths, line references, API query results, or specific execution commands. No vague language (`"consider improving"` without a fix), missing evidence, or unverified testability claims were retained in the final synthesis.


---

# Round 2

## Changes from Previous Round

The plan was rewritten as revision 2: the member-set derivation corrected (25 walker
entries / 24 pins / 18 package names, replacing 23/15), the gate's shape restructured
so the API-to-internal transform became a pure export, eight previously-undecided
semantic cases locked as S1-S8, contract C7 added to give C5's `continue-on-error`
prohibition an enforcing mechanism, and the test surface specified as 18 deny/allow
pairs plus a 13-row mutation table.

## Result

33 findings: 1 Critical, 21 Major, 11 Minor. **None against the design.** Roughly two
thirds were against revision 2's own mechanism specifications — a mutation row naming
the side of a case it cannot red, an acceptance criterion contradicting a hardening
clause, deny/allow columns transposed, cases unwritable against the signature block.

| Cluster | Experts | Status in revision 3 |
|---|---|---|
| C7 widens one of three predicates; four of C5's five weakening forms stay unenforced (executed proof) | Func / Sec / Test | Fixed — C7 restated as a member set (`runsVerifier` + `verifierLineRe` + `maskRe`), with `release.yml:315`'s legitimate pipe as the allow case deciding the pipe rule's shape |
| The host pin makes AC-3.3's local fixture server unreachable; every cheap fix is an env-var test mode | Sec / Test (Critical) | Fixed — S11 makes endpoint and canary **parameters**, not env vars, and forbids `process.env` in the gate outside the token read |
| `"."` self-pin attributed by parsing `scopePath` backwards; a selector-bearing scope key mis-attributes and the API answers `200 []` | Func / Sec | Fixed — S2/I-2.4 carry `parentName` on the scope record |
| S1's `EMPTY_SCOPE` collides with S2's self-pin; `{"pkg": []}` yields two rows | Func / Test | Fixed — S1 counts `selfPins` as children; arrays are not recursed into |
| The `unparseable` bucket has no `pin`, no `kind`, no consumer | Func / Test | Fixed — S9 |
| The row shape cannot carry S4's withdrawn count or separate a refusal from a query failure | Func / Sec / Test | Fixed — S10's four-way status; `extractBands` returns `skipped` counts |
| A single-package canary is not a positive control over 18 queries; the API returns `200 []` for an unknown or malformed `affects` | Sec | Fixed — S12's three layers, with the residual stated plainly (SC-G) |
| The pre-pr step's natural spelling collides with `check-gate-selftest-coverage.sh` and AC-4.2 | Func / Sec / Test | Fixed — I-5.7 names the member set the step must belong to |
| AC-3.4's derived count compares `collectOverridePins` to itself | Func | Fixed — a second instrument |
| AC-3.0 omits AC-3.2's scratchpad-copy wording | Func / Test | Fixed |
| Census figures 306 and 7 do not reproduce | Func / Sec | Fixed — re-measured **223** and **6** |
| The whole acceptance suite needs a token, not just AC-3.2 | Test | Fixed — VE-3 |
| AC-5.2's justification about `pre-pr` having no workflow-lint step | Func | Fixed — `pre-pr.sh:303` does queue it; the `actionlint`-absent half was the true half |

## Orchestrator re-measurement

The 306/7 discrepancy was re-run before being accepted: one query per distinct
package name over the 18 names yields **158 advisories, 6 withdrawn, 223 live
same-package vulnerability entries, 0 with a null patch, 0 live unreviewed**.
Revision 2's script iterated the 24 pins, so `postcss`, `esbuild`,
`brace-expansion`, `js-yaml` and `rollup` were counted once per pin. The
conclusions built on the figure (SC-E's likelihood argument) are unaffected.

## Disposition

Revision 3 resolves every Critical and Major above and applies the plan-granularity
rule: the 18-case table and the 13-row mutation table are replaced by obligations
O-1 through O-9, with the cases authored and the mutation loop **run** in Phase 2 and
reviewed in Phase 3. Recorded as a decision, not an omission.


### Functionality expert — round 2

# Plan Review (Round 2): stale-override-floors — Functionality

## Reproduction performed

Reproduces exactly: 25 walker entries / 24 pins / 1 scope opener / 18 names; M1–M6
with floors, GHSA ids, severities and bands (incl. `GHSA-r28c-9q8g-f849` [high] on
both postcss pins); the 18 non-member pins; 0 null-patch and 0 live unreviewed;
hono 44 / undici 35 and no `Link` header at `per_page=100`; the six lock-resolved
versions; `check-dockerfile-prisma-pin.sh:68`; the disjointness self-test's 25 cases
and its `"."` case at line 116; the argv form at `check-override-key-disjointness.mjs:260`;
`runsVerifier` at `check-workflow-supply-chain.mjs:101-104`; `ci.yml:687/716/743`;
`vitest.config.ts:11` and the src-only `coverage.include`; `actionlint` absent.

Does NOT reproduce: **withdrawn = 7** (measured 6) and **306 live vulnerability
entries** (measured 223; no variant yields 306 — 257 all-bands-live, 249
npm-bands-live, 263 all-bands-incl-withdrawn).

## Findings

### F1 — Major — DESIGN — `collectOverridePins`'s `kind` enum is not exhaustive: the `unparseable` bucket has no kind, no `pin`, and no consumer

`collectScopes` produces three buckets. `check-override-key-disjointness.mjs:104-107`
routes any key whose *selector* `semver` cannot parse into `unparseable` and
`continue`s — it never reaches `byPackage`. C2 leaves `unparseable` unchanged (no
`pin`), C3's `kind` enum has no member for it, and Consumer-3 never mentions it. So
`{"postcss@latest": ">=8.5.12"}` — a real, judgeable pin on a real vulnerable
package — is dropped before `collectOverridePins` can yield it. I-3.1's "no entry is
silently skipped" is a claim stronger than the declared shape supports (R49).
`findOverlappingKeys` already reds on `unparseable`, so this is defence-in-depth
today rather than a live hole — Major, not Critical — and becomes live the moment
anyone relaxes that rule.

**Recommended action.** Add `pin` to `unparseable` entries and a
`kind: "UNPARSEABLE_SELECTOR"` member judged as a violation. Allow: `{"pkg@1":
"^1.2.3"}` keeps landing in `byPackage` as `kind: "pin"`. Red-prove separately:
delete the `unparseable` branch → the new deny reds; delete the `pin` field → the
same case fails with a missing-pin refusal, not a pass. Do not route unparseable
selectors into `byPackage`. Boundary: "selector parseable" and "pin parseable" are
two independent predicates that one `continue` conflates.

### F2 — Major — DESIGN — S1's `EMPTY_SCOPE` and S2's self-pin collide, and `kind` is not a partition

(a) `{"@crxjs/vite-plugin": {".": "^2.7.1"}}` — scenario 6 minus its siblings —
yields a child scope with empty `byPackage` and one `selfPins` entry. Under S1 it is
`EMPTY_SCOPE`; under S2 it is judged. This is the only spelling npm offers when the
vulnerable package is the scope's parent and nothing else needs pinning.

(b) `collectScopes:100` tests `typeof value === "object"` and does not `continue`
after recursing, so `{"pkg": []}` produces both an empty child scope and a
`byPackage` entry with `pin: []` — one key, two rows, two kinds. The census row
"walker entries: 25" assumes entries and rows are 1:1.

**Recommended action.** A scope "yielded pins" if `byPackage.size > 0 ||
selfPins.length > 0`. Allow: `{"parent": {".": "^2.7.1"}}` → one `self-pin` row, no
`EMPTY_SCOPE`. Deny: `{"parent": {}}` → `EMPTY_SCOPE`. Red-prove separately: revert
the predicate to `byPackage.size > 0` → the self-pin-only allow reds; set it to
`true` → the `{}` deny reds. Route arrays and non-plain objects to
`PIN_NOT_A_RANGE` without recursing. Do not drop `EMPTY_SCOPE`.

### F3 — Major — DESIGN — `selfPins` has no carrier for the parent package name (R51)

`collectScopes` recurses before it pushes the parent, and the recursion receives only
`value`, the scopePath string and `depth + 1`. A nested `"."` lands on the child
record and the only link to the package it pins is the scopePath string, whose last
segment is an override **key**, not a package name. `{"pkg@1": {".": "^1.0.0"}}`
produces `overrides > pkg@1`; a tail split yields `pkg@1`; the gate queries
`affects=pkg%401`, GitHub returns `[]`, and the row is `clean` — a silent fail-open
in the exact form S2 was written to close.

Secondary: AC-2.2 does not name which returned record it inspects. The walk is
post-order, so `into[0]` is the nested scope; an assertion against `scopes[0]` passes
by accident and one against `topLevelScope(scopes)` fails.

**Recommended action.** Pass the parent key into the recursion; put `parentKey` and
`parentName` (via `splitOverrideKey`) on the child record. Deny: `{"pkg@1": {".":
"^1.0.0"}}` against a band `< 1.1.0` on `pkg` → one violation naming `pkg`. Allow:
`"." : "^1.2.0"` → `[]`, and `{"@scope/pkg@1": {".": "^1.2.0"}}` → `[]`. Red-prove:
revert to a tail split → the `pkg@1` deny greens; revert to a tail split with
`splitOverrideKey` but no scoped-name handling → the `@scope/pkg@1` allow reds. Keep
`scopePath` in the row. Tie: `{"@scope/pkg": {".": …}}`, where the key's only `@` is
at index 0.

### F4 — Major — DESIGN — C7 gives a mechanism to one of the five weakening forms

C5 lists five ways to discard the exit status and asserts "these patterns close the
rest". C7 widens exactly one predicate, `runsVerifier` (`:103-104`). The per-line
mask branch is gated on a different regex, `verifierLineRe` (`:101`), and `maskRe`
(`:106`) contains no `set +e`, no pipe and no `--report`. Executed against the real
exported function with `runsVerifier` forced true:

```
|| true   on the new gate  -> []
| tee     on the new gate  -> []
set +e    on the new gate  -> []
--report  on the new gate  -> []
continue-on-error          -> ["a verifier-running workflow sets 'continue-on-error: true' …"]
```

Baseline control: `npm audit signatures || true` in the same fixture does violate,
proving the harness is live. Two further unstated preconditions: `ci.yml` already
matches `runsVerifier` via its three `npm audit signatures` steps, so C7's widening
is load-bearing only for the new standalone workflow; and the check is whole-file
substring matching including comments, so a widening spelled
`/check-override-floor-staleness/.test(content)` marks any workflow that merely
mentions the gate in a comment as verifier-running.

**Recommended action.** Widen `verifierLineRe` alongside `runsVerifier` as one
member-set addition; extend `maskRe` with `set\s+\+e` and a trailing-pipe
alternative scoped to a verifier line. Allow: `release.yml:315-319`'s real
`npm audit signatures --json | node -e '…'` must stay `[]` — that is the tie, and it
makes the rule "`pipefail` presence", not "no pipes". Red-prove one mutation per
added alternative. Bind the match to extracted `run:` commands, not raw `content`.
Do not drop the four unenforced patterns to make the lists agree.

### F5 — Major — DESIGN — I-5.6's `pre-pr` step collides with `check-gate-selftest-coverage.sh` set (2) and AC-4.2

Set (2) greps `pre-pr.sh` for `run_step … "Static:…" bash -c` and requires a
`pre-pr:<label>` entry in `gate-selftest-debt.txt` (13 exist; the gate runs green, so
the set is live). AC-4.2 forbids adding one. I-5.6's step is an inline shell
conditional; written the house way it fires `MISSING_GATE_SELFTEST`. Every escape has
an unnamed cost: `queue_step` evades the meta-gate's anchor entirely; a new
`scripts/checks/*.sh` needs its own sibling self-test, which C4 does not specify;
moving the probe inside the `.mjs` contradicts scenario 4 and makes the CI job green
when the `env:` block is dropped. Supporting: VE-1's "offline by contract" is
unsourced — `grep -i 'offline\|network' scripts/pre-pr.sh` returns nothing.

**Recommended action.** Extract to `scripts/checks/check-override-floor-staleness-local.sh`
with the sibling self-test set (1) demands, called via the spelling set (1) covers.
Deny: a scratchpad stale manifest + token → red naming the package. Allow: both env
vars unset → exit 0 and the skip line on stdout, with the meta-gate green and the
debt file byte-identical. Red-prove: delete the `else` branch → the tokenless allow
reds on the stdout assertion; invert the probe → the deny greens; delete the sibling
self-test → the meta-gate reds.

**[Adjacent] Minor: with a token present, `pre-pr` transmits the developer's PAT to
`api.github.com` on every run and consumes 18 of their hourly budget — a
previously-local script gaining outbound authenticated egress. Overlaps Security.**

### F6 — Major — DESIGN — the result-row shape cannot carry what `--report` (S4) and I-3.5 require

(a) S4 requires withdrawn advisories be counted in `--report`, but `extractBands`
returns same-package live bands only; a withdrawn advisory yields `[]`,
indistinguishable from "no same-package band", and neither the row shape nor the map
envelope has a slot for the count. Recovering it puts the S4 predicate in two places
(R48). (b) `status` has three members while `kind` has five *structural* refusals,
so a malformed pin and an unreachable API land in the same bucket — the
in-band-sentinel shape (R55) reappearing on `status`. (c) `async function main(...)`
at module scope produces a floating promise; an unexpected throw surfaces as an
unhandled rejection with a raw stack, contrary to N5.

**Recommended action.** `extractBands` → `{bands, skipped:{withdrawn,
foreignPackage}}`; map entry → `{ok, advisories, reason, truncated}`; row →
`status: "clean" | "stale" | "refused" | "undecidable"`. Deny: one withdrawn
intersecting advisory → `[]` violations **and** report output containing
`withdrawn: 1`. Allow: a genuinely advisory-free package → `clean`, `withdrawn: 0`.
Red-prove separately: drop the counter → the withdrawn assertion reds while every
violation assertion stays green; map `refused` onto `undecidable` → a fixture with
one of each reds on "both appear distinctly"; bare `main()` call → an injected throw
must surface `GATE_INTERNAL_ERROR`, not a stack.

### F7 — Major — DESIGN — C4 cases 16-allow and 18b assert shell-only behavior

Case 16's allow side needs Link-header parsing, which lives in the unexported
`fetchAdvisories`; no pure export receives a Link header and AC-3.3's fixture list
has no Link case. The plan names the exact false-red risk and places it where neither
C4 nor AC-3.3 can execute it — a deny-only guard (RT10) on the one axis the plan
itself predicts a false red. Case 18's `ghsa_id: "../../x"` half is likewise
shell-only; its `::`-prefix half is reachable via `formatViolations`.

**Recommended action.** Export `parseLinkTruncation` and `validateAdvisoryShape`.
Deny: `rel="next"` → truncated. Allow: `rel="prev", rel="last"` → false, and `Link`
absent → false (today's real shape on all 18). Red-prove: `.includes("next")` → the
prev/last allow reds; invert `truncated` → the deny reds; delete the `ghsa_id` regex
→ 18b reds. Route an unparseable `Link` to `ADVISORY_LINK_HEADER_MALFORMED`; treat
exactly `per_page` elements with no `Link` as truncated.

### F8 — Major — DESIGN — AC-3.4's derived count compares `collectOverridePins` to itself and cannot fail

If both sides are produced by `collectOverridePins`, the assertion is `n === n` and
deleting it leaves the test green. The very bug F1 found would satisfy it, because
both sides would report 23. Second clause: AC-3.4 requires a network `--report` run
"at the branch tip" while I-4.1/N2 forbid the network in the self-test; the criterion
straddles a manual step and a unit test without saying which half is which.

**Recommended action.** Derive the expected count from a **second instrument** — a
short hand-rolled manifest recursion in the test sharing no code with
`collectScopes` — and assert `formatReport` emits exactly that many entry lines.
Deny: a fixture with a known 4 entries where the gate emits 3 → red. Allow: the three
real manifests → 25 lines, 0 members. Red-prove: delete the nested-scope recursion →
the count assertion must red (today it would not); delete the `$ref` branch → same;
`formatReport` filtering to violations only → same. Keep the "0 members" clause.

### F9 — Minor — PROSE — R29: two census numbers do not reproduce and two figures contradict each other

`withdrawn = 7` → measured **6** (`effect/GHSA-6hr9-4692-fch9`,
`esbuild/GHSA-gv7w-rqvm-qjhr`, `lodash/GHSA-8p5q-j9m2-g8wr`,
`nodemailer/GHSA-46j5-6fg5-4gv3`, `nodemailer/GHSA-jj37-3377-m6vv`,
`qs/GHSA-crvj-3gj9-gm2p`). `306` → measured **223**. The single cited command
(`--report`) cannot produce four of the eight rows. VE-3 says ~108 requests while
AC-3.2 says eight reverts (144). AC-5.2's justification is wrong about the repo:
`scripts/pre-pr.sh:303` queues `Static: workflow-supply-chain`, the very check
revision 2 adopts; the `actionlint`-absent half is correct. Everything else
reproduces exactly.

### F10 — Minor — DESIGN — AC-3.0 does not say where the pre-C1 manifests come from

The Go/No-Go table orders C1 first and AC-1.1 requires the gate to exit 0 afterwards.
AC-3.2 solved the identical problem explicitly (scratchpad copies, argv form, no
tracked file modified); AC-3.0 inherits none of that wording, so the cheapest reading
is "revert the six edits, run, re-apply" and an abort mid-loop leaves C1 silently
reverted. Give AC-3.0 AC-3.2's sentence verbatim and assert
`git status --porcelain` is empty afterwards.

## Recurring Issue Check

- **R1** OK — N4 + C2's forbidden `function collectScopes` pattern genuinely reuse the walker; the additive `pin`/`selfPins` fields are transparent to both existing consumers.
- **R2** OK — floors live only in the manifests; the `BE_VER` coupling is single-sourced and `check-dockerfile-prisma-pin.sh:68` reads only `/^brace-expansion@>=3/`.
- **R3** Finding — F1 (the `unparseable` pin form), F2 (the `"."`-only scope form).
- **R4** N/A — no event or notification dispatch.
- **R5** N/A — no transactions.
- **R6** N/A — no cascade deletes.
- **R7** N/A — no E2E selectors.
- **R8** N/A — no UI.
- **R9** N/A — no fire-and-forget work.
- **R10** OK — C3 imports C2 one-way; no back-edge.
- **R11** N/A.
- **R12** OK — the severity enum is handled without a filter; the API vocabulary is now correct throughout.
- **R13** N/A.
- **R14** N/A.
- **R15** N/A.
- **R16** Finding (F5) — the local path now exists but collides with the gate-coverage meta-control; VE-1's "offline by contract" is unsourced.
- **R17** OK — C3 is the only new consumer of the extended primitive.
- **R18** Finding (F5) — `gate-selftest-debt.txt` is the allowlist AC-4.2 forbids extending while C5's step shape requires it.
- **R19** OK — AC-2.2 now adds real assertions on the new fields, closing Round 1's F7.
- **R20** N/A.
- **R21** Finding (F9) — two revision-2 census numbers were not re-verified by execution; the derivation is again ahead of the instrument.
- **R22** OK — the plan extends `collectScopes` rather than reinterpreting it.
- **R23** N/A.
- **R24** N/A.
- **R25** N/A.
- **R26** N/A.
- **R27** N/A.
- **R28** N/A.
- **R29** Finding (F9).
- **R30** OK.
- **R31** OK for AC-3.2; Finding (F10) for AC-3.0.
- **R32** OK — AC-5.3 requires an observed run, and AC-3.3 exercises the shell as a process.
- **R33** OK — all seven workflow files enumerated; only `ci.yml` carries PR-triggered gate jobs, it has no aggregator job, and its `changes` filter is opt-in via `needs: changes`, so I-5.3 is implementable without touching it.
- **R34** OK — SC-A…SC-F each carry an owner, a worst case, a likelihood and a cost.
- **R35** OK — VE-1/VE-4 give the manual paths and AC-5.3/AC-5.4 name them.
- **R36** Finding (F4) — four of the five markerless-weakening forms have no mechanism after C7; executed and confirmed empty.
- **R37** N/A.
- **R38** OK — S5/S6 give both remedies and the null-patch branch is defined; the Round-1 wedge is closed and the measurement reproduces.
- **R39** N/A.
- **R40** Finding (F6) — the row/envelope shape cannot carry the withdrawn count or separate a refusal from a query failure.
- **R41** Finding (F6, F7) — `--report`'s withdrawn accounting and cases 16-allow/18b are declared without a backing path.
- **R42** Finding (F1, F2) — the class was re-derived over all three buckets; 25/24/1/18 reproduces, but `unparseable` is a third bucket the derivation never enumerates and `{"pkg": []}` shows entries and rows are not 1:1.
- **R43** OK — floors move up only, no new key; the disjointness gate exits 0 today.
- **R44** Finding (F4).
- **R45** OK — 18 sequential requests, measured linear; no `Link` header on any package.
- **R46** Finding (F3) — the `"."` self-pin's parent is resolved by scopePath position rather than by the scope's parent binding.
- **R47** OK — `semver.intersects` is the adjudicator; the three C1 forbidden patterns are honestly scoped and none matches its own fix.
- **R48** Finding (F6a) — recovering the withdrawn count would put the S4 predicate in two places.
- **R49** Finding (F1). Control-class declarations elsewhere are honest.
- **R50** Finding (F8). AC-6.1 checked and NOT a finding: `check-doc-paths.mjs`'s Pass B `SCRIPT_REF_RE` bypasses `SKIP_GLOBS`, so C6's new path reference is genuinely validated.
- **R51** Finding (F3).
- **R52** Finding (F2, F3) — re-auditing `collectScopes` surfaces two behaviours the new consumer inherits without stating: the recurse-then-push order and the no-`continue`-after-recursion at line 103.
- **R53** OK on method, Finding on the instrument (F8) — the "0 members" half is real and reproduces.
- **R54** OK — the host pin, `redirect: "error"` and the `GITHUB_API_URL` refusal close the ambient-context path.
- **R55** Finding (F6b) — `undecidable` is now the in-band sentinel for both "query failed" and "manifest is malformed".
- **R56** N/A.
- **R57** OK — pagination is refused rather than cursor-walked; no package returns a `Link` header at `per_page=100`. (F7 notes the allow side of that refusal is untested.)

### Security expert — round 2

# Security Review: stale-override-floors (revision 2)
Date: 2026-08-05 · Round 2 · Reviewer: Security Engineer
Base: `8d688731c`, tree clean. No tracked file modified; all experiments in `/tmp/sofr`.

## Reproduction of revision 2's load-bearing numbers (R29)

Executed before writing any finding.

| Claim | Reproduction | Verdict |
|---|---|---|
| 25 walker entries / 24 pins / 1 scope opener / 0 `"."` keys | independent walk of the three tracked manifests: `entries 25, pins 24, scopes 1, selfpins 0`; per-manifest `19 / 2 / 3` | **confirmed exactly** |
| 18 distinct package names | `@babel/core, @crxjs/vite-plugin, @hono/node-server, body-parser, brace-expansion, cross-spawn, effect, esbuild, find-my-way, hono, js-yaml, lodash, nodemailer, postcss, qs, rollup, sharp, undici` | **confirmed exactly** |
| M1–M6 members, GHSA ids, severities, bands, floors | re-intersected every pin against every live same-package band via `semver.intersects` + `,→ ` normalization. Reproduced verbatim, including M3/M6 both landing on 8.5.23 and M6's third band `GHSA-6g55-p6wh-862q [high] <= 8.5.11 → 8.5.12` | **confirmed exactly** |
| Non-member `@crxjs/vite-plugin > rollup: ^2.80.0` clean by one patch | no intersecting live band; `GHSA-mw96-cpmx-2vgc` is `< 2.80.0` | **confirmed** |
| Canary band `GHSA-rgw5-rvv9-x895` / `>= 4.0.0, < 5.0.9` | present, `severity high`, `type reviewed`, `withdrawn_at null`, four npm bands, **`updated_at: 2026-08-03T20:17:20Z`** | **confirmed — but see F2** |
| 0 live same-package entries with `first_patched_version: null` | `nullSame: 0` (11 null-patch entries exist, all on *foreign* packages — `lodash.pick`, `lodash.set`, `maven:org.webjars.npm:nodemailer`, …) | **confirmed** |
| 0 live `type: unreviewed` | `unrevLive: 0`, `unrevAll: 1` (the one unreviewed advisory is withdrawn) | **confirmed** |
| No `Link` header at `per_page=100` on any of the 18 | `truncated: []` | **confirmed** |
| **306** live same-package vulnerability entries | measured **223**. Alternates: 257 (live, all packages), 249 (live, all npm), 263 (all incl. withdrawn), 229 (same-package incl. withdrawn). **No reading yields 306** | **not reproducible** |
| **7** withdrawn advisories skipped | measured **6**: `effect/GHSA-6hr9-4692-fch9`, `esbuild/GHSA-gv7w-rqvm-qjhr`, `lodash/GHSA-8p5q-j9m2-g8wr`, `nodemailer/GHSA-46j5-6fg5-4gv3`, `nodemailer/GHSA-jj37-3377-m6vv`, `qs/GHSA-crvj-3gj9-gm2p` | **not reproducible** |
| `check-workflow-supply-chain.mjs` `runsVerifier` at `:101-104` | `verifierLineRe` at 101, `runsVerifier` at 102–104 | confirmed |
| `check-dockerfile-prisma-pin.sh:68` reads `/^brace-expansion@>=3/` | line 68 exactly | confirmed |
| disjointness self-test = 25 cases, `"."` case pins the exclusion | 25 `it(...)`; the `"."` case is `findOverlappingKeys({".": "1.2.3", "pkg@1": "^1.0.0"}) === []` | confirmed |
| `vitest.config.ts` includes `scripts/__tests__/**/*.test.mjs`, `coverage.include` is `src/`-only | confirmed | confirmed |
| VE-3's rate-limit hazard | my own unauthenticated run exhausted `core: 60/60` after 19 requests and the next call returned a non-array body that threw `j is not iterable` | **confirmed, and see F5** |

SEC-F1, F2, F5, F6, F7(sanitization), F8 are correctly and completely resolved. F3, F4 are resolved with the residuals below.

---

## Findings

### SEC-R2-F1 — Severity: Major — DESIGN — The host pin and the canary make AC-3.3 unsatisfiable, and every cheap reconciliation is a bypass of one of them

**Problem.** Two clauses of revision 2 contradict each other and cannot both be implemented as written.

- Network-shell hardening: "assert `new URL(endpoint).host === "api.github.com"` and `protocol === "https:"`; refuse if `GITHUB_API_URL` or a proxy env points elsewhere", plus "before judging, query `brace-expansion` and refuse unless `GHSA-rgw5-rvv9-x895` is present with band `>= 4.0.0, < 5.0.9`".
- AC-3.3: "Against a local `http.createServer` fixture: 403 → exit 1 …; 500×3 → exit 1 …; **500 then 200 → exit 0**; non-JSON body → exit 1; connection refused → exit 1; `GITHUB_API_URL` pointing elsewhere → **exit 1 before any request**."

The last AC-3.3 clause is the refusal of exactly the mechanism the preceding five clauses need. There is no stated route by which the gate reaches `http://127.0.0.1:PORT` that is not "the endpoint host is not `api.github.com`" and, on most implementations, "`GITHUB_API_URL` points elsewhere". Independently, "500 then 200 → exit **0**" additionally requires the fixture's `200` body to satisfy the canary — the plan never says the fixture serves a canary-bearing payload, and if it does not, that clause's expected exit is 1, not 0.

**Impact.** The implementer resolves this the cheapest way: an env var or a `NODE_ENV`/`VITEST` branch that disables the host pin (and, transitively, the canary) when a test base URL is present. That is a control suspension granted through ambient context (R54) applied to the two mechanisms introduced specifically to close SEC-F3's permanent-green class — and it is markerless: the diff shows a test affordance, not a weakening. The same variable is then present in CI, where the gate's entire verdict is decided by whatever that variable points at. The plan's own scenario 5 ("a redirected `GITHUB_API_URL`… the canary fails and the gate exits 1") becomes false in the presence of the affordance the plan's own AC forces.

**Recommended action.**
1. *Deny + allow.* Replace the env-var route with a **parameter**: `fetchAdvisories(pkg, { baseUrl, canary })` and `main(manifests, { baseUrl, canary })`, defaulted to `https://api.github.com` and the real canary, reachable only by direct import from the self-test — never from `main()` reading `process.env`. Deny: `GITHUB_API_URL=https://evil.example` (and each proxy var, F1 clause 3) must still exit 1 *before any request*. **Allow: AC-3.3's five `http.createServer` clauses must all run and `500 then 200` must exit 0**, with the fixture's 200 body carrying a canary-shaped payload so the canary path is exercised rather than bypassed.
2. *Red-prove each clause separately, by execution.* (a) delete the host assertion → the `GITHUB_API_URL` deny case reds; (b) delete the `process.env` prohibition (add an env read of `baseUrl` back into `main`) → a new case asserting `main()` with `OVERRIDE_FLOOR_BASE_URL` set still hits `api.github.com` reds; (c) delete the canary invocation → F2's new canary case reds; (d) point the fixture's 200 body at a canary-free array → the `500 then 200 → exit 0` case must red, proving the canary actually runs on the shell path.
3. *Fail loudly.* Enumerate the neither-pass-nor-fail outcomes and name each: `ADVISORY_ENDPOINT_NOT_PINNED` (host/protocol mismatch), `ADVISORY_PROXY_ENV_SET`, `ADVISORY_SOURCE_CANARY_FAILED`, `ADVISORY_SOURCE_CANARY_REVISED` (F2), `ADVISORY_BASEURL_INJECTED_IN_MAIN` (the parameter reached `main` from anything but a direct import — refuse rather than proceed).
4. *Do not fix by deleting what made the defect visible.* Do not resolve this by dropping AC-3.3's process-level shell test — Round 1's RT5/F6 exists because `main`, `fetchAdvisories`, the exit path and `--report` were unreached by any test; that coverage is the thing being preserved.
5. *Boundary and tie.* The boundary is `main()`'s ambient-input surface: `main()` reads **zero** environment variables that influence the endpoint, the canary, or the verdict; the self-test crosses that boundary by function argument only. The tie: an injected `baseUrl` whose host *is* `api.github.com` is still allowed (so a recorded-response replay against the real host works); an injected `baseUrl` reached via `process.env` is refused even when it points at `api.github.com`.

Add a C3 forbidden pattern `pattern: process\.env` in `check-override-floor-staleness.mjs` outside the token read, with the reason stated as the R54 class.

---

### SEC-R2-F2 — Severity: Major — DESIGN — A single fixed (package, GHSA, band) is not a positive control over 18 queries; the API returns `200 []` for an unknown or malformed `affects`, and the canary ships with no self-test case and no mutation row

**Problem.** Three separate defects in the canary as specified.

*(a) Granularity.* The canary proves that **one** of 18 requests returned real advisory data. Executed against the live API:

```
gh api "/advisories?ecosystem=npm&affects=this-package-does-not-exist-zzz9&per_page=100"  →  []
gh api "/advisories?ecosystem=npm&affects=%00bad&per_page=100"                            →  []
```

The API answers `200 []` for a nonexistent package name *and* for a malformed `affects` value. Since a genuinely advisory-free package must still pass (`@crxjs/vite-plugin`, 0 advisories — confirmed), `[]` is unconditionally "clean" for all 17 non-canary packages. Anything that shapes responses per-package — the proxy the plan's own scenario 5 names, a caching intermediary, a name-normalisation bug on the gate's side, a package rename upstream, or F4's mis-derived package name — serves the real `brace-expansion` payload, empties the rest, and the gate reports the cleanest run in its history. The plan's claim, "The canary — not per-package emptiness — is what separates 'checked and clean' from 'could not check'", is stronger than the mechanism (R49): it separates channel-dead from channel-live, not checked from unchecked.

*(b) False-red / positive-control-editing pressure.* The canary asserts a byte-exact band on an advisory whose `updated_at` is `2026-08-03T20:17:20Z` — two days before this plan, and already split into four bands (`< 1.1.18`, `>= 2.0.0, < 2.1.4`, `>= 3.0.0, < 3.0.6`, `>= 4.0.0, < 5.0.9`). A fifth split, or a `<= 5.0.8` respelling of the same interval, reds the gate repo-wide (I-5.3: no paths filter) with no security cause, and the only remedy is editing the positive control — training the operator to edit the one thing that must not be edited to make a red go away.

*(c) No proof it can fail.* C4 lists 18 deny/allow pairs and AC-4.3 lists 13 mutations. **Neither mentions the canary.** The mechanism that resolves SEC-F3 — the permanent-green class — is the only new mechanism in revision 2 with zero test coverage and zero red-proof, and the plan never states whether the canary runs before `--report`'s verdict path (AC-3.0 and AC-3.4 both invoke `--report` and neither mentions it).

**Impact.** SEC-F3 is not actually closed. An input-shaped permanent green survives for 17 of 18 packages, with nothing in any diff to review — the R36/RS5/R54 shape the canary was written to prevent. Combined with F4, a mis-derived package name becomes a silent `200 []` clean.

**Recommended action.**
1. *Deny + allow.* Three layers.
   - **Per-package integrity, derivable without a baseline:** every advisory the API returns for `affects=<pkg>` must yield ≥1 `ecosystem === "npm" && package.name === pkg` band. Measured today: **0 violations across all 18 packages** — free headroom (R53), no suppression list, no tuned threshold. Deny: an advisory returned for `affects=X` with no exact-`X` band → `AFFECTS_WITHOUT_MATCHING_BAND`. **Allow: `@crxjs/vite-plugin`, which returns 0 advisories, must still be `clean`** — the rule is vacuously true on an empty list, by design.
   - **Canary, structurally:** assert `GHSA-rgw5-rvv9-x895` is present, `withdrawn_at === null`, `severity === "high"`, and carries **≥1** npm band naming `brace-expansion` whose normalized range intersects `5.0.8` — a property that survives GitHub re-splitting the bands. Split the refusal in two so the operator knows which happened: `ADVISORY_SOURCE_CANARY_FAILED` (advisory absent / channel dead) vs `ADVISORY_SOURCE_CANARY_REVISED` (advisory present, asserted property no longer holds → the constant needs review, not the tree).
   - **Visibility over the residual:** `--report` prints the per-package advisory count for all 18. A per-package empty stays a *pass* but stops being *invisible*; the weekly run's output diff is where a 44→0 transition on `hono` becomes reviewable. State plainly in the plan that a per-package response-shaping adversary is **not** closed by the canary, and that TLS to a public CA is the only thing standing between the gate and that adversary.
2. *Red-prove each clause separately, by execution.* (a) delete the canary call → new case `canary absent from the injected map → ADVISORY_SOURCE_CANARY_FAILED` reds; (b) relax the canary to "advisory id present" only → new case `canary present but band no longer intersects 5.0.8 → ADVISORY_SOURCE_CANARY_REVISED` reds; (c) delete the per-package integrity rule → new case `advisory returned for affects=hono carrying only a lodash band → AFFECTS_WITHOUT_MATCHING_BAND` reds; (d) invert the integrity rule to fire on empty lists → the `@crxjs/vite-plugin` allow case reds; (e) move the canary call after the verdict → a case asserting `--report` on a canary-free map exits 1 reds.
3. *Fail loudly.* Route each neither-pass-nor-fail outcome to its own token: `ADVISORY_SOURCE_CANARY_FAILED`, `ADVISORY_SOURCE_CANARY_REVISED`, `AFFECTS_WITHOUT_MATCHING_BAND`, and `CANARY_QUERY_FAILED` (the canary request itself 5xx'd/timed out — distinct from the advisory being absent, because retrying is right for one and wrong for the other).
4. *Do not fix by deleting what made the defect visible.* Do not weaken the canary to "the request returned 200" — the 200-`[]` measurement above is exactly why a status check is not a positive control. And do not resolve (b) by removing the canary: the false-red cost is real and the answer is a revision-stable assertion, not no assertion.
5. *Boundary and tie.* The boundary: a package's verdict may be `clean` only if its query completed **and** the canary held **and** every advisory it returned named that package. The tie: a package returning `[]` is `clean` (that is the `@crxjs/vite-plugin` case and it must keep working); a package whose query is absent from the `Map` or `{ok:false}` is `undecidable` (I-3.4, already correct).

---

### SEC-R2-F3 — Severity: Major — DESIGN — C7 gives a mechanism to one of C5's five forbidden weakening forms; the other four remain plan-level greps, which is the defect C7 exists to correct

**Problem.** C5 forbids five weakening forms and states the reason: "revision 1 forbade exactly one of the five ways to discard an exit status… I-3.5 now makes `--report` exit 1 on violations, and **these patterns close the rest**." C7 widens only `runsVerifier`. Executed against the real gate, simulating C7's stated change by forcing `runsVerifier === true`:

```
gate + continue-on-error  | runsVerifier=true: ["… sets 'continue-on-error: true' …"]
gate || true              | runsVerifier=true: []
gate | tee                | runsVerifier=true: []
gate set +e               | runsVerifier=true: []
gate --report             | runsVerifier=true: []
```

The line-level mask rule is gated on a **second, separate** precondition C7 does not touch: `verifierLineRe = /audit\s+signatures|dist\??\.attestations/` at `:101`. A `run:` line invoking `check-override-floor-staleness.mjs` never matches it, so `maskRe` is never consulted for that line. And `maskRe` itself (`/(\|\|\s*(true|exit\s+0|echo)|;\s*(true|exit\s+0)|\|\|\s*:(?=\s|$))/`) contains **no** `set +e` alternative and **no** pipe alternative.

The pipe form is not theoretical: no workflow in `.github/workflows/` sets `defaults.run.shell` or a top-level `shell:`, so GitHub's default `bash -e {0}` applies — **no `pipefail`**. `node gate.mjs | tee out.txt` therefore returns `tee`'s status and the gate's red is discarded.

Two further preconditions C7 does not address:
- The widening is bound to the literal string `check-override-floor-staleness`. Replacing the `run:` with `npm run check:override-floors` (a shape this repo uses elsewhere) silently flips `runsVerifier` to false and the whole `continue-on-error` protection evaporates with nothing in the diff to review — a decision bound to a name, not to what the workflow runs (R51).
- The `continue-on-error` regex requires the literal token `true`; `continue-on-error: ${{ github.event_name == 'schedule' }}` is unmatched.

**Impact.** After C7 lands, four of C5's five forbidden patterns are exactly what C7's own rationale calls out as unacceptable — "a forbidden pattern that is a plan-level grep only… the same 'a remembered rule is not a control' failure this whole plan exists to correct, reproduced inside the correction." It is reproduced one level down, inside the correction of the correction. A PR that masks this gate's exit merges under a green `check-workflow-supply-chain`. (Note: `ci.yml` already matches `runsVerifier` via its three `npm audit signatures` steps, so C7's real and only target is the new standalone workflow — where none of the four forms is caught.)

**Recommended action.**
1. *Deny + allow.* Widen **both** primitives and extend `maskRe`:
   - `verifierLineRe` → `/audit\s+signatures|dist\??\.attestations|check-override-floor-staleness/`.
   - `maskRe` → add `set\s+\+e` and a trailing-pipe alternative anchored to the verifier invocation (`\|(?!\|)`), so `gate | tee` is a violation.
   - Bind the workflow-level flag to the *gate's identity, not its spelling*: match `check-override-floor-staleness` **or** any `npm run` script name whose `package.json` definition invokes it, resolved by reading `package.json` — or, cheaper and sufficient, add a `check-doc-paths`-style rule forbidding indirection: the gate may only be invoked by literal path in a workflow.
   - **Allow: `dependency-signatures.yml` and `release.yml` must stay green unedited, and a workflow running neither verifier must keep an unrelated `continue-on-error` (I-7.2).** Add the case C5/AC-7.1 omits and the mechanism *denies*: a workflow that runs the gate **and** has an unrelated step with `continue-on-error: true` is a violation — decide that deliberately and write it down, because the whole-file scope makes it so whether or not the plan says it.
2. *Red-prove each clause separately, by execution.* One mutation per clause, each naming its case: revert `verifierLineRe`'s widening → the `gate || true` fixture reds; drop `set\s+\+e` from `maskRe` → the `set +e` fixture reds; drop the pipe alternative → the `gate | tee` fixture reds; revert `runsVerifier`'s widening → the `continue-on-error` fixture reds; broaden `runsVerifier` to every workflow → the unrelated-workflow allow fixture reds (already AC-7.2); replace the literal invocation with `npm run …` in the deny fixture → the indirection case reds.
3. *Fail loudly.* `WORKFLOW_INVOKES_GATE_INDIRECTLY` for an `npm run` alias; `VERIFIER_EXIT_MASKED` (existing message) for the four forms. A workflow file that fails to parse into logical lines must be a violation, not a skip.
4. *Do not fix by deleting what made the defect visible.* Do not resolve the `--report` clause by removing `--report` from C6's runbook — the operator's "show me where every floor stands" invocation is the feature. Restrict `--report` in a `run:`, keep it in prose.
5. *Boundary and tie.* The boundary is the workflow file, whole-file scoped (the existing rule's scope — do not narrow it to job scope while extending it, or the existing `npm audit signatures` coverage regresses). The tie: `continue-on-error: false` written explicitly is allowed; `${{ ... }}` expression forms other than a literal `true` remain unmatched — name that as an accepted residual rather than implying coverage.

---

### SEC-R2-F4 — Severity: Major — DESIGN — S2 attributes a `"."` self-pin by parsing the parent name backwards out of the `scopePath` display string; a valid override key makes that attribution wrong, and the API answers `200 []` for the wrong name

**Problem.** C2's Consumer 3 specifies: "`selfPins` **with the enclosing scope's parent name derived from `scopePath`**". `collectScopes` builds `scopePath` by string concatenation, `` `${scopePath} > ${key}` ``, and the array is post-order — there is no structured back-link from a nested scope to the key that opened it. Deriving the parent name therefore means splitting a display string on `" > "`, and override keys can legitimately contain that separator. Executed:

```
semver.validRange("1.0.0 || > 2.0.0")  →  "1.0.0||>2.0.0"     (a VALID selector)
key       = "evil@1.0.0 || > 2.0.0"
scopePath = "overrides > evil@1.0.0 || > 2.0.0"
backward parse (last " > ")  →  "2.0.0"
```

So `{"evil@1.0.0 || > 2.0.0": {".": "0.0.1"}}` — a syntactically valid overrides block that `check-override-key-disjointness` accepts (the selector parses, so it does not land in `unparseable`) — makes C3 judge the self-pin against a package named `"2.0.0"`. Combined with F2's measurement, `affects=2.0.0` returns `200 []`, so the row is `clean`. The bypass is silent end-to-end, on exactly the form S2 exists to make visible. C4 case 9's fixture is `{"parent": {".": "1.2.3"}}` — a key with no selector and no spaces, i.e. chosen precisely where the defect cannot appear, so the case is green with the defect present.

The same missing linkage is load-bearing for S1. `collectScopes` pushes the scope-opening key into `byPackage` *as well as* recursing (`:100-109`), so `@crxjs/vite-plugin` appears there with `range: "*"` and, after C2, `pin: {rollup: "^2.80.0"}`. S1 requires the exclusion be tied to "its nested pins were walked and yielded, **not** because of its `typeof`" — and the only way to test "did this key's scope yield children" is to correlate the entry with a scope in `into`. Fortunately that direction is unambiguous, because it reconstructs the key *forward* (`` `${scope.scopePath} > ${entry.key}` `` is the same construction the producer used). The backward direction is the broken one, and the plan specifies the backward direction.

**Impact.** A latent fail-open on the newly-added S2 control, reachable by a valid manifest edit, invisible to `check-override-key-disjointness`, and silently `clean` because of the `200 []` behaviour. 0 instances today, so nothing at HEAD reds; and the C4 case as specified cannot detect it. R51 (decision bound to a name, not the object) with the interval writable by the PR under review.

**Recommended action.**
1. *Deny + allow.* Make the linkage structural, not textual. In `collectScopes`, carry the opening key on the scope object at recursion time, where it is in hand — an additive `parentKey` (and `parentName` from `splitOverrideKey(parentKey).name`), `null` at depth 0. C3 then attributes `selfPins` to `scope.parentName` and never parses `scopePath`. For S1/`EMPTY_SCOPE`, keep the *forward* reconstruction (`${scope.scopePath} > ${entry.key}`) or, better, the same `parentKey` identity. Deny: `{"evil@1.0.0 || > 2.0.0": {".": "0.0.1"}}` must be judged against **`evil`**, and a `"."` at depth 0 must still yield `DOT_KEY_AT_TOP_LEVEL`. **Allow: the 25 existing disjointness cases must stay green unedited — including line 116's `findOverlappingKeys({".": "1.2.3", "pkg@1": "^1.0.0"}) === []` and the post-order case at line 214 asserting `scopes[0].scopePath === "overrides > parent"`; `scopePath` keeps its exact current spelling as a human label.** I verified no existing case deep-equals a `byPackage` entry or a scope object, so `parentKey`/`parentName`/`pin`/`selfPins` are all safe additions.
2. *Red-prove each clause separately, by execution.* (a) replace `scope.parentName` with a backward `scopePath.slice(scopePath.lastIndexOf(" > ")+3)` parse → a **new** C4 case using the `evil@1.0.0 || > 2.0.0` key must red (the current case-9 fixture must not be the one that carries this proof — it cannot); (b) delete the `parentKey` assignment → case 9 reds; (c) replace the forward scope lookup with `typeof pin === "object"` → case 10's `EMPTY_SCOPE` deny reds, proving S1's tie to children rather than type; (d) delete `selfPins` → case 9 reds (already AC-4.3).
3. *Fail loudly.* `SELF_PIN_PARENT_UNRESOLVED` when a scope carrying `selfPins` has no `parentKey`; `SELF_PIN_PARENT_UNPARSEABLE` when `splitOverrideKey(parentKey).name` is empty or not a plausible npm name; `EMPTY_SCOPE` (already specified) when the scope yielded no pins. None of these may resolve to `clean`, and none may be answered by a query — a name the walker could not derive must never reach `fetchAdvisories`.
4. *Do not fix by deleting what made the defect visible.* Do not "fix" this by making `collectScopes` reject keys containing `" > "` — the repo already ships `"brace-expansion@>=3.0.0 <5.0.9"`, spaced selectors are legal, and rejecting them would break the disjointness gate's own coverage. And do not remove `scopePath` from violation messages; it is the operator's locator.
5. *Boundary and tie.* The boundary: a package name reaching `fetchAdvisories` originates from `splitOverrideKey` applied to a key the walker actually saw, never from re-parsing a formatted string. The tie: a scope opener whose key is `"."`-free and selector-free (`{"parent": {...}}`) resolves to `parent` under both the old and new rules — that case must not change, and it is the one existing behaviour depends on.

---

### SEC-R2-F5 — Severity: Minor — DESIGN — Three of the four new network-shell hardening mechanisms ship with no C4 case and no AC-4.3 mutation row

**Problem.** Revision 2 adds five hardening mechanisms. Their proof coverage:

| Mechanism | C4 case | AC-4.3 mutation |
|---|---|---|
| Canary | — | — | (F2) |
| Host pin / `redirect: "error"` / `encodeURIComponent` | AC-3.3 clause 6 only | — |
| Response shape validation (`ADVISORY_RESPONSE_SHAPE`, `ADVISORY_FIELD_MALFORMED`) | — | — |
| Map-keyed caches (`__proto__`/`constructor` prototype pollution) | — | — |
| `AbortSignal.timeout` (`ADVISORY_QUERY_TIMEOUT`) | — | — |

The prototype-pollution hazard is real as stated — executed: `JSON.parse('{"__proto__":{}}')` makes `__proto__` an **own** property, and `({})["constructor"]` is truthy and non-array — but an overrides key is `pkg@range`, so reaching it needs a manifest key literally named `constructor` or `__proto__`. Cheap to test, and with no test the `Map` can silently be refactored to `{}`.

**Impact.** RT7 applied to the new controls fails: three mechanisms cannot be shown able to fail. `AbortSignal.timeout` in particular is the one thing between a wedged request and `timeout-minutes: 5`, and a mistyped `AbortSignal.timeout(10_000)` (e.g. passed as `{ signal: AbortSignal.timeout }`) silently disables it with no test to notice.

**Recommended action.**
1. *Deny + allow.* Add four C4 cases with paired allows: shape-malformed advisory (`ghsa_id: 12345`, `vulnerabilities: "x"`, band as a number) → `ADVISORY_FIELD_MALFORMED`, **allow: a well-formed advisory with an unexpected *extra* field round-trips and is judged normally** (forward compatibility must not be a refusal); an overrides key `"constructor"` and `"__proto__"` → judged as an ordinary package name and reported, **allow: a normal name is unaffected**; a fixture server that never responds → `ADVISORY_QUERY_TIMEOUT` within the bound, **allow: a slow-but-under-bound 200 succeeds**.
2. *Red-prove each clause separately, by execution.* Change `new Map()` → `{}` → the `constructor` case reds; delete each shape assertion in turn → its case reds; drop `signal` from the fetch options → the timeout case reds (with `command -v timeout || command -v gtimeout` per VE-4, refusing loudly if neither exists).
3. *Fail loudly.* `ADVISORY_RESPONSE_SHAPE` (top level not an array), `ADVISORY_FIELD_MALFORMED` (per-field, naming the field and the ghsa_id), `ADVISORY_QUERY_TIMEOUT`. A malformed field must never degrade to "skip that advisory".
4. *Do not fix by deleting what made the defect visible.* Do not satisfy the shape check by tolerating unknown types — the recorded-response fixture exists so a rename reds.
5. *Boundary and tie.* The boundary is the `fetchAdvisories` return envelope: nothing past it is unvalidated. The tie: an advisory with `vulnerabilities: []` (legal, e.g. informational) is well-formed and yields zero bands; an advisory with `vulnerabilities` absent is malformed.

---

### SEC-R2-F6 — Severity: Minor — DESIGN — S3's exact-name filter has no over-drop detector, and only its fail-closed direction is named

**Problem.** S3 justifies exact equality with the wrong-floor hazard (`GHSA-r5fr-rjxr-66jc`) and the prefix hazard (`hono` / `@hono/node-server`) — both correct, both the *fail-noisy* direction. The *fail-open* direction is unnamed: if GitHub ever lists the subject under a different spelling (a case variant, a renamed package, an entry recorded under a non-npm ecosystem for an npm package, as `maven:org.webjars.npm:nodemailer` already is in this corpus), exact equality drops the only band and the pin is silently `clean`. There is no token for it and no case detecting it.

Measured today: **0** advisories returned by `affects=X` lack an exact-npm-`X` band, across all 18 packages. That is free headroom for a detector, and it is the per-package positive control F2 needs.

**Impact.** S3 is correct today and unverifiable tomorrow: the filter can start dropping everything and every signal is a green.

**Recommended action.** Fold into F2's clause 1 (`AFFECTS_WITHOUT_MATCHING_BAND`, headroom 0, allow side = `@crxjs/vite-plugin`'s empty list). Additionally, state both directions in S3's "Why not the alternative" cell: over-broad matching produces a violation naming the right package with the wrong floor (noisy, self-correcting); over-narrow matching produces a clean row for a vulnerable pin (silent, self-reinforcing) — and only the second needs a mechanism, which is why the detector exists. Red-prove: change `===` to `startsWith` → case 12 deny reds (already AC-4.3); change `===` to a never-matching predicate → the new `AFFECTS_WITHOUT_MATCHING_BAND` case reds. Boundary: the filter's output; tie: a band naming the subject under `ecosystem !== "npm"` is *not* a band (correct today) but *is* evidence the advisory is about the subject, so it satisfies the detector rather than tripping it.

---

### SEC-R2-F7 — Severity: Minor — PROSE — Two figures in the member-set derivation table are not reproducible; the conclusions they support are

**Problem.** The census table states "live (non-withdrawn) same-package vulnerability entries | **306**" and "withdrawn advisories skipped | **7**". Re-derived at `8d688731c` with the plan's own stated method (`ecosystem=npm&affects=<pkg>&per_page=100`, exclude `withdrawn_at != null`, filter `vulnerabilities[]` to `package.ecosystem === "npm" && package.name === pkg`): **223** and **6**. No alternate reading reproduces 306 — the nearest candidates are 257 (live, all packages), 249 (live, all npm), 263 (all entries incl. withdrawn), 229 (same-package incl. withdrawn). The 6 withdrawn advisories are enumerated in the reproduction table above. The Round-1 review's own F4 said "6 withdrawn"; the orchestrator reproduction section says "306 live vulnerability entries", so the two artifacts disagree with each other as well as with measurement.

**Impact.** Presentational, not behavioural — the *conclusions* both figures support reproduce exactly: 0 live same-package entries with a null patch, 0 live unreviewed advisories, both instances cited in Round 1 confirmed withdrawn. But 306 is the denominator SC-E's deferral rests on ("measured 0 of 306 … Likelihood: low"), and revision 2's opening promise is "Every number in this document is produced by executing a command that is written beside it." A denominator that no command reproduces re-creates the exact revision-1 failure the rewrite was for. Note VE-2 makes the numerator legitimately mobile — that is an argument for printing the figures from `--report` at PR time, not for asserting them in prose.

**Recommended action.**
1. *Deny + allow.* Replace both figures with the number `--report` prints, and make `--report` print them: per-package advisory count, withdrawn count **with GHSA ids**, live same-package band count, null-patch count, unreviewed count. AC-6.2 already requires every documented command be executed — extend it so the census table is regenerated from `--report` output rather than transcribed. **Allow: the six member rows and their floors must be unchanged by the regeneration** — they reproduced exactly and are the part of the table that is correct.
2. *Red-prove.* Make `formatReport` omit the withdrawn count → the AC-3.0 comparison against the recorded table reds. (AC-4.3 already covers `formatReport` filtering to violations only.)
3. *Fail loudly.* If `--report`'s totals cannot be produced (any package `undecidable`), the report prints `CENSUS_INCOMPLETE` and the totals line is suppressed rather than printed with a smaller number — a shrunk denominator that still prints is the shape that produced 306.
4. *Do not fix by deleting what made the defect visible.* Do not drop the census table; it is what made revision 1's undercount findable.
5. *Boundary and tie.* The boundary: no derived count appears in the plan or the runbook that `--report` does not print. The tie: the *shape* claims (0 null-patch, 0 unreviewed, 0 truncated) are reproduced and stay; only the counts move.

---

### SEC-R2-F8 — Severity: Minor — DESIGN — C5's `pre-pr` step is likely to be written in the idiom the gate-self-test meta-gate does not match

**Problem.** `check-gate-selftest-coverage.sh`'s second member-set primitive — the anti-evasion half, which exists so "a new gate cannot evade the meta-gate by being written inline in pre-pr.sh instead of as a `scripts/checks/` file" — greps `run_step[[:space:]]+"Static:[^"]*"[[:space:]]+bash[[:space:]]+-c` (`:170`). Measured in `scripts/pre-pr.sh`: **47** `queue_step "Static:"` lines vs **13** `run_step "Static:"` lines. Today there are **0** `queue_step "Static:" … bash -c` instances and all 13 `run_step … bash -c` gates carry debt entries, so the gate is not currently vacuous — but the file's dominant idiom is now the unmatched one (the bounded-parallel scheduler refactor moved it there), and C5 adds a new probe-gated `pre-pr` step. If that step is written as `queue_step "Static: override-floor-staleness" bash -c '…'`, it evades the self-test requirement and the debt-entry requirement entirely, and AC-4.2 passes.

**Impact.** Not exploitable today (headroom 0), but C5 is the change most likely to instantiate it, and the evasion is silent — the meta-gate's whole purpose is that a new gate cannot land untested.

**Recommended action.**
1. *Deny + allow.* Widen the primitive to `(run_step|queue_step)[[:space:]]+"Static:…"[[:space:]]+bash[[:space:]]+-c`. Deny: a `queue_step "Static: X" bash -c '…'` with no debt entry → `MISSING_GATE_SELFTEST`. **Allow: the 47 existing `queue_step "Static:"` lines that invoke a `scripts/checks/` file directly (not `bash -c`) must stay green with no new debt entries** — they are already covered by primitive (1) via their sibling test files, and pulling them in would add 47 spurious debt lines.
2. *Red-prove each clause separately.* Revert the `queue_step` alternative → a new `queue_step … bash -c` fixture reds; broaden the pattern to drop the `bash -c` anchor → the direct-invocation allow fixture reds (proving the two clauses are independent).
3. *Fail loudly.* `MISSING_GATE_SELFTEST` (existing) and `STALE_DEBT_ENTRY` (existing) both key on the run_step label — the label text is unchanged by the widening, so the 13 existing `pre-pr:` debt entries keep matching. If neither primitive matches any line in `pre-pr.sh`, that is `PREPR_ANCHOR_UNMATCHED`, not a pass.
4. *Do not fix by deleting what made the defect visible.* Do not resolve it by writing C5's step as `run_step` "so the gate sees it" — that leaves the class open for the next author and reintroduces a serial step into a parallel scheduler.
5. *Boundary and tie.* Boundary: every inline security gate in `pre-pr.sh`, regardless of which scheduler verb runs it. Tie: a `queue_step "Static: …"` that invokes a `scripts/checks/` file by path is covered by primitive (1) and must not also require a debt entry.

*[Adjacent] Minor: this is a pre-existing gate-coverage gap in `check-gate-selftest-coverage.sh` rather than a defect in this plan — it may overlap with the Testing expert's scope, but I raise it here because the primitive is a security-gate member-set derivation and C5 is the change that would first exercise it.*

---

### SEC-R2-F9 — Severity: Minor — DESIGN — S4 counts withdrawn advisories without naming them, and does not state which run's verdict is authoritative

**Problem.** S4 says withdrawn advisories are "counted in `--report` so the exclusion is visible rather than invisible". A count is not visibility of *which* — an operator cannot tell whether the count dropped because GitHub un-withdrew an advisory or because a query silently returned fewer entries. On the authority question: the design is in fact safe in both directions, but says so nowhere. Re-publication under a new GHSA id produces a new live band on the next run → red (fail-closed). Withdrawal between the scheduled run and the PR run makes the PR run green → the raised floor stays raised, which is inert. The unstated case is the operational one: an operator seeing a scheduled red and a PR green has nothing telling them which is current.

**Impact.** Low. An operator debugging a red/green disagreement between the Monday sweep and the PR job has no artifact to compare.

**Recommended action.** Print the withdrawn advisories' GHSA ids and `withdrawn_at` timestamps in `--report`, not just a count, and state in C6 that **every run re-queries and the most recent completed run is authoritative** — the gate holds no state and caches nothing across runs. Deny: an advisory whose `withdrawn_at` is set is excluded and named (C4 case 13 already covers the exclusion; extend its assertion to the id appearing in the report). **Allow: the same fixture with `withdrawn_at: null` produces exactly one violation naming the GHSA id** — already case 13's allow side, unchanged. Red-prove: delete the withdrawn-id emission from `formatReport` → the extended case-13 assertion reds. Fail loudly: an advisory with a `withdrawn_at` that is present but unparseable as a date is `ADVISORY_FIELD_MALFORMED`, not "not withdrawn". Do not fix by removing the withdrawn count. Boundary: `extractBands`' output; tie: `withdrawn_at: null` and `withdrawn_at` absent are both live.

---

## R52 audit of the widened primitive itself (not only the extension)

`collectScopes` audited directly, as required, rather than inferring from C2's additive claim:

- **`pin` field**: `findOverlappingKeys` destructures `{key, range}` (`:132`, `:136-151`); `findAmbiguousEdges` reads `.range` only (`:180-199`). No existing case deep-equals a `byPackage` entry or a scope object — grep of the 25 cases shows `collectScopes` referenced only at `:214` (asserting `scopes[0].scopePath` and `topLevelScope(...).depth`). **Additive and safe.**
- **`selfPins` field**: `"."` is skipped at `:99` *before* the `typeof value === "object"` recursion at `:100`, so an object-valued `"."` is currently not recursed either — C2 must capture it in `selfPins` for `DOT_KEY_NOT_A_RANGE` without adding a recursion (adding one would change `into`'s contents and could break the post-order assertion at `:215`). **I-2.3 holds; state the no-new-recursion constraint explicitly.**
- **Latent defect surfaced by the audit**: the scope opener is pushed into `byPackage` *in addition to* being recursed (`:100-109`), so the top-level `byPackage` for `extension/package.json` contains `@crxjs/vite-plugin` with `range: "*"` and an object `pin`. This is harmless for the disjointness gate (`intersects("*", …)` is never reached — the package has one key) and is exactly the entry S1 must classify. C2's Consumer-3 walkthrough should say so; today a reader would not expect a scope opener in `byPackage` at all. Folded into F4's remedy.
- **`check-workflow-supply-chain.mjs` widening**: `ci.yml` already satisfies `runsVerifier` via three `npm audit signatures` steps, so C7's widening changes behaviour only for the new standalone workflow — no regression on existing files, and `rg continue-on-error .github/workflows/` returns nothing, so AC-7.3 is reachable. The widening's insufficiency is F3.

---

## Recurring Issue Check

- **R1** OK — N4 + C2's forbidden `function collectScopes` pattern; verified no second walker is proposed.
- **R2** OK — floors live only in the manifests; the `BE_VER` coupling reads `/^brace-expansion@>=3/` at `check-dockerfile-prisma-pin.sh:68` (verified), which M4/M5 do not touch.
- **R3** **Fires — F3, F4.** The `"."` form and the four non-`continue-on-error` weakening shapes are not propagated to an enforcing mechanism.
- **R4** N/A — no event dispatch.
- **R5** N/A — no transactions.
- **R6** N/A — no cascade deletes.
- **R7** N/A — no E2E selectors.
- **R8** N/A — no UI.
- **R9** N/A — no fire-and-forget work.
- **R10** OK — C3 imports C2's exports one way; no back-edge.
- **R11** N/A.
- **R12** OK — no severity filter; C3 forbids one and C4 case 17 spans `low` and `critical`.
- **R13** N/A.
- **R14** N/A.
- **R15** N/A.
- **R16** OK — VE-1/VE-3/VE-4 name the parity gaps; I-5.6's probe is network-free. My own unauthenticated 60/h exhaustion confirms VE-3's hazard is real.
- **R17** OK — `collectScopes` and `semver.intersects` are both routed through the shared primitive.
- **R18** **Fires — F3.** C5's forbidden-pattern list is not synchronized with `maskRe`/`verifierLineRe`, the allowlists that decide it.
- **R19** OK — verified by grep that no existing disjointness case deep-equals a `byPackage` entry, so `pin`/`selfPins`/`parentKey` are additive; AC-2.2 adds the assertions Round 1's F7 asked for.
- **R20** N/A.
- **R21** N/A — no sub-agent work; I re-derived every number myself.
- **R22** OK — the plan treats `check-override-key-disjointness.mjs` as the established primitive and audits it rather than inverting it. F4 is a gap in the *derived* attribution, not a perspective inversion.
- **R23** N/A.
- **R24** N/A.
- **R25** N/A.
- **R26** N/A.
- **R27** N/A.
- **R28** N/A.
- **R29** **Fires — F7.** 306 and 7 unreproducible (measured 223 and 6). Everything else re-derived exact: 25/24/1/18, all six members with ids/severities/bands/floors, the canary band, 0 null-patch, 0 unreviewed, 0 truncated, `ci.yml:687/716/743`, `check-dockerfile-prisma-pin.sh:68`, `check-workflow-supply-chain.mjs:101-104`, 25 disjointness cases, the line-116 `"."` case, `vitest.config.ts` include/coverage scoping.
- **R30** OK — no autolink footguns.
- **R31** OK — AC-3.2 now runs against scratchpad copies via the argv form (`check-override-key-disjointness.mjs:260` confirms `main(argv)` exists), so Round 1's tracked-manifest mutation is retired.
- **R32** OK — AC-5.3 requires an observed `gh workflow run`.
- **R33** OK — seven workflow files enumerated; only `ci.yml` carries PR gate jobs; `dependency-signatures.yml` is the correct precedent for the sweep.
- **R34** OK — SC-A…SC-F each carry worst-case, likelihood, cost and an owner; SC-E/SC-F are costed rather than dropped.
- **R35** OK — VE-1/VE-4 and AC-5.3/AC-5.4 give the manual paths.
- **R36** **Fires — F1, F2, F3.** An input-shaped permanent green survives for 17 of 18 packages; four weakening forms are forbidden without a mechanism; the AC-3.3 reconciliation invites a markerless test-mode bypass.
- **R37** N/A.
- **R38** OK — SEC-F4's wedge was refuted by measurement; S5/S6 name two exits each and SC-E/SC-F record the revisit trigger.
- **R39** N/A — the only secret is `GITHUB_TOKEN`, used as a rate-limit credential and never logged (confirm the `::`-sanitizer never echoes headers).
- **R40** **Fires — F5.** The advisory document crosses a boundary into a strict consumer with shape validation specified but untested.
- **R41** **Fires — F2, F3.** "the canary … separates checked-and-clean from could-not-check" and "these patterns close the rest" are declared capabilities without a backing path.
- **R42** **Fires — F3, F5.** The member set of *weakening forms* is enumerated in C5 but only one member gets a mechanism; the member set of *new hardening mechanisms* is enumerated but only one gets a test. The pin/entry member set itself (25/24/1/18) is correct and I re-derived it independently.
- **R43** OK — floors move up only, no new keys (I-1.2, AC-1.5), no major crossed. C2/C7 widen two primitives; both audited above.
- **R44** **Fires — F3.** Executed: `|| true`, `| tee`, `set +e`, `--report` all pass `findMaskedVerifierViolations` even with `runsVerifier` forced true, and the runner default shell has no `pipefail`.
- **R45** OK — 18 sequential requests, linear; measured ~840 KB. `timeout-minutes: 5` and `AbortSignal.timeout` bound it (the latter untested — F5).
- **R46** **Fires — F4.** The `"."` self-pin is resolved by string position in a display path, not by the scope's parent binding.
- **R47** **Fires — F4.** `scopePath` is a display surface form being adjudicated for package identity; executed, a valid selector (`1.0.0 || > 2.0.0`) is a spelling that defeats it. The band-string side is fine: `semver.intersects` is the adjudicator and normalization is separator-only.
- **R48** OK — `npm audit`, Trivy, Dependabot and this gate are correctly distinguished; AC-3.0 retires the scratchpad twin. The S3 filter's two directions are now the only divergence, folded into F6.
- **R49** **Fires — F1, F2, F3.** Three claims stronger than their mechanisms. Control-class declarations elsewhere remain unusually honest (C1 "not a control", C3 "not an enforceable boundary", C5 "the scheduled half is detection", VE-5's corrected Trivy claim).
- **R50** **Fires — F1.** AC-3.3 cannot run as written; AC-7.1's fixture set omits the case the widened mechanism denies (gate + unrelated `continue-on-error`).
- **R51** **Fires — F3, F4.** C7's widening is bound to a literal invocation string, not to what the workflow runs; the self-pin's parent is bound to a name parsed out of a label.
- **R52** **Fires (audited, one latent item) — F4.** `collectScopes` audited directly: `pin`/`selfPins` are safe additions, but the scope opener's presence in `byPackage` and the absent parent back-link are latent and load-bearing for S1/S2. `check-workflow-supply-chain.mjs` audited directly: the widening does not regress existing files but reaches only one of five forms.
- **R53** OK, and extended — the gate lands at 0 members, no suppression list, no threshold. F2/F6 add a second measured-0 headroom (`AFFECTS_WITHOUT_MATCHING_BAND`) and F8 a third (`queue_step … bash -c`), all enrollable at zero cost today.
- **R54** **Fires — F1.** The AC-3.3 contradiction routes straight to an ambient-context suspension of the host pin and the canary. Enumerated ambient vectors and what the stated design actually stops: `GITHUB_API_URL` — **stopped** (explicit assertion); HTTP 3xx to another host — **stopped** (`redirect: "error"`); path/query injection from a manifest key — **stopped** (`encodeURIComponent`, verified `@babel/core` → `%40babel%2Fcore`); `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`npm_config_*_proxy` — **only appears stopped**: a URL host check cannot see a dispatcher, and Node ≥24 honours them under `NODE_USE_ENV_PROXY`/`--use-env-proxy` (confirmed present in this Node), so the plan must read those variables by name as a member set; `NODE_EXTRA_CA_CERTS` — **not stopped**, a MITM with a cert from the added root serves valid TLS for `api.github.com` and every stated check passes; `NODE_OPTIONS=--import`/`--require` patching `globalThis.fetch` or `setGlobalDispatcher` — **not stopped**, and defeats the canary too since a patched fetch can serve it; DNS/`/etc/hosts` — **stopped only by TLS**, i.e. not by anything in the plan, and jointly defeated with `NODE_EXTRA_CA_CERTS`.
- **R55** OK — resolved. `first_patched_version: null` is now a named branch (`NO_PATCH_AVAILABLE`, no floor in the message); `[]` no longer collides with green *globally* thanks to the canary — but still does *per package* (F2), which is the residual.
- **R56** N/A.
- **R57** OK — pagination is refused, not cursor-walked (S8); measured no `Link` header on any of the 18 at `per_page=100`, so the fail-closed form is silent-when-healthy for real. F9's authority question is the ordering-adjacent one and is answered fail-closed.
- **RS1** N/A — no credential comparison.
- **RS2** N/A — no new route.
- **RS3** **Fires — F5.** Shape validation is specified at the boundary and untested; a malformed field must not degrade to a skip.
- **RS4** OK — no PII in the plan or any proposed artifact; the recorded `lodash` fixture is public advisory data.
- **RS5** **Fires — F1, F2.** The advisory response is an untrusted externally-supplied security parameter. TLS to a public CA is the transport mitigation (so this stays Major, not Critical), but the canary's floor covers one of eighteen queries and `NODE_EXTRA_CA_CERTS`/`NODE_OPTIONS` defeat the transport leg entirely.
- **RS6** OK — the only transform is `/,\s*/g → " "`, single-pass, no escape sequences. The `::`-prefix sanitizer is new: case 18's allow side (band and summary with `<`, `>`, quotes round-tripping verbatim) is the right shape and must not be dropped.

---

```json
[
  {"id":"SEC-R2-F1","severity":"Major","title":"Host pin and canary make AC-3.3 unsatisfiable; every cheap reconciliation is a test-mode bypass of the control","file":"docs/archive/review/stale-override-floors-plan.md","line":534,"adjacent":false,"escalate":false},
  {"id":"SEC-R2-F2","severity":"Major","title":"Single-package canary is not a positive control over 18 queries (API returns 200 [] for unknown/malformed affects); byte-exact band on a live-revised advisory; no C4 case and no mutation row","file":"docs/archive/review/stale-override-floors-plan.md","line":297,"adjacent":false,"escalate":false},
  {"id":"SEC-R2-F3","severity":"Major","title":"C7 enforces only continue-on-error; || true, | tee, set +e and --report remain unenforced (executed) and the runner shell has no pipefail","file":"scripts/checks/check-workflow-supply-chain.mjs","line":101,"adjacent":false,"escalate":false},
  {"id":"SEC-R2-F4","severity":"Major","title":"S2 attributes '.' self-pins by backward-parsing scopePath; a valid selector ('pkg@1.0.0 || > 2.0.0') mis-attributes and the API returns 200 [] for the wrong name","file":"docs/archive/review/stale-override-floors-plan.md","line":431,"adjacent":false,"escalate":false},
  {"id":"SEC-R2-F5","severity":"Minor","title":"Response-shape validation, Map-keyed caches and AbortSignal.timeout ship with no C4 case and no AC-4.3 mutation row","file":"docs/archive/review/stale-override-floors-plan.md","line":306,"adjacent":false,"escalate":false},
  {"id":"SEC-R2-F6","severity":"Minor","title":"S3's exact-name filter has no over-drop detector; only its fail-closed direction is named (measured 0 violations today = free headroom)","file":"docs/archive/review/stale-override-floors-plan.md","line":196,"adjacent":false,"escalate":false},
  {"id":"SEC-R2-F7","severity":"Minor","title":"Census figures 306 live entries and 7 withdrawn are not reproducible (measured 223 and 6); the conclusions they support are","file":"docs/archive/review/stale-override-floors-plan.md","line":122,"adjacent":false,"escalate":false},
  {"id":"SEC-R2-F8","severity":"Minor","title":"Gate-selftest meta-gate anchors on run_step ... bash -c while pre-pr.sh's dominant idiom is queue_step (47 vs 13); C5's new step would evade it","file":"scripts/checks/check-gate-selftest-coverage.sh","line":170,"adjacent":true,"escalate":false},
  {"id":"SEC-R2-F9","severity":"Minor","title":"S4 counts withdrawn advisories without naming them and never states which run's verdict is authoritative","file":"docs/archive/review/stale-override-floors-plan.md","line":197,"adjacent":false,"escalate":false}
]
```
agentId: a0b5e45ad93f26f6e (use SendMessage with to: 'a0b5e45ad93f26f6e', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 168237
tool_uses: 28
duration_ms: 995329</usage>

### Testing expert — round 2

I have what I need. Writing the review artifact.

## Findings

### TEST-F14 — Severity: Critical — DESIGN — AC-3.3 cannot execute: the host pin forbids reaching the local fixture server, so the network shell remains untested

**Problem.** AC-3.3 (`stale-override-floors-plan.md:533-536`) is the single criterion that retires Round-1's TEST-F3 ("the shell is untested"). It drives the gate **as a process** against a local `http.createServer`. But the same plan's network-shell hardening (`:302-305`) requires the shell to `assert new URL(endpoint).host === "api.github.com"` and `protocol === "https:"`, and to "refuse if `GITHUB_API_URL` or a proxy env points elsewhere". Five of AC-3.3's six cases (403, 500×3, 500-then-200, non-JSON, connection refused) require the process to actually talk to `127.0.0.1`. The sixth case *is* the host pin. The two halves of AC-3.3 contradict each other and the plan names no mechanism that resolves it.

The repo's only precedent for pointing production code at a local advisory-shaped server is `src/__tests__/db-integration/audit-anchor-github-release-destination.integration.test.ts:157-164`, which **string-replaces the hard-coded host in the module source and imports the patched copy** — an in-process technique that is unavailable to a `spawnSync`'d process. The three remaining options are each a defect: a scratchpad copy of the gate with the host string rewritten makes the tested artifact a twin of the shipped one and does not exercise the pin (RT9); an env base-URL override is precisely the ambient-context suspension surface (R54) the pin exists to close; and pointing DNS at localhost is not a repeatable test.

A second unstated precondition sits inside the same criterion: "500 then 200 → exit **0**" is unreachable unless the fixture server's 200 also satisfies the canary — the shell refuses with `ADVISORY_SOURCE_CANARY_FAILED` unless a `brace-expansion` query returns `GHSA-rgw5-rvv9-x895` with band `>= 4.0.0, < 5.0.9` (`:298-301`). Nothing says the fixture serves it, so as written that case reds for the wrong reason. There is no case for the canary itself anywhere in C4 or AC-3.3, despite scenario 5 (`:835-838`) describing it as the control that separates "checked and clean" from "could not check".

**Impact.** `fetchAdvisories`, `main`, the retry/timeout policy, the canary, the exit path and `--report`'s exit semantics are reachable by no executable test. Round-1's TEST-F3 is marked RESOLVED on the strength of a criterion that cannot be run, which is worse than leaving it open: the next round will not re-check it.

**Recommended action.** Add a single, named test seam to the shell and make the pin a property of the seam rather than of the fetch call: export `advisoryEndpoint(pkg, base = "https://api.github.com")` and have `main` pass the base from a constant, never from the environment; AC-3.3 then spawns the gate with the base supplied as an **argv** flag (`--advisory-base`) that `main` accepts only when `process.env.NODE_ENV !== "production"` is *not* the guard — instead have the flag itself be the thing the host pin judges, so a `--advisory-base` pointing at `http://127.0.0.1:<port>` is accepted while `GITHUB_API_URL`/proxy env is still refused unconditionally. (1) **Allow side that must still succeed**: the existing default path — no flag, endpoint resolves to `https://api.github.com`, and the six AC-3.3 process cases run against the flagged base. (2) **Red-prove each clause separately**: delete the `protocol === "https:"` assertion → a `--advisory-base http://…` case that must be *refused* when the env-var form is used reds; delete the `GITHUB_API_URL`-refusal clause → the "points elsewhere → exit 1 before any request" case reds; delete the canary → a new fixture case serving `[]` for `brace-expansion` with a stale floor present must red. (3) **Neither-pass-nor-fail outcomes**: the fixture server failing to bind → `AC33_FIXTURE_UNAVAILABLE`; the spawned process producing no exit code within the harness timeout → `AC33_TIMEOUT`; a case that exits 1 with a token other than the one named → `AC33_WRONG_TOKEN`, never a bare "exit 1 as expected". (4) Do not resolve this by deleting the host pin or by dropping AC-3.3 to a YAML-shape assertion — the pin is the control and AC-3.3 is the only thing that reaches the shell. (5) **Boundary and tie**: the boundary is "endpoint origin supplied by an explicit argument" vs "endpoint origin supplied by ambient environment"; the tie is a `--advisory-base` that names `api.github.com` over plain `http:` — it must be refused, because protocol and host are separate clauses.

---

### TEST-F15 — Severity: Major — DESIGN — AC-4.3's first mutation row names the side of case 6 that stays green, reproducing the exact Round-1 defect the row was rewritten to fix

**Problem.** Executed:

```
intersects("^2.1.4", ">= 2.0.0, < 2.1.4") -> THROW: Invalid comparator: >=2.0.0,
intersects("^2.1.3", ">= 2.0.0, < 2.1.4") -> THROW: Invalid comparator: >=2.0.0,
```

Both halves of case 6 throw when `normalizeBand` is deleted. Since I-3.2 makes a throw a violation, only the half whose expectation is `[]` can red. Case 6's row (`:568`) puts the `[]` expectation (`^2.1.4`) in the column headed **Deny** and the violation expectation (`^2.1.3`, "exactly one violation naming the GHSA id") in the column headed **Paired allow**. AC-4.3's first row (`:606`) then says the mutation must red "case 6 **allow** side" — which resolves, by the table's own headers, to the `^2.1.3` half. Under the mutation that half still yields exactly one violation and the row still carries the advisory, so the GHSA id still appears and the assertion still passes.

The prose at `:280-284` gets it right ("The case is therefore a pin that does **not** intersect a comma band, expecting `[]`"). The table and the mutation row do not. Round 1 rejected revision 1 for a `normalizeBand` mutation that "could not red anything"; the corrected artifact hands the implementer the same instruction with one word of ambiguity between it and the correct one.

**Impact.** The regression proof for trap 1 — the bug that made the first derivation report 21 of 21 entries as members — is the single most load-bearing red-proof in the plan, and an implementer following AC-4.3 literally will record it as passing while it proves nothing.

**Recommended action.** Stop naming sides by the words "deny" and "allow" in AC-4.3 and name the **expectation**: "delete `normalizeBand`'s replacement → the case-6 half asserting `[]` for `^2.1.4` against `">= 2.0.0, < 2.1.4"` must red". (1) **Allow side**: the `^2.1.3` half must still report exactly one violation naming `GHSA-rgw5-rvv9-x895` *after* the normalizer is restored — that is what proves the normalizer did not simply suppress the band. (2) **Red-prove**: run the mutation and assert the `[]` half fails **and** record the failure message; a run where both halves pass is `MUTATION_INEFFECTIVE`. (3) The neither-pass-nor-fail outcome here is a *load* failure (deleting the replacement leaves a syntax error) — already routed to `MUTATION_INCONCLUSIVE` at `:623`; keep it and require the mutation be an expression edit (`.replace(/,\s*/g," ")` → `.replace(/,\s*/g,",")`), not a deletion, so it always loads. (4) Do not fix by making a throw a non-violation — that would delete the fail-closed property. (5) **Boundary and tie**: the boundary is between "the band was mis-parsed" and "the band was not parsed at all"; the tie is a band that is *both* comma-separated and non-intersecting after normalization — that is case 6's `[]` half and it is the only cell where the two are distinguishable.

---

### TEST-F16 — Severity: Major — DESIGN — Four of the thirteen mutation rows point at something that cannot observe them

**Problem.** Walking all 13 rows of AC-4.3 (`:605-620`):

- **"map `undecidable` to exit 0 → cases 15, 16"**. Cases 15 and 16 are pure-core cases: case 15 asserts `findStaleFloors` returns a row with `status: "undecidable"` for `{ok:false}` and `clean` for `{ok:true, advisories:[]}`. Exit-code mapping lives in `main` (I-3.5). Neither case observes an exit code, so both stay green under this mutation. The only place it could red is a process-level test — AC-3.3, which cannot run (TEST-F14).
- **"make `formatReport` filter to violations only → AC-3.4"**. AC-3.4 runs against the live tree and the live advisory API. VE-2 states the verdict at time T is not reproducible at T+n by construction, so this row makes a deterministic mutation proof depend on a non-deterministic instrument, and it is not a C4 case at all.
- **"make `--report` exit 1 on a clean tree → the runbook case"**. There is no numbered case called "the runbook case". Consumer 5 (`:506-510`) describes the requirement; no C4 row implements it.
- **"change the S3 filter to `startsWith` → case 12 deny row"**. This can only red if the foreign band's package name is a prefix-extension of the subject. Case 12 (`:574`) does not name its foreign package. Executed: `"lodash-es".startsWith("lodash")` → **true** (the row reds), `"@hono/node-server".startsWith("hono")` → **false** (the row does not red). The plan's own justification for the `startsWith\(pkg` forbidden pattern at `:489-490` cites the `hono` / `@hono/node-server` pair — the pair on which `startsWith` is harmless. If the implementer builds case 12 from the plan's stated example, the mutation row is unsatisfiable.

**Impact.** Four of thirteen clauses are recorded as red-proven while nothing can red them. Two of them (`undecidable` → exit 0, `--report` exit semantics) are the fail-closed clauses N5 and I-3.5 exist to protect.

**Recommended action.** Re-point each row at a case that can observe it. Add three process-level cases to the C4 file using `spawnSync` on the gate with an injected advisory map (the house pattern at `scripts/__tests__/check-gate-selftest-coverage.test.mjs`), asserting exit code and stdout: `undecidable → exit 1`, `--report` on a stale tree → exit 1 **and** the full table, `--report` on a clean tree → exit **0** and the full table. Pin case 12's foreign package to `lodash-es` explicitly and correct `:489`'s justification to that pair. (1) **Allow side**: `--report` on a clean tree must still print every non-member row and every scope opener — that is Consumer 5's contract and the case a "filter to violations only" mutation must red. (2) **Red-prove each clause**: four mutations, four named cases, run separately. (3) A mutation whose case neither passes nor fails (process killed, no output) is `MUTATION_INCONCLUSIVE`. (4) Do not satisfy this by deleting rows from the mutation table. (5) **Boundary and tie**: the boundary is `--report`'s two jobs — enumerate (always) and adjudicate (exit code); the tie is a clean tree under `--report`, where the two jobs disagree about what "success" prints.

---

### TEST-F17 — Severity: Major — DESIGN — The `max(first_patched_version)` rule has no deterministic case and no mutation row; every C4 pair is single-band

**Problem.** The required floor is defined as `max(first_patched_version)` over the intersecting set (`:142-145`) — the rule that makes M3 and M6 both land on 8.5.23 despite carrying different band sets, and the rule the plan calls out as revision 1's error. Every one of the 18 C4 pairs uses a single advisory with a single band. The only two-band instances in the repo are M3 and M6, and they are exercised only by AC-3.0 and AC-3.4, both of which run against the live advisory API, which VE-2 declares non-reproducible. No mutation row targets the aggregation.

An implementation that takes the **first** intersecting band's floor, or the **min**, is green across all 18 C4 pairs, green at AC-3.1 (post-C1 exit 0), and green at AC-4.1. It reds only at AC-3.0 — a one-shot manual run against data that will have drifted by the time anyone re-checks.

Other decision clauses with no mutation row: judging the **pin** rather than the **selector** (Consumer 3 at `:430-433` names it as a clause explicitly — "a selector may legitimately name a vulnerable window"; case 3's allow happens to cover it, since executed `intersects("1", "<1.1.18")` → `true` means the allow reds if the selector is judged, but no row claims this and a later edit to case 3 would silently retire it); `EMPTY_SCOPE` classification by children-yielded rather than by `typeof` (case 10); `PIN_NOT_A_RANGE` (case 11); `NO_PATCH_AVAILABLE` (case 14); the `::` sanitizer and its non-over-reach (case 18); the canary.

**Impact.** The aggregation rule is the one place a wrong answer sends the operator to raise a floor that does not clear the band — a violation that names the right package and an insufficient floor, which is the failure mode F2 was raised against in Round 1 and which AC-3.1 will then confirm as "fixed".

**Recommended action.** Add case 19: one pin intersecting **two** bands of the same package with floors `8.5.18` and `8.5.23` (M3's shape, as injected fixture data, not live) → exactly one violation naming **both** GHSA ids and the floor `8.5.23`. Paired allow: the same two bands against pin `>=8.5.23` → `[]`. Add mutation rows: `max` → `min` (must red case 19's violation half on the floor assertion, not on the count), and `max over intersecting` → `first` (same). Add the six missing rows named above, each naming a case that asserts the token. (1) **Allow side**: case 19's `[]` half must still pass under the correct `max`, so the aggregation cannot be "fixed" by always reporting the highest floor in the whole advisory list regardless of intersection. (2) **Red-prove**: eight mutations, eight named cases, separately. (3) A case whose violation count is right but whose floor string is absent is `AC43_ASSERTION_TOO_WEAK`, not a pass — I-4.2 already forbids length-only assertions; extend it to forbid count-only assertions on multi-band rows. (4) Do not drop the two-band case because M3/M6 are cleared by C1 — clearing them is what removes the live instance and makes the fixture the only remaining witness. (5) **Boundary and tie**: the boundary is between one band and several; the tie is two intersecting bands whose floors differ by one patch version, where `first`, `min` and `max` all return a *plausible* version.

---

### TEST-F18 — Severity: Major — DESIGN — Case 17's allow side is vacuous for the invariant it claims to prove

**Problem.** Case 17 (`:579`): deny = a `low`-severity advisory **intersecting** → violation. Allow = a `critical`-severity advisory **not intersecting** → `[]`. The plan claims this "Proves the no-filter invariant across the real enum, not one member of it".

It does not. The allow changes two axes at once (severity *and* intersection), so it passes under **every** severity filter — including `if (severity !== "low") continue`, which would drop `critical` outright. The only mutation the pair can red is on the deny side (`if (severity !== "high") continue` → the `low` deny returns `[]`). A filter that drops `critical` — the strictly worse bug — is invisible to both halves.

**Impact.** RT10's purpose is to prove the guard does not over-block; here the allow is passing for a reason unrelated to the invariant. The plan's own stated rationale for case 17 is therefore false, and a reviewer reading the table has no way to see it without re-deriving the truth table.

**Recommended action.** Split case 17 into two pairs on one axis each. Pair 17a: `low` intersecting → violation / `low` **not** intersecting → `[]`. Pair 17b: `critical` **intersecting** → violation / `critical` not intersecting → `[]`. (1) **Allow side that must still succeed**: both non-intersecting halves — the gate must not red on a `critical` advisory that does not touch the pin, which is the over-block that gets a repo-wide PR gate switched off (I-5.3 makes this gate red every PR). (2) **Red-prove**: two mutations — `if (severity !== "high") continue` must red 17a's violation half; `if (severity === "critical") continue` must red 17b's violation half. Neither is red-able by the current single pair. (3) A case where the severity string in the fixture is outside `low|medium|high|critical` must route to `ADVISORY_FIELD_MALFORMED`, not to a silently-unfiltered pass — add it as a third row. (4) Do not merge the four rows back into two for brevity; the axis separation is the whole content. (5) **Boundary and tie**: the boundary is the severity enum's ends (`low` and `critical`); the tie is `medium` — the severity of M1, the member `--omit=dev --audit-level=high` already hides, and the one value a reviewer is most likely to assume is covered because it appears in the member table.

---

### TEST-F19 — Severity: Major — DESIGN — Truncation, shape validation and the report path are still declared in the shell and asserted in the core; three C4 cases are unwritable against the C3 signature block

**Problem.** Round 1's TEST-F1/F3 were closed by moving the transform into `extractBands`. Three clauses did not move with it:

- **Truncation.** `advisoriesByPackage` is `Map<string, {ok, advisories, reason}>` (`:255`). There is no truncation field. Case 16 (`:578`) asserts "truncated list flag → `ADVISORY_LIST_TRUNCATED`" and its allow asserts that a `Link` header carrying `rel="prev"`/`rel="last"` but no `rel="next"` yields `[]` — a header-parsing assertion. No `Link` parser is exported, and the Map cannot carry the flag.
- **Shape validation.** `ADVISORY_RESPONSE_SHAPE` / `ADVISORY_FIELD_MALFORMED`, the `ghsa_id` regex, the severity enum check and the "each band a string" check are all specified under "Shape validation at the boundary" (`:306-309`) — the shell. Case 18's second half (`ghsa_id: "../../x"` → refusal) therefore cannot be driven through `extractBands`.
- **`formatReport`.** RT5 walk of C3's signature block (`:231-247`): `collectOverridePins` ✓ (cases 7–11), `normalizeBand` ✓ (case 6, indirect), `resolveRefPin` ✓ (case 7), `extractBands` ✓ (12, 13, 14, 17, fixture), `findStaleFloors` ✓ (all), `formatViolations` ✓ (case 18). **`formatReport` is reached by no fixture-driven case** — case 10's allow mentions "the parent reported as `scope`", which is a row `kind`, not the report; the only criteria that exercise it are AC-3.0 and AC-3.4, both live-data. `fetchAdvisories` and `main` are reached only by AC-3.3, which cannot run (TEST-F14).

**Impact.** The plan's Testing-strategy section claims "every transform, filter and predicate is in a pure exported function the self-test drives". Three of them are not, and the three C4 cases written against them will be quietly reshaped by the implementer into something the signature does support — which is how revision 1's twelve green cases coexisted with a wrong transform.

**Recommended action.** Widen the map value to `{ok, advisories, truncated, reason}` and export `parseLinkHeader(header) -> {hasNext: boolean}` and `validateAdvisoryShape(raw) -> {ok:true} | {ok:false, token}` from the pure core; have `fetchAdvisories` call the validator rather than own the rules. Then case 16, case 18's `ghsa_id` half, and the severity-enum row of TEST-F18 all become writable. Add a `formatReport` case: a fixture set containing one stale row, one clean row, one scope opener and one withdrawn-skipped advisory → the report string must contain all four, and the violation list must contain only the first. (1) **Allow side**: `parseLinkHeader('<…>; rel="prev", <…>; rel="last"')` → `hasNext: false`; the plan already identifies that a substring test for `"next"` false-reds it, so that assertion must be in the case. (2) **Red-prove**: replace `parseLinkHeader` with `/next/.test(header)` → the `rel="prev"`/`rel="last"` allow reds; delete the `truncated` propagation → case 16's deny reds; delete the `ghsa_id` regex → case 18's refusal half reds; make `formatReport` filter to violations → the new report case reds. (3) A map entry with `ok:true` and `truncated:undefined` (an older shape) must route to `ADVISORY_RESULT_SHAPE`, never be read as `false`. (4) Do not close this by deleting cases 16 and 18 as "shell concerns" — the shell is where Round 1 found the untested transform. (5) **Boundary and tie**: the boundary is between a *complete* empty list and a *truncated* one; the tie is `advisories: []` with `truncated: true`, which must deny even though the list looks clean.

---

### TEST-F20 — Severity: Major — DESIGN — I-2.2 declares that C3 gains no silent pass for an unparseable selector, and nothing tests it; `unparseable` entries carry no `pin` and no consumer reads them

**Problem.** I-2.2 (`:418-420`): "Keys whose selector `semver` cannot parse continue to land in `unparseable`, not `byPackage` — C3 must not gain a silent pass for a key the disjointness gate deliberately rejects." C2 adds `pin` to `byPackage` entries only (`:398-402`); `unparseable` stays `Array<{key, range}>`. Consumer 3 (`:430-435`) reads `byPackage`, `selfPins` and `depth` — never `unparseable`. `collectOverridePins`'s `kind` enum (`:233-235`) has no token for it.

So `{"pkg@latest": "1.0.0"}` yields a pin the floor gate never sees and cannot see, because the field it would need is not on the record. AC-2.2 tests only the C2 half (`collectScopes` routes the key to `unparseable`); no C4 case and no mutation row tests the C3 half. R50: I-2.2 would not fail if it were false.

The mitigation is real and should be stated rather than left implicit: `findOverlappingKeys` reds on such a key (verified at `check-override-key-disjointness.mjs:131-135`, pinned by the existing case at `check-override-key-disjointness.test.mjs:106-113`), so the tree cannot be green with one present. But that makes I-2.2 a claim about a *second* gate's behavior, not about C3's, and the plan words it as C3's.

**Impact.** An invariant stated as enforced is enforced by accident, in another file, for a different reason. If the disjointness gate's `unparseable` reporting is ever narrowed — the plan itself is editing that function in the same PR — the floor gate silently loses a pin form with nothing in the diff to review.

**Recommended action.** Either (a) reword I-2.2 to say the coverage is delegated to `check-override-key-disjointness.mjs` and add AC-1.5 as its enforcement, or (b) add `pin` to `unparseable` entries and an `UNPARSEABLE_SELECTOR` kind, with C4 case 20: `{"pkg@latest": "1.0.0"}` against an intersecting band → violation naming the key and the token. (b) is the smaller surprise, since (a) leaves a cross-gate dependency with no test. (1) **Allow side**: `{"pkg@1": "1.0.0"}` — a parseable selector on the same fixture — must still be judged normally and produce exactly one violation, so the new branch cannot be satisfied by routing everything to the refusal. (2) **Red-prove**: delete the `UNPARSEABLE_SELECTOR` branch → case 20 reds; delete the `pin` addition to `unparseable` → case 20 reds on the pin value, not on the count. (3) An entry present in `unparseable` with `pin === undefined` is `UNPARSEABLE_ENTRY_SHAPE`, never skipped. (4) Do not resolve it by moving unparseable-selector keys into `byPackage` — I-2.3 and the existing case at line 116 depend on the current routing. (5) **Boundary and tie**: the boundary is between a selector `semver` rejects and a *pin* `semver` rejects (case 11's `PIN_NOT_A_RANGE`); the tie is `{"pkg@latest": "latest"}`, where both are unparseable and the gate must name the selector refusal first or it will report the wrong remedy.

---

### TEST-F21 — Severity: Major — DESIGN — AC-3.0 names no source for the pre-C1 manifests, is ordered after C1, and the argv form it cites cannot carry `--report`

**Problem.** AC-3.0 (`:513-516`) is what retires the scratchpad derivation (RT9). It requires `--report` "run against the manifests **as they are before C1**". Three things block it:

1. **Ordering.** The Go/No-Go table (`:753-761`) lists C1 first and C3 third. By the time the gate exists, the tracked manifests are post-C1 and the member set is empty by construction (I-3.6). Recovering the pre-C1 content requires `git show <base>:package.json` into scratchpad — a step the plan specifies for AC-3.2 (`:519-522`) and not for AC-3.0.
2. **Argv form.** AC-3.2 cites `check-override-key-disjointness.mjs:260` as the entry-point precedent. That line is `main(process.argv.length > 2 ? process.argv.slice(2) : undefined)` — **every** argv element becomes a manifest path. Under that form `--report` is read as a manifest path, and `readFileSync("--report")` throws `ENOENT`, which the sibling's `main` swallows with `continue`. The new gate needs flag/path separation and the plan does not say so; AC-3.2 and AC-3.0 both depend on it.
3. **Verifiability.** As worded, a run against post-C1 manifests reporting zero members is indistinguishable from a satisfied AC-3.0 for anyone re-checking, because the criterion states no command and no input provenance.

**Impact.** The single criterion that closes RT9 — the scratchpad twin whose two bugs produced revision 1's wrong numbers — is the one criterion in the plan with no reproducible command beside it, in a document whose opening paragraph says "Every number in this document is produced by executing a command that is written beside it".

**Recommended action.** Write AC-3.0 as an executed command against scratchpad copies restored from git, and move it to a stated position in the sequence: implement C2+C3+C4 before C1, or restore with `git show`. Specify argv parsing: flags are the argv elements beginning `--`; manifest paths are the rest; an argv element beginning `-` that is not a recognised flag is `UNKNOWN_FLAG`, refused, never treated as a path. (1) **Allow side**: `--report` with no path arguments must still fall back to `discoverManifests()` and report on the real tree — the runbook's invocation (Consumer 5) and the only form the operator types. (2) **Red-prove**: pass an unknown flag → `UNKNOWN_FLAG` refusal (assert the token, not just exit 1); pass a nonexistent manifest path → `MANIFEST_UNPARSEABLE`/`ENOENT` refusal rather than the sibling's silent `continue`, since a mistyped scratchpad path is exactly how AC-3.0 would report "0 members" from an empty walk. (3) Neither-pass-nor-fail: a `--report` run that yields **zero rows of any kind** is `EMPTY_WALK`, a refusal — an empty report is the shape both a correct clean tree and a broken invocation produce. (4) Do not satisfy AC-3.0 by re-running the scratchpad script; that is the twin. (5) **Boundary and tie**: the boundary is pre-C1 vs post-C1 manifest content; the tie is `cli/package.json`, whose pre-C1 pin `>=8.5.10` and post-C1 pin `>=8.5.23` differ only in the member set they produce, so a run against the wrong copy is silent.

---

### TEST-F22 — Severity: Major — DESIGN — The `GH_TOKEN` precondition is stated on one criterion while the whole acceptance suite needs it; the verification host is rate-limited today

**Problem.** VE-3 (`:35-38`) and AC-3.2 (`:519-522`) state the token precondition for the revert loop only, and still cost it at "six reverts × 18 packages ≈ 108 requests" although AC-3.2 was extended to **eight** reverts (`:527-531`) — ≈144. Every other network-touching criterion is silent: AC-1.1, AC-3.0, AC-3.1, AC-3.4, AC-5.4 (run twice) and AC-6.2 each drive a full 18-request sweep, ≈126 requests before AC-3.2 starts.

Executed on this host just now, unauthenticated:

```
GET https://api.github.com/advisories?ecosystem=npm&affects=lodash&per_page=100
HTTP/2 403  — "API rate limit exceeded for 217.178.26.68"
```

The 60/h budget is already exhausted. Under that condition the gate exits 1 with `RATE_LIMITED` (correctly), and every criterion that expects exit 0 — AC-1.1, AC-3.1, AC-3.4 — reds for a reason unrelated to the tree, which is precisely the hazard I-5.4 (`:656-659`) was written about for CI and not carried over to local verification.

**Impact.** R50/R16: the acceptance suite cannot be executed on the designated verification host (VE-4, `mrx33`) without a token, and only one of eight criteria says so. A verifier who runs the suite and sees reds has no stated way to distinguish "stale floor" from "budget exhausted", and the cheapest resolution under time pressure is to record the criteria as blocked.

**Recommended action.** Promote the token to a suite-level precondition in VE-3, correct the AC-3.2 arithmetic to eight reverts, and give the total: ≈270 requests, versus 5000/h authenticated. Add a preflight to the verification sequence that refuses with `ACSUITE_PRECONDITION` when no token is present, rather than letting each criterion red individually. (1) **Allow side**: the gate itself must still be runnable and correct **without** a token — scenario 4 (`:830-834`) depends on the unauthenticated path producing `RATE_LIMITED`, so the preflight belongs to the acceptance suite, not to the gate. (2) **Red-prove**: unset both token vars → the preflight refuses and names `ACSUITE_PRECONDITION`; set a token → the suite proceeds. Separately, unset the tokens and run the gate directly → exit 1 with the rate-limit token, which is AC-3.3's 403 case and must not be conflated with the preflight. (3) Neither-pass-nor-fail: a token that is present but invalid returns 401, which the plan does not retry and does not name — route it to `ADVISORY_AUTH_REJECTED`, distinct from `RATE_LIMITED`, or a stale token reads as a budget problem. (4) Do not reduce the request count by caching advisory responses across criteria — that would make AC-3.2's eight reverts share one snapshot and hide a per-package query bug. (5) **Boundary and tie**: the boundary is the 60/h anonymous budget against ≈270 requests; the tie is a partially-consumed budget, where the first few criteria pass and a later one reds — the state this host is in right now.

---

### TEST-F23 — Severity: Major — DESIGN — S1's `EMPTY_SCOPE` and S2's self-pin assign different verdicts to the same input, and case 11 asserts a token the walker cannot produce for two of its three inputs

**Problem.** Two executed collisions in the S1/S2/case-10/case-11 area:

**(a) A scope containing only a `"."`.** Executed against the real `collectScopes`:

```
collectScopes({parent: {".": "1.2.3"}})
  -> [{scopePath:"overrides > parent", depth:1, byPackage keys: []}, {scopePath:"overrides", depth:0, keys:["parent"]}]
```

The nested scope yields **zero** `byPackage` entries. S1 (`:194`) says "A scope that yielded **no** child pins is `EMPTY_SCOPE` — a violation". S2 (`:195`) says the `"."` is a judged self-pin. Case 10's deny is `{"parent": {}}` → `EMPTY_SCOPE`; case 9's deny is a `"."` self-pin → judged. The two inputs are indistinguishable to the "children yielded" test unless `selfPins` is defined to count as children, which the plan does not say. Scenario 6 (`:839-842`) writes `{".": "^2.7.1", ...}` **with siblings** and dodges the cell; a scope that pins only its parent is the minimal legitimate spelling of exactly the case S2 was added for.

**(b) Array-valued pins.** Case 11 (`:573`) asserts `{"pkg": 1}` / `null` / `[]` → `PIN_NOT_A_RANGE`. Executed:

```
{pkg: 1}         -> byPackage["pkg"], pin 1        (PIN_NOT_A_RANGE — correct)
{pkg: null}      -> byPackage["pkg"], pin null     (PIN_NOT_A_RANGE — correct)
{pkg: []}        -> RECURSES (typeof [] === "object"), nested scope with 0 keys  -> EMPTY_SCOPE, not PIN_NOT_A_RANGE
{pkg: ["1.0.0"]} -> RECURSES, nested scope with a child package literally named "0", pin "1.0.0"
```

`[]` lands on case 10's token, not case 11's. `["1.0.0"]` is worse: it synthesises a package name `"0"` that passes `splitOverrideKey`/`validRange` and would then be sent to the advisory API as a live query — [Adjacent] Severity: Minor: a manifest-controlled string reaching an outbound URL, which may overlap with the Security reviewer's scope on the `encodeURIComponent`/host-pin surface.

**Impact.** Two C4 cases assert tokens the specified walker does not produce for the inputs they name. An implementer will resolve the collision by inventing a rule — the exact failure mode the "Semantic decisions" table (`:188-190`) exists to prevent — and whichever rule they invent, one of the two cases has to be edited to match, which retires it as evidence.

**Recommended action.** Lock the precedence explicitly in S1: a scope's "children yielded" count is `byPackage` entries **plus** `selfPins` entries, so `{parent: {".": "1.2.3"}}` is a judged self-pin and `{parent: {}}` is `EMPTY_SCOPE`. Lock array handling in S1 or S2: an array-valued override is `PIN_NOT_A_RANGE` and is **not** recursed, since npm's grammar has no array form — which requires the recursion guard to be `typeof value === "object" && !Array.isArray(value)`. (1) **Allow side**: `{parent: {".": "1.2.3", "child": "^1.0.0"}}` — scenario 6's real shape — must still yield one self-pin and one child pin and no `EMPTY_SCOPE`, so the precedence fix cannot be made by suppressing `EMPTY_SCOPE` generally. (2) **Red-prove**: remove `selfPins` from the children count → the `{parent:{".":…}}` case reds with `EMPTY_SCOPE`; remove the `!Array.isArray` guard → the `{pkg: ["1.0.0"]}` case reds by producing a package named `"0"` (assert on the produced name, not on the count). (3) Neither-pass-nor-fail: a derived package name that does not match npm's name grammar is `PACKAGE_NAME_UNRECOGNISED` and is refused **before** any query is issued, so the phantom `"0"` never becomes a request. (4) Do not close the array case by widening `PIN_NOT_A_RANGE` to swallow objects too — that erases S1's distinction between a scope opener and a bad pin, which case 10 exists to prove. (5) **Boundary and tie**: the boundary is between "value is a scope" and "value is a pin"; the tie is the empty object `{}` — a scope with no children under S1 and a non-range under case 11 — and the plan currently assigns it to both.

---

### TEST-F25 — Severity: Major — DESIGN — C7 widens the wrong half of the check: four of C5's five forbidden weakening forms still have no mechanism

**Problem.** C7 (`:717-749`) exists because C5's `continue-on-error: true` prohibition had no backing check, and its remedy is "widen `runsVerifier` to also match `check-override-floor-staleness`". Verified against `scripts/checks/check-workflow-supply-chain.mjs`: `findMaskedVerifierViolations` uses **two** anchors —

```js
const verifierLineRe = /audit\s+signatures|dist\??\.attestations/;
const runsVerifier = /audit\s+signatures/.test(content) || (/npm\s+view/.test(content) && /attestations/.test(content));
```

`runsVerifier` backs the `continue-on-error` rule only. The mask rule (`|| true`, `; true`, `|| exit 0`, `|| :`, `|| echo`) is gated on `verifierLineRe` matching the **line**. C5 forbids five forms (`:670-677`): `continue-on-error: true`, `|| true`, `set +e`, `--report` in a `run:`, and a pipe after the gate invocation. C7 widens only `runsVerifier`, so a line reading `node scripts/checks/check-override-floor-staleness.mjs || true` matches neither anchor and is not flagged. AC-7.1's three fixtures are all `continue-on-error`. `set +e` and the trailing-pipe form are not checked by this gate at all, for any workflow.

Two supporting observations: `ci.yml` already contains `audit signatures` (verified: `.github/workflows/{ci,release,dependency-signatures}.yml`), so C7's widening is a no-op for the PR job and matters only for the new standalone workflow; and no workflow in the repo currently sets `continue-on-error` (verified), so the deny fixture is the only witness AC-7.2's revert mutation has.

**Impact.** C7's stated purpose — "a forbidden pattern that is a plan-level grep only … the same 'a remembered rule is not a control' failure this whole plan exists to correct, reproduced inside the correction" — is satisfied for one of five forms and left unsatisfied for four, inside the contract written to close it.

**Recommended action.** Widen `verifierLineRe` as well as `runsVerifier`, and add `set\s+\+e` and a post-invocation `|` to the mask regex for verifier lines. AC-7.1 gains four deny fixtures (one per newly-covered form) and four paired allows. (1) **Allow side that must still succeed**: the new workflow's *unmasked* invocation (`- run: node scripts/checks/check-override-floor-staleness.mjs`) must yield `[]`, and a workflow running no verifier must keep `|| true` on an unrelated step — I-7.2's property, which widening `verifierLineRe` (a per-line test) preserves and widening it to a bare filename match would not. (2) **Red-prove each clause separately**: five mutations, five named fixtures — revert each added alternation one at a time and confirm only its own deny fixture reds. (3) Neither-pass-nor-fail: a workflow file the splitter cannot parse into jobs must be reported, not skipped; and a fixture asserting "no violations" that happens to contain no verifier line at all is `FIXTURE_VACUOUS` — assert the fixture matches `verifierLineRe` before asserting it produces `[]`. (4) Do not achieve coverage by making the mask rule repo-wide — I-7.2 exists because that would ban `continue-on-error` on unrelated steps. (5) **Boundary and tie**: the boundary is a workflow that runs the new gate versus one that does not; the tie is `ci.yml`, which runs both the new gate and `npm audit signatures`, so it is already covered by the old anchor and cannot demonstrate the widening — the new standalone workflow is the only discriminating fixture and AC-7.2's revert mutation must name it.

---

### TEST-F26 — Severity: Minor — DESIGN — I-5.6's step form is unspecified, and the natural spelling collides with AC-4.2

**Problem.** I-5.6 (`:663-667`) specifies a probe-gated `pre-pr` step but not its shape. The inline spelling — `run_step "Static: Override floor staleness" bash -c '[ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] || { echo skipped; exit 0; }; node scripts/checks/…'` — is matched by `check-gate-selftest-coverage.sh` member set (2) (`scripts/checks/check-gate-selftest-coverage.sh:159-172`, anchored on `run_step "Static:…" bash -c`), which **requires** an entry in `gate-selftest-debt.txt`. AC-4.2 (`:598-599`) requires the coverage gate to exit 0 "with **no new entry**" in that file. Both cannot hold.

The house pattern that avoids the collision is the one used for the integration step at `scripts/pre-pr.sh:676-687`: `if <probe>; then run_step "<label>" <cmd>; else printf "…(skipped — …)\n"; fi`, with the probe outside `run_step`. The plan mirrors "probe-and-announce" in prose (`:334`) without naming the file or the shape.

**Impact.** Loud either way — AC-4.2 fails, or the coverage gate fails — so this is a cost, not a false green. A third spelling (dropping the `"Static:"` prefix) evades the meta-gate silently, but the gate file itself is covered by member set (1) through its sibling self-test, so coverage does not actually regress.

**Recommended action.** Name the shape and the anchor in I-5.6: probe outside `run_step`, `run_step` invoking `node scripts/checks/check-override-floor-staleness.mjs` directly (no `bash -c`), skip branch printing via `printf`, modelled on `scripts/pre-pr.sh:676-687`. (1) **Allow side**: AC-5.4's token-present run must still red on a stale scratchpad manifest and must still be counted in `pre-pr`'s pass/fail tally — a probe written as a bare `if` around a `printf` and nothing else would go green without running anything. (2) **Red-prove**: unset both tokens → assert the skip line in stdout (AC-5.4 already does this, correctly, rather than asserting the exit code); set a token with a stale manifest → assert the failure line names the package. (3) Neither-pass-nor-fail: a token present but the gate unreachable (offline laptop) yields `ADVISORY_QUERY_UNREACHABLE` and reds `pre-pr` — state whether that is intended, because VE-1's offline contract says `pre-pr` must not require network and I-5.6's probe cannot distinguish "has token" from "has network". This is the one genuinely undecided cell. (4) Do not resolve it by making the step `continue-on-error`-equivalent (`|| true`) — C5 forbids exactly that, and TEST-F25 shows nothing would catch it. (5) **Boundary and tie**: the boundary is token-present vs token-absent; the tie is token-present-but-offline, which currently maps to the deny side and will red `pre-pr` on a plane.

---

### TEST-F27 — Severity: Minor — PROSE — The recorded-response fixture's instruction contradicts its stated purpose and pins less than claimed

**Problem.** The fixture (`:586-593`) is described as "trimmed to the fields the gate reads", but the command shown writes the untrimmed response: `gh api '/advisories?ecosystem=npm&affects=lodash&per_page=100' > scripts/__tests__/fixtures/advisories/lodash.json`. Three further gaps: the file is a **list** response (an array) while `extractBands` takes a **single** advisory, so nothing pins the envelope or any field only `fetchAdvisories` reads; the case is said to be driven through `extractBands` but the element is not named (the four-package advisory is `GHSA-r5fr-rjxr-66jc`, and a later regeneration may reorder the array, so an index-based selection drifts silently); and nothing detects that the pinned advisory has since been withdrawn, at which point the case would assert `[]` for the wrong reason. I could not size the file — an unauthenticated fetch from this host returned HTTP 403 (see TEST-F22).

Verified separately: `vitest.config.ts:8-13` includes only `scripts/__tests__/**/*.test.{mjs,ts}`, so a `.json` under `scripts/__tests__/fixtures/` is **not** collected as a test, and the directory already holds nine fixture files plus two subdirectories, so the location matches the house convention. `coverage.include` is an explicit `src/`-only allowlist (`:18-57`), so the plan's claim at `:781-784` holds.

**Impact.** Presentational, but the fixture is the plan's only defence against a field rename, and a reviewer cannot tell from the text whether the committed file is the trimmed or the raw form.

**Recommended action.** Pick one: commit the raw response and say so, or commit a trimmed one and show the trimming command. Select the element by `ghsa_id === "GHSA-r5fr-rjxr-66jc"` and assert the lookup succeeded before asserting on its bands. (1) **Allow side**: `extractBands(fixtureEntry, "lodash")` must return the `lodash` band and only it; `extractBands(fixtureEntry, "lodash-es")` on the same object must return the `lodash-es` band — the same fixture answering two subjects is what proves S3 against reality rather than against a hand-built object. (2) **Red-prove**: rename `vulnerable_version_range` in a scratchpad copy of the fixture → the case reds; drop the S3 filter → the two-subject assertion reds. (3) Neither-pass-nor-fail: the fixture element not found by `ghsa_id`, or `withdrawn_at` non-null on it, is `FIXTURE_STALE` — a refusal, not a silently-empty band list. (4) Do not trim past `withdrawn_at`, `severity` or `package.ecosystem`; the S3/S4 filters read them and a fixture trimmed to `vulnerabilities[].package.name` alone would make cases 12 and 13 unrunnable against real data. (5) **Boundary and tie**: the boundary is between a shape the gate reads and one it ignores; the tie is `first_patched_version`, which is an **object** (`{identifier: "…"}`) in the API and a bare string in every hand-written C4 fixture — if the trim flattens it, the fixture stops catching the one rename most likely to happen.

---

### TEST-F28 — Severity: Minor — PROSE — C4's Deny/Allow columns are inverted for cases 6, 12 and 13

**Problem.** The table header (`:559-561`) is `| # | Deny | Paired allow |`. Case 6's left cell is labelled "**comma band, ALLOW side**" and expects `[]`; its right cell expects a violation. Case 12's left cell expects `[]` ("a deny-shaped input that must NOT deny"); its right cell expects one violation. Case 13 is the same shape ("again a must-not-deny"). Case 9's right cell packs two expectations, one of which (top-level `"."` → `DOT_KEY_AT_TOP_LEVEL`) is a deny with no allow of its own.

Each individual cell is internally clear, but three rows put the allow in the Deny column, and AC-4.3 addresses cases by side name — which is how TEST-F15's row lands on the wrong half and how the two S3 rows ("case 12 **deny row**") point at the half that expects a violation rather than the `[]` half they can actually red (TEST-F16).

**Impact.** No behavioral consequence on its own; it is the carrier for two Major findings.

**Recommended action.** Retitle the columns `| # | case A (expectation) | case B (expectation) |` and make every AC-4.3 row name the expectation rather than the side. (1) **Allow side**: cases 1–5, 7–11 and 14–18 must keep their current reading unchanged — the retitling is presentational and must not renumber, because AC-4.3 and the axis-combination list both address cases by number. (2) **Red-prove**: after retitling, re-walk the 13 mutation rows and confirm each names a cell whose expectation the mutation inverts; a row still naming "deny side"/"allow side" is `ROW_UNRESOLVED`. (3) A row naming a case number that does not exist (currently "the runbook case") is `ROW_UNRESOLVED` too. (4) Do not fix by swapping the cells into the labelled columns — case 6's `[]` half genuinely is the regression test and belongs first, which the current ordering communicates. (5) **Boundary and tie**: the boundary is which cell a mutation must red; the tie is case 6, where both cells throw under the mutation and only the expectation distinguishes them.

---

## Recurring Issue Check

- **R1** Shared utility reimplementation — OK. N4 + C2's forbidden `function collectScopes` pattern; verified the real walker at `check-override-key-disjointness.mjs:93-120` supports the additive `pin`/`selfPins` extension.
- **R2** Constants hardcoded in multiple places — OK. Revision 2 removed the "23"/"15" literals; AC-3.4 now derives the count in the test.
- **R3** Incomplete pattern propagation — Fires: TEST-F25 (C7 propagates the widening to one of two anchors), TEST-F20 (`pin` propagated to `byPackage` but not `unparseable`).
- **R4** Event/notification dispatch gaps — N/A.
- **R5** Missing transaction wrapping — N/A.
- **R6** Cascade delete orphans — N/A.
- **R7** E2E selector breakage — N/A.
- **R8** UI pattern inconsistency — N/A.
- **R9** Transaction boundary for fire-and-forget — N/A.
- **R10** Circular module dependency — OK. C3 → C2 is one-way; the sibling imports nothing back.
- **R11** Display group ≠ subscription group — N/A.
- **R12** Enum/action group coverage gap — Fires: TEST-F18 (case 17 covers `low` on the deny side and `critical` only on a non-intersecting allow; `medium` — M1's own severity — is untested).
- **R13** Re-entrant dispatch loop — N/A.
- **R14** DB role grant completeness — N/A.
- **R15** Hardcoded env values in migrations — N/A.
- **R16** Dev/CI environment parity — Fires: TEST-F22 (the acceptance suite needs a token the plan states on one criterion; the verification host is already 403-limited), TEST-F26 (the `pre-pr` step's probe cannot distinguish "no token" from "no network", and VE-1's offline contract turns on that distinction).
- **R17** Helper adoption coverage — OK. C3 is the only new consumer of the extended primitive.
- **R18** Config allowlist synchronization — Fires (minor): TEST-F26 (`gate-selftest-debt.txt` and AC-4.2 pull in opposite directions for the inline step form).
- **R19** Test mock alignment with helper additions — OK. AC-2.2 adds assertions for the new shape without editing the 25 existing cases; verified no existing case deep-equals a `byPackage` entry, so the additive fields are transparent.
- **R20** Multi-statement preservation — N/A.
- **R21** Subagent completion vs verification — N/A for this plan; the Round-1 artifact records the orchestrator's own re-execution, which is the right shape.
- **R22** Perspective inversion for established helpers — Fires: TEST-F23 (S1's "children yielded" test is inherited from `collectScopes`'s output shape without stating what a `"."`-only scope yields).
- **R23** Mid-stroke input mutation — N/A.
- **R24** Migration mixing additive + strict — N/A.
- **R25** Persist/hydrate symmetry — N/A.
- **R26** Disabled-state UI without cue — N/A.
- **R27** Numeric range in user strings — N/A.
- **R28** Toggle label grammar — N/A.
- **R29** Citation / derived-claim accuracy — Fires: the S3 prefix justification at `:489-490` cites `hono` / `@hono/node-server`, and executed `"@hono/node-server".startsWith("hono")` is **false** — the cited pair does not demonstrate the hazard (`"lodash-es".startsWith("lodash")` does). VE-3 still costs AC-3.2 at "six reverts ≈ 108 requests" after the criterion was extended to eight. Verified-correct claims: `vitest.config.ts:11` includes `scripts/__tests__/**/*.test.mjs` and `coverage.include` is `src/`-only; `check-workflow-supply-chain.mjs`'s `runsVerifier` is exactly as quoted; `check-override-key-disjointness.test.mjs:116` is the `"."`-exclusion case and the file holds 25 `it()` cases; `check-dockerfile-prisma-pin.sh` reads only the `>=3` key; no workflow currently sets `continue-on-error`.
- **R30** Markdown autolink footguns — OK.
- **R31** Destructive ops without confirmation — OK. AC-3.2 now uses scratchpad copies (Round-1 TEST-F6 closed); AC-4.3 mutates a scratchpad copy of the gate.
- **R32** Runtime artifact without boot smoke test — Fires: TEST-F14 (AC-3.3 is the boot smoke test for the shell and cannot execute). AC-5.3's observed `gh workflow run` remains correct.
- **R33** CI config change applied to one config not its duplicates — OK. Both the weekly workflow and the PR job are specified; I-5.3 correctly refuses a paths filter.
- **R34** Pre-existing bug deferred without cost — OK. SC-A…SC-F each carry worst-case, likelihood, cost and an owner; SC-E and SC-F are the model shape.
- **R35** Production component without manual test plan — OK. VE-1/VE-4 and AC-5.3/AC-5.4 give the manual paths.
- **R36** Suppression / markerless weakening — Fires: TEST-F25 (four of five weakening forms remain unenforced, so a later PR can mask the gate's exit with nothing in the diff to review).
- **R37** Internal jargon in user strings — OK. Violation strings name package, GHSA id and floor.
- **R38** State machine fail-open / non-terminal state — OK. Round-1's wedge concern was refuted by measurement (0 of 306 null patches) and S5 + SC-E now define the branch with a costed deferral.
- **R39** Secret zeroization — N/A.
- **R40** Cross-boundary serialization shape vs strict consumer — Fires: TEST-F19 (the map value has no truncation field; the shape validators are unexported shell functions while C4 cases assert their tokens).
- **R41** Declared capability without backing path — Fires: TEST-F19 (cases 16 and 18's `ghsa_id` half), TEST-F20 (I-2.2), TEST-F16 (three mutation rows naming non-cases).
- **R42** Class-membership derivation — Partially fires: the member-set primitive and the 25/24/18/306/7/0 census are stated with a reproducing command, which is the right shape, but AC-3.0 — the criterion that re-derives them with the committed gate — is not executable as written (TEST-F21).
- **R43** Fix-induced boundary widening — OK. Floors move up only; no new key (I-1.2), re-audited by AC-1.5.
- **R44** Gate exit status through a lossy channel — Fires: TEST-F25.
- **R45** Gate scaling super-linearly — OK. 18 sequential requests, measured 7–9 s, linear in the override set. The suite-level request total is TEST-F22, a budget issue, not a scaling one.
- **R46** Scope-blind binding resolution — Fires (contributing to TEST-F23): the array-pin case synthesises a child package named `"0"` by position, and S2's self-pin parent is derived from `scopePath` string surgery rather than from the binding.
- **R47** Surface-form adjudication — OK. `semver.intersects` is the adjudicator (N3); C1's three forbidden patterns are correctly declared as literal-reintroduction tripwires rather than as the predicate.
- **R48** Parallel adjudicators — Fires: the scratchpad derivation is retired in favour of the gate, but AC-3.0 — the only thing that reconciles them — cannot run as specified (TEST-F21), so the twin is retired by intention rather than by execution.
- **R49** Claim stronger than implementation — Fires: case 17's "Proves the no-filter invariant across the real enum" (TEST-F18) and I-2.2's "C3 must not gain a silent pass" (TEST-F20) are both stronger than anything that executes.
- **R50** Verification preconditions unverified — Fires. Walking every acceptance criterion in revision 2 for "would it fail if the thing it claims were false": AC-1.1/1.2/1.4/1.5 ✓; AC-1.3 ✓ (an absent root diff is named a stop condition); AC-2.1 ✓ (regression only, correctly labelled); AC-2.2 ✓ (this is the Round-1 fix and it holds); **AC-3.0 ✗** (no input provenance, no ordering, argv cannot carry `--report` — TEST-F21); AC-3.1 ✓ modulo TEST-F22; **AC-3.2** ✓ in content, ✗ in precondition scope; **AC-3.3 ✗** (unexecutable — TEST-F14); AC-3.4 ✓ (count derived in the test); AC-4.1 ✓; AC-4.2 ✓ but see TEST-F26; **AC-4.3 partially ✗** (four rows — TEST-F15, TEST-F16); AC-5.1/5.2 ✓ (both name checks that exist and can fail); AC-5.3 ✓ (observed run, not inferred); AC-5.4 ✓ (asserts the printed line, not the exit code — the Round-1 fix, correctly done); AC-6.1/6.2 ✓; AC-7.1 ✓ for `continue-on-error` only; AC-7.2 ✓ (two mutations, two cases); AC-7.3 ✓.
- **R51** Decision bound to a name not the object — Fires: TEST-F16's `startsWith` row (the band is bound to the subject by a filter whose mutation-proof depends on an unnamed fixture package).
- **R52** Control reach extended without re-auditing the control — OK. AC-1.5 re-runs the disjointness gate; AC-2.1 re-runs its 25 cases unedited; the audit of the primitive is what produced S2.
- **R53** Threshold without headroom measurement — OK on shape (no threshold, no suppression list, headroom = 0 members), but the measurement's re-derivation by the committed gate is AC-3.0 (TEST-F21).
- **R54** Control suspension via ambient context — Fires (design tension): the host pin closes `GITHUB_API_URL`/proxy suspension, and AC-3.3 needs exactly such a seam to run at all — TEST-F14 recommends an argv-supplied base so the seam is explicit and diffable rather than ambient.
- **R55** In-band sentinel — Fires (residual): `advisories: []` still means both "no advisories" and "empty because truncated" unless TEST-F19's `truncated` field lands; case 15 correctly separates `{ok:false}` from `{ok:true, advisories:[]}`, which is the Round-1 fix.
- **R56** Progress-marker heal direction — N/A.
- **R57** Ordering key without total order — OK. Pagination is refused rather than cursor-walked; measured no `Link` header at `per_page=100`.
- **RT1** Mock-reality divergence — Largely closed: `extractBands` now takes the raw advisory and a recorded fixture is committed. Residual: TEST-F27 (the fixture's form is ambiguous and `first_patched_version` is an object in the API but a string in every hand-written case).
- **RT2** Testability verification — Fires: TEST-F14 and TEST-F19 exist because the plan's own cases are not executable against the declared signatures. Every finding above names an executable command or a specific case.
- **RT3** Shared constant in tests — OK. The "23" literal is gone; AC-3.4 derives the count by walking the manifests.
- **RT4** (not in scope index) — N/A.
- **RT5** Test call-path includes the production primitive — Fires: of C3's seven exported functions, `formatReport` is reached by no fixture-driven case (only by live-data AC-3.0/AC-3.4), and the shell (`fetchAdvisories`, `main`, canary, retry, exit path) is reached only by the unexecutable AC-3.3. The other six are reached.
- **RT6** New exports without test diff — OK for C2 (AC-2.2 is the Round-1 fix and it lands); fires for C3's `formatReport` and for the unexported shell validators (TEST-F19).
- **RT7** Guard proven able to fail — Fires: TEST-F15 (one row names the side that stays green — the Round-1 defect reproduced), TEST-F16 (four rows cannot red what they name), TEST-F17 (the `max`-over-bands clause and six others have no row at all).
- **RT8** Vacuous denial-path test — OK in the invariant (I-4.2 forbids `toHaveLength` alone and Consumer 1 demands content), but TEST-F17 notes it needs extending to forbid count-only assertions on multi-band rows.
- **RT9** Parallel-implementation twin drift — Fires: AC-3.0 is the retirement mechanism and it cannot execute as written (TEST-F21); TEST-F14's scratchpad-copy option would introduce a second twin (the host-rewritten gate) if taken.
- **RT10** Guard tested only on deny side — Fires: TEST-F18 (case 17's allow is vacuous for its stated purpose), TEST-F28 (three pairs have their sides in the wrong columns, which is what makes two mutation rows point at the wrong half). The other 15 pairs are genuine same-shape pairs — case 3's allow additionally discriminates selector-vs-pin (executed: `intersects("1","<1.1.18")` → `true`, so a selector-judging implementation reds it), which is a real property the plan does not claim.
- **RT11** Fixture outlives its run — OK. I-4.4 requires `mkdtempSync(tmpdir())` + `afterEach` cleanup on the failure path; AC-3.2 and AC-4.3 now use scratchpad copies rather than mutating tracked files (Round-1 fix). TEST-F27 notes the committed fixture is a deliberate long-lived artifact and needs a `FIXTURE_STALE` refusal, not cleanup.

---

```json
[
  {"id": "TEST-F14", "severity": "Critical", "title": "AC-3.3 is unexecutable: the host pin forbids reaching the local fixture server, leaving the network shell, canary, retry and exit path untested", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 534, "adjacent": false, "escalate": null},
  {"id": "TEST-F15", "severity": "Major", "title": "AC-4.3's normalizeBand row names the side of case 6 that stays green under the mutation (Round-1 defect reproduced)", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 606, "adjacent": false, "escalate": null},
  {"id": "TEST-F16", "severity": "Major", "title": "Four of thirteen mutation rows point at cases that cannot observe them, or at live-data criteria that are not cases", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 617, "adjacent": false, "escalate": null},
  {"id": "TEST-F17", "severity": "Major", "title": "max(first_patched_version) over intersecting bands has no deterministic case and no mutation row; all 18 pairs are single-band", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 142, "adjacent": false, "escalate": null},
  {"id": "TEST-F18", "severity": "Major", "title": "Case 17's allow changes two axes at once and passes under every severity filter, including one that drops critical", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 579, "adjacent": false, "escalate": null},
  {"id": "TEST-F19", "severity": "Major", "title": "Truncation, shape validation and formatReport remain shell-only or untested; cases 16 and 18 unwritable against the C3 signature", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 255, "adjacent": false, "escalate": null},
  {"id": "TEST-F20", "severity": "Major", "title": "I-2.2's 'no silent pass for an unparseable selector' has no backing path: unparseable entries carry no pin and no consumer reads them", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 418, "adjacent": false, "escalate": null},
  {"id": "TEST-F21", "severity": "Major", "title": "AC-3.0 names no source for pre-C1 manifests, is ordered after C1, and the cited argv form cannot carry --report", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 513, "adjacent": false, "escalate": null},
  {"id": "TEST-F22", "severity": "Major", "title": "GH_TOKEN precondition stated on AC-3.2 only while seven criteria need it; verification host returns 403 rate-limit today", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 36, "adjacent": false, "escalate": null},
  {"id": "TEST-F23", "severity": "Major", "title": "S1 EMPTY_SCOPE collides with S2 self-pin, and case 11 asserts PIN_NOT_A_RANGE for array pins the walker recurses into", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 194, "adjacent": false, "escalate": null},
  {"id": "TEST-F25", "severity": "Major", "title": "C7 widens runsVerifier only; four of C5's five forbidden weakening forms still have no enforcing mechanism", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 729, "adjacent": false, "escalate": null},
  {"id": "TEST-F26", "severity": "Minor", "title": "I-5.6's step form is unspecified and the natural inline spelling collides with AC-4.2's no-new-debt-entry clause", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 663, "adjacent": false, "escalate": null},
  {"id": "TEST-F27", "severity": "Minor", "title": "Recorded fixture: 'trimmed' prose contradicts the untrimmed command, element unnamed, envelope and staleness unpinned", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 586, "adjacent": false, "escalate": null},
  {"id": "TEST-F28", "severity": "Minor", "title": "C4's Deny/Allow columns are inverted for cases 6, 12 and 13, which is what mis-points two mutation rows", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 559, "adjacent": false, "escalate": null}
]
```
agentId: ae5e3bad88b6ac7bf (use SendMessage with to: 'ae5e3bad88b6ac7bf', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 177499
tool_uses: 18
duration_ms: 1069995</usage>

---

# Round 3

## Changes from Previous Round

Revision 3 corrected the census (223 live entries / 6 withdrawn, replacing 306 / 7 —
revision 2 iterated 24 pins instead of 18 packages), added four semantic decisions
(S9 the unparseable bucket, S10 a four-way status, S11 the ambient-input boundary,
S12 the canary's limits and residual), restated C7 as a member set, and
**de-specified the test surface**: the 18-case table and 13-row mutation table were
replaced by obligations O-1…O-9, with the cases authored and the mutation loop run in
Phase 2.

The round was scoped to design only: the experts were explicitly forbidden from
re-specifying the test surface.

## Result

28 findings: 1 Critical, ~19 Major. The census reproduces exactly in two independent
walks. The Critical and most Majors are against revision 3's own mechanism
specifications again — the same character as round 2.

Errors the orchestrator introduced in revision 3 and three experts caught:

| Error | Evidence |
|---|---|
| I-7.3 cites `release.yml:315` as "a legitimate pipe on a verifier line" | Executed: it is `npm audit signatures --json --include-attestations > "$AUDIT_JSON"` — a **redirect**. `grep -rn "audit signatures.*\|" .github/workflows/` returns **nothing**; no verifier line in the repo has a pipe. The real instance is `release.yml:210`'s `echo "$VIEW" \| node -e "…dist?.attestations…"` under `set -euo pipefail`. Taken from a round-2 citation without re-execution. |
| C3's forbidden pattern `process.env` outside the token read | Contradicts the hardening clause's own mandated `GITHUB_API_URL`/proxy refusal, which must read `process.env`. The grep-checkable half wins and the ambient path stays open. |
| S11's "parameter reachable only by direct import" vs AC-3.3's "driven as a process" | A spawned process cannot be handed a function parameter. Round 2's Critical, incompletely closed. |
| "18 distinct package names" | An independent walk yields **17** pin names; 18 requires also querying the scope opener, which S1 says is not judged — a rule the plan never states. |
| C5 attributes all five forbidden forms to C7 | `uses:@v[0-9]` has no rule in `check-workflow-supply-chain.mjs`; it belongs to `check-actions-sha-pinned.sh`. C7's own indirection clause has no fixture and, per the security expert, no decidable predicate (18 real `npm run` invocations exist in workflows). |

Measured, not argued: a reviewer copied `check-workflow-supply-chain.mjs` to
scratchpad, widened `verifierLineRe` and added a naive pipe alternative to
`maskRe`, and ran it over the real workflows — `release.yml orig=0 widened=2`
(`:210`, `:268`). The obvious implementation of the plan's pipe rule false-reds
the release workflow.

A round-2 finding was also withdrawn on measurement: `first_patched_version` is a
bare string (`"4.18.0"`), not an object. The plan's scalar treatment was correct.

## Round-count trajectory

| | R1 | R2 | R3 |
|---|---|---|---|
| findings | 12 (merged) | 33 | 28 |
| against the design | most | 0 | few |
| against the plan's own mechanism specs | few | ~2/3 | most |

This is the shape `feedback_plan_granularity_becomes_defect_surface` records: the
count is not converging and the character has not changed since round 2. Revision 3
applied the de-specification to the test tables but then added a nine-export shape
block, a forbidden-pattern list and a twelve-row semantic table — new mechanism
surface, which produced the next crop.


### Functionality expert — round 3

I have everything I need. Writing the review artifact.

---

# Plan Review (Round 3): stale-override-floors — Functionality

## Reproduction performed (R29)

Executed at `8d688731c`, tree clean apart from the two untracked review docs; all experiments in `/tmp/sofr3`; no tracked file modified.

**The census reproduces exactly, all nine figures.** Second instrument (a hand-rolled manifest recursion sharing no code with `collectScopes`) over the three tracked manifests: `entries 25, pins 24, scope openers 1, "." keys 0, unparseable selectors 0, distinct names 18`, per-manifest `19 / 2 / 3` pins. One `gh api` query per distinct name: **158** advisories, **6** withdrawn, **223** live same-package vulnerability entries, **0** with a null patch, **0** live `type: unreviewed`, and **0** advisories returned for `affects=X` lacking an exact-npm-`X` band (S12 layer 1's headroom). M1–M6 reproduce verbatim with their GHSA ids, severities, bands and floors, including M3/M6 both landing on 8.5.23 and M6's third band; post-C1 all five distinct pins intersect **0** live bands (I-3.6). Non-members confirmed: `@crxjs/vite-plugin > rollup ^2.80.0` → no intersecting band, `$rollup` → `^4.62.3` → 0, `@crxjs/vite-plugin` → 0 advisories.

Also confirmed against code: `check-override-key-disjointness.mjs:260` argv form; `check-workflow-supply-chain.mjs` `verifierLineRe:101` / `runsVerifier:102-104` / `maskRe:106`; `check-dockerfile-prisma-pin.sh:68` reads only `/^brace-expansion@>=3/`; `ci.yml:687/716/743` are the three `npm audit --omit=dev --audit-level=high` lines; `pre-pr.sh:303` queues `Static: workflow-supply-chain`; `vitest.config.ts:11` includes `scripts/__tests__/**/*.test.mjs` with a `src/`-only `coverage.include`; the disjointness self-test has 25 `it()` cases with the `"."` case at :116; lock-resolved versions hono 4.12.31, @hono/node-server 2.0.11, root postcss 8.5.25, brace-expansion 1.1.18/2.1.4, cli postcss 8.5.23.

**Does NOT reproduce:** `release.yml:315` is `npm audit signatures --json --include-attestations > "$AUDIT_JSON"` — a redirect, not a pipe. No `audit signatures` line anywhere in `.github/workflows/` contains a pipe (finding 5).

Incidental correction to the round-2 artifact, carried here so it is not inherited: `first_patched_version` is a **bare string** (`"4.18.0"`), not `{identifier}`. TEST-F27's tie was wrong; revision 3 wisely encodes neither, so nothing needs fixing.

## Round-2 finding disposition

- **F1** (`unparseable` has no kind/pin/consumer) — **CLOSED.** S9 + I-2.2 + the Consumer-3 walkthrough give it `pin`, a kind and a reader, and S9 states honestly that completeness resting on another gate is the stronger claim.
- **F2** (S1 `EMPTY_SCOPE` ↔ S2 self-pin collision; `{"pkg": []}` yields two rows) — **PARTIALLY CLOSED.** Both named collisions are closed (`selfPins` counts as children; arrays are not recursed). The predicate `byPackage.size > 0 || selfPins.length > 0` is now stated over "its nested scope" with **no carrier for which scope that is** — finding 1.
- **F3** (`selfPins` has no parent carrier) — **CLOSED** for self-pins: `parentKey`/`parentName` on the child record, I-2.4, and AC-2.2 naming `topLevelScope(...)`. The same class survives one step over, on S1's linkage (finding 1).
- **F4** (C7 mechanises one of five forms) — **PARTIALLY CLOSED.** Four forms now have a correctly-located mechanism — `runsVerifier` + `verifierLineRe` + `maskRe` are exactly the three preconditions the code has. The fifth (`uses:@v[0-9]`) is attributed to C7 but lives in a different gate (finding 6), and the tie that decides the pipe rule's shape does not exist (finding 5).
- **F5** (pre-pr step vs meta-gate set (2)/AC-4.2) — **PARTIALLY CLOSED.** I-5.7 names the shape and the anchor. What remains: the new `scripts/checks/` file needs its own sibling self-test, which no contract owns (finding 8), and the `queue_step … bash -c` evasion I-5.7 names is forbidden in prose only.
- **F6** (row shape cannot carry the withdrawn count / refusal vs query failure / floating `main`) — **PARTIALLY CLOSED.** `extractBands` → `{bands, skipped}` and S10's four-way `status` close (a) and (b). Clause (c) — `async main()` at module scope surfacing an internal throw as a raw unhandled rejection rather than a named refusal — is unaddressed; folded into finding 3.
- **F7** (cases asserting shell-only behaviour) — **CLOSED.** `parseLinkTruncation` and `validateAdvisoryShape` are exports, and O-3 makes an unreachable declared behaviour a defect in the shape rather than a test gap.
- **F8** (AC-3.4 compares `collectOverridePins` to itself) — **CLOSED.** Second instrument + `ENTRY_COUNT_DRIFT` naming both numbers and the symmetric difference.
- **F9** (census 7/306, VE-3 arithmetic, AC-5.2's justification) — **CLOSED.** All three corrected; I re-measured every figure and all nine reproduce. Residual is presentational only (finding 10).
- **F10** (AC-3.0 has no input provenance) — **PARTIALLY CLOSED.** Scratchpad copies, the argv form and the `git status --porcelain` assertion are all in. But the argv form AC-3.0 now cites cannot carry `--report`, and its observed failure mode is a silent green (finding 7).
- **[Adjacent] PAT egress** — **NOT CLOSED.** With a token present, `pre-pr` still sends the developer's PAT to `api.github.com` on every run and consumes 18 of their 5000/h. VE-3 costs the CI budget and scenario 4 covers the tokenless path; the token-present local path's egress is named nowhere. Overlaps Security.

---

## Findings

### 1 — Severity: Major — DESIGN — S1's "its nested scope yielded" has no carrier, and the only available one (the `scopePath` string) collides at equal depth

**Problem.** I-2.4 removed the *backward* `scopePath` parse for S2's self-pins. S1 has the identical dependency and did not get the same treatment: the scope opener is an entry in the **parent** scope's `byPackage`, the children it must be correlated with are in a **different** record, and the plan states the predicate (`byPackage.size > 0 || selfPins.length > 0`) without saying how `collectOverridePins` finds that record. `parentKey` alone does not identify it — executed against the real walker:

```
collectScopes({ a: { x: { p: "^1.0.0" } }, b: { x: {} } })
  depth=2 'overrides > a > x'  byPackage=[p]     <- yielded
  depth=2 'overrides > b > x'  byPackage=[]      <- empty
```

Two records, same depth, same `parentKey` (`x`), opposite verdicts. The disambiguator must be the parent scope's identity. The only one on the record is `scopePath`, and forward reconstruction is not unambiguous either — executed:

```
collectScopes({ a: { "b > c": {p:"1.0.0"} } })   -> depth 2, 'overrides > a > b > c'
collectScopes({ "a > b": { c: {p:"1.0.0"} } })   -> depth 2, 'overrides > a > b > c'
```

Round 2 proved `"1.0.0 || > 2.0.0"` is a selector `semver.validRange` accepts, so a key containing `" > "` is a legal manifest edit, not a contrivance.

**Impact.** A scope opener matched to the wrong record is excluded from pin judgement while nothing under it was judged: `EMPTY_SCOPE` is not raised and the entry is silently skipped, falsifying I-3.1 in exactly the shape S1 exists to close. Headroom is 0 today (one scope opener, one child scope), which is precisely why the linkage will be written with whatever string is at hand.

**Recommended action.** Give `collectScopes` a structural link: allocate a scope id before recursing, put `id` on every record and `parentScopeId` on the child, and have `collectOverridePins` correlate on `(parentScopeId, parentKey)` — never on a formatted path. **Allow:** `{"parent": {"child": "^1.0.0"}}` → the opener is `scope`, not judged, no `EMPTY_SCOPE`; and the 25 existing disjointness cases stay green unedited, including the post-order assertion on `scopes[0].scopePath`, whose spelling must not change. **Deny:** `{"a": {"x": {"p":"^1.0.0"}}, "b": {"x": {}}}` → exactly one `EMPTY_SCOPE`, naming `overrides > b > x`. **Red-prove each clause separately, by execution:** (a) correlate on `parentKey` + `depth` only → the two-sibling deny greens; (b) correlate on the reconstructed `scopePath` → a `{"a": {"b > c": {}}}` / `{"a > b": {"c": …}}` fixture pair reds one of them; (c) revert the predicate to `byPackage.size > 0` → the self-pin-only allow reds (already an O-4 obligation). **Fail loudly:** a `byPackage` entry whose pin is a plain object and for which **no** child record can be identified is `SCOPE_CHILDREN_UNRESOLVED`, a refusal — never "assume it yielded". **Do not** fix by rejecting keys containing `" > "`; the repo already ships spaced selectors and rejecting them breaks the disjointness gate's own coverage. **Boundary:** an entry's classification comes from a record the walker linked, never from a string it formatted. **Tie:** `{"parent": {}}` — an opener whose record *is* found and is empty; it must be `EMPTY_SCOPE`, which is the case that proves the link resolved rather than defaulted.

*Secondary (PROSE, same cell):* S1's prose says the opener is excluded "because its nested scope yielded at least one **judged** entry", while its predicate counts `byPackage.size` — which is also >0 for a scope yielding only refusals (`{"parent": {"child": []}}`). Both readings deny somewhere, so nothing fails open, but the two sentences disagree and Phase 2 must pick one.

### 2 — Severity: Major — DESIGN — A pin that is a string is never validated; `PIN_NOT_A_RANGE` covers only non-strings, so an unparseable pin on a package with no live bands is `clean`

**Problem.** S1 defines `PIN_NOT_A_RANGE` for "an **array or any non-plain object**". Nothing in S1–S12 covers a **string** that `semver` cannot parse, and the walker never looks: `collectScopes` runs `validRange` on the **selector**, never on the value. Executed:

```
collectScopes({"@crxjs/vite-plugin": "not-a-range"})
  -> byPackage: [["@crxjs/vite-plugin", [{key:"@crxjs/vite-plugin", range:"*"}]]]   unparseable: []
semver.validRange("not-a-range") -> null
semver.intersects("not-a-range", "<1.0.0") -> throws "Invalid comparator: not-a-range"
```

The only thing that catches it is I-3.2's "a throw out of `semver.intersects` is a violation" — and `intersects` is called **once per band**. A package with zero live bands is never compared, so the row is `clean` with an unparseable pin. That is not hypothetical: `@crxjs/vite-plugin` has **0 advisories today (measured)**, and any package whose advisories are all withdrawn (S4) reaches the same state.

The class has a second member the semantic decisions also miss: an `overrides` value that is not a plain object at all. Executed — `collectScopes("foo")` yields packages named `"0"`, `"1"`, `"2"` with pins `"f"`, `"o"`, `"o"`. Those names reach `fetchAdvisories`, return `200 []`, and are reported `clean`.

**Impact.** The gate's whole premise is that a pin's guarantee is checked rather than remembered; here a pin that guarantees nothing at all is reported clean, and the verdict depends on whether the advisory database happened to be non-empty that day. This is S12's `200 []`-is-clean residual reappearing on the *manifest* side, where it is fully decidable offline and costs one call.

**Recommended action.** Validate the pin before judging: a `pin` kind whose `semver.validRange(pin)` is `null` is `PIN_NOT_A_RANGE` (widen S1's cell from "non-string values" to "any value `validRange` rejects"), and an `overrides` root that is not a plain object is `OVERRIDES_NOT_AN_OBJECT`, refused before the walk. **Allow:** a valid pin on a package with **zero** live bands stays `clean` — `@crxjs/vite-plugin`'s real shape, and the case that stops the fix from being "refuse whenever there are no bands". **Deny:** `{"<0-advisory package>": "not-a-range"}` → `PIN_NOT_A_RANGE`, no query issued. **Red-prove each clause separately, by execution:** (a) delete the pre-comparison `validRange` → the deny greens while every existing violation case stays green (proving the throw path cannot substitute for it); (b) make the refusal fire on `validRange(pin) === "*"` too → the `>=8.5.23`-style allow reds; (c) delete the root-shape check → the non-object-`overrides` deny greens with three phantom package names in the report. **Fail loudly:** a derived package name that does not match npm's name grammar is `PACKAGE_NAME_UNRECOGNISED` and is refused **before** any request, so a phantom name never becomes egress. **Do not** fix by catching the `intersects` throw more broadly — I-3.2 forbids that and it is how the comma trap returns green. **Boundary:** pin validity is decided by the walker's own output, before any advisory is consulted. **Tie:** `""`, which `validRange` maps to `"*"` — legal, intersects everything, and must deny as `stale`, not as `PIN_NOT_A_RANGE`.

### 3 — Severity: Major — DESIGN — S10's four-way status partitions the manifest-side outcomes only; four outcomes the plan itself names have no status, and the cheapest implementation of each is `clean`

**Problem.** S10 defines `clean`, `stale`, `refused` ("a structural problem with the **manifest** — every refusal `kind` above") and `undecidable` ("the advisory **query** failed or was truncated"). N5 requires every other outcome to be a violation with its own named token. Four outcomes the plan names fall outside all four members:

- **`NO_PATCH_AVAILABLE`** (S5) — the query succeeded, the manifest is well-formed, the row is not clean, and it cannot be `stale` because `stale` carries a floor and S5 explicitly says there is none.
- **`UNIDENTIFIED_BAND`** (S3) — an advisory entry lacking `package.name`. The natural implementation is a filter predicate, whose output on that entry is "dropped", i.e. `clean`.
- **`AFFECTS_WITHOUT_MATCHING_BAND`** (S12 layer 1) — same shape; measured headroom 0, so nothing will ever exercise the branch by accident.
- **A failed `$ref` resolution** — `resolveRefPin` returns `{ok:false, reason}` and I-3.1 lists `pin($ref)` as judged, but no `kind`, no token and no status is defined for the `{ok:false}` arm.

Two further neither-side outcomes have no token at all: an unreadable or unparseable manifest (the reused primitive's own behaviour is `if (err.code === "ENOENT") continue` — a silent skip), and `discoverManifests()` falling back to its hard-coded list when `git ls-files` is unavailable. Round-1's remedy named `MANIFEST_DISCOVERY_FALLBACK` and `MANIFEST_UNPARSEABLE`; neither survives into revision 3. And my round-2 F6(c) is unaddressed: `main` is declared `async` and the sibling's module-scope call form is a bare `main(...)`, so an internal throw surfaces as an unhandled rejection with a raw stack rather than a named refusal.

**Impact.** I-3.5 exits 1 on `stale | refused | undecidable`. Every outcome with no status assignment defaults, in the cheapest implementation, to the fourth value — `clean` — and each of the four is precisely a filter whose natural expression is "drop the entry and carry on". N5 is the plan's central invariant and its token set is a member set that was never derived (R42).

**Recommended action.** Derive the refusal member set from the code's own decision points, not from a list: enumerate every place a value is dropped, filtered or short-circuited in `collectOverridePins`, `resolveRefPin`, `extractBands` and the fetch envelope, and assign each a `kind`, a token, and one of the four statuses — adding a fifth (`unpatchable`) if `stale`-without-a-floor is not acceptable, since the report line for `NO_PATCH_AVAILABLE` must not print a floor field. **Allow:** the three real manifests → 25 rows, 24 judged, 1 `scope`, 0 refusals; a genuinely advisory-free package → `clean`. **Deny:** one fixture per token, each asserting the token string and the exit code. **Red-prove each clause separately, by execution:** map each new status onto `clean` in turn → its own fixture reds and no other; delete the `{ok:false}` arm of `resolveRefPin` → the `$ref` deny reds on the token, not on the count; point a manifest path at a nonexistent file → `MANIFEST_UNREADABLE`, and confirm the run does **not** print "0 members". **Fail loudly:** wrap `main`'s body so an unexpected throw prints `GATE_INTERNAL_ERROR` and exits 1, rather than an unhandled rejection. **Do not** close this by widening `undecidable` to absorb everything — S10 exists because revision 2 collapsed a malformed pin into the same bucket as an unreachable API (R55). **Boundary:** the four statuses partition *rows*; the tokens partition *reasons*; every reason maps to exactly one status and no reason maps to `clean`. **Tie:** a row that is both `stale` and truncated (S8) — the intersecting band was seen but the list was not complete; name which wins, because only one of the two messages carries a floor.

### 4 — Severity: Major — DESIGN — S11's `process.env` prohibition contradicts the mandated `GITHUB_API_URL` / proxy refusal, and the cheapest way to satisfy the forbidden pattern is to delete the refusal

**Problem.** S11 states the boundary absolutely: "**`main()` reads no environment variable that influences the endpoint, the canary, or the verdict** — only the token", and C3 lists the forbidden pattern `process\.env` outside the token read. Network-shell hardening, two sections earlier, requires the opposite: "refuse if `GITHUB_API_URL` or a proxy env var points elsewhere (`ADVISORY_ENDPOINT_NOT_PINNED`, `ADVISORY_PROXY_ENV_SET`)", and AC-3.3 requires `GITHUB_API_URL` set elsewhere to refuse **before any request**. Those probes are, by construction, `process.env` reads that influence the verdict: they turn a would-be-clean run into exit 1. As written, the forbidden pattern fires on the mechanism the plan mandates, and the two ways out are both defects — delete the probes (removing the R54 closure the host pin exists to provide), or exempt them ad hoc and leave the exemption's boundary undefined, which is what re-opens the ambient-input surface.

The refusal's own member set is also unnamed. The variables that can redirect or intercept the request are a set, not a name: `GITHUB_API_URL`, `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` and their lowercase spellings, `npm_config_*_proxy`, plus `NODE_EXTRA_CA_CERTS` and `NODE_OPTIONS`, which the round-2 security review measured as **not** stopped by a URL host check.

**Impact.** S11 is the invariant that makes the shell process-testable without a test mode, and it is the one revision 3 added specifically to close the round-2 Critical. Stating it as an absolute that the design violates guarantees Phase 2 resolves it by judgement, at the exact point where the wrong judgement is markerless in the diff.

**Recommended action.** Restate S11 as an allowlist rather than an absolute: `main()` may read exactly the token variable **and** the enumerated refusal probes, and may use a probe's value only to refuse — never to construct the endpoint. Make the forbidden pattern `process\.env` outside that named allowlist, and make the allowlist the member set (R42), derived from "what can redirect, intercept or re-trust this request" rather than from the two examples. **Allow:** the probes present and the gate reaching `https://api.github.com` with none of them set; a `baseUrl` **parameter** naming `127.0.0.1` accepted from a direct import. **Deny:** each enumerated variable set, one per case, refusing before any request with its own token; and a `baseUrl` that arrived from `process.env` refused even when it names `api.github.com`. **Red-prove each clause separately, by execution:** delete each probe in turn → only its own deny reds (if one deletion reds two cases, the probes are not independent and the member set is wrong); add an env read of `baseUrl` back into `main` → the "injected via env is refused even for the right host" case reds. **Fail loudly:** a probe variable present but unparseable as a URL is a refusal, not "not set". **Do not** fix by dropping the proxy refusal to satisfy the forbidden pattern — that is fixing by deleting what made the defect visible. **Boundary:** environment may **veto** the run; it may never **shape** it. **Tie:** `NO_PROXY=api.github.com` alongside a set `HTTPS_PROXY` — the request is direct and the refusal would be a false red; decide it deliberately.

*Supporting (PROSE):* scenario 5 attributes a redirected `GITHUB_API_URL` to `ADVISORY_SOURCE_CANARY_FAILED`, but the hardening and AC-3.3 both refuse that case earlier, with `ADVISORY_ENDPOINT_NOT_PINNED`. The scenario's outage cause is right; two of its three causes name the wrong token.

### 5 — Severity: Major — DESIGN — I-7.3's tie does not exist: `release.yml:315` is a redirect, not a pipe, so AC-7.1's deciding allow case is vacuous and AC-7.2's pipefail-clause mutation cannot red it

**Problem.** I-7.3 states that `release.yml:315` (`npm audit signatures --json | node -e …`) "is a legitimate pipe on a verifier line and must stay green. It is the tie that decides the pipe rule's shape". Executed against the file: line 315 is `npm audit signatures --json --include-attestations > "$AUDIT_JSON"` — a redirect to a file, consumed by a **separate** `node -e '…' "$AUDIT_JSON"` command on the next line. `grep -rn "audit signatures.*|" .github/workflows/` returns nothing: **no `audit signatures` line in the repo contains a pipe.**

The repo's real verifier-line pipes are elsewhere and were found by running a candidate pipe rule over the actual workflows:

```
release.yml:210  run: |  set -euo pipefail … PREDICATE=$(echo "$VIEW" | node -e "…dist?.attestations…")   pipefail in same logical line? true
release.yml:268  run: |  set -euo pipefail … (the verify-published block)                                  pipefail in same logical line? true
```

Both match `verifierLineRe` through its `dist\??\.attestations` alternative, not through `audit signatures`, and both already set `pipefail`. One structural fact makes the stated rule shape workable and the plan does not mention it: `findMaskedVerifierViolations` joins an entire `run: |` block scalar into a **single logical line**, so a per-line rule can see `set -euo pipefail` from earlier in the same block. The rule survives; the fixture does not.

**Impact.** AC-7.1 names two allow cases and this is the one that decides the pipe rule's shape. An author copying `release.yml:315` verbatim builds a fixture with **no pipe in it**, which returns `[]` under every candidate rule — including a rule that bans all pipes, and including a rule with no pipefail exemption at all. AC-7.2 requires one mutation per widened clause, each *observed* to red its fixture; the pipefail-exemption clause has no fixture that can red it, so the one clause that separates "no pipes" from "unprotected pipes" ships unproven, and AC-7.3's "release.yml stays green unedited" is decided by a block the plan never names.

**Recommended action.** Correct the tie to the two real blocks and state the mechanism they rely on. **Allow:** `release.yml`'s `dist?.attestations` pipe inside a `set -euo pipefail` block → `[]`, **and** an otherwise identical block with the `pipefail` line removed → violation. That pair, on one fixture shape differing in one axis, is what makes the rule "the pipeline's exit status is not the verifier's unless `pipefail` is set" rather than "no pipes" (O-1). **Deny:** the new gate invoked as an inline `run:` with a trailing pipe and no `pipefail`. **Red-prove each clause separately, by execution:** drop the pipe alternative from `maskRe` → the unprotected-pipe deny greens; drop the `pipefail` exemption → the `release.yml` allow reds; revert `verifierLineRe`'s widening → the gate's own pipe deny greens while `release.yml` is unaffected. **Fail loudly:** a fixture asserted to produce `[]` that does **not** match `verifierLineRe` is `FIXTURE_VACUOUS`, not a pass — that assertion is what would have caught this. **Do not** fix by dropping the pipe form from C5's list. **Boundary:** the logical line, which for a block scalar is the whole `run:` body — say so, because it is also why an unrelated `|| true` twenty lines below a verifier invocation in the same block will fire. **Tie:** a block that sets `pipefail` **after** the verifier pipe; same logical line, wrong order, and a per-line regex cannot tell.

### 6 — Severity: Major — DESIGN — C5 claims C7 gives a mechanism to each of five forms; the fifth is not in C7's subject file at all, and AC-7.1 cannot be written for it

**Problem.** C5's forbidden-pattern list is five forms — `uses:\s+\S+@v[0-9]`, `continue-on-error:\s*true`, `\|\|\s*true`, `set\s+\+e`, and an unprotected pipe — introduced as "five forms, each of which **C7 gives a mechanism**". C7's stated changes are `runsVerifier`, `verifierLineRe`, `maskRe` and an indirection rule; none of them adjudicates `uses:`. `check-workflow-supply-chain.mjs`'s `main()` runs exactly four rules (auto-merge, trusted-publish node pin, publish-job isolation, masked verifier) and has no action-pin rule. The form is genuinely enforced — by `check-actions-sha-pinned.sh`, which I read and which rejects any `uses:` ref that is not 40 hex characters — but that is I-5.1's gate, run by AC-5.1, not C7's.

AC-7.1 therefore requires "new fixtures in `scripts/__tests__/check-workflow-supply-chain.test.mjs` covering **each of the five forms**", one of which that file's subject cannot decide. The author's two exits are both wrong: add an action-pin rule to the wrong gate (duplicating `check-actions-sha-pinned.sh`, R48), or drop the form silently.

Separately, C7's fourth member — the indirection ban — has no stated trigger. "Forbid indirection so the gate may only be invoked by literal path" has two implementable readings that deny different things: a **detector** (flag a workflow that invokes the gate through an `npm run` alias), which requires resolving `package.json` scripts — something this checker never reads, and which leaves `runsVerifier` false, and therefore all four mask rules silent, for any workflow it fails to resolve; or a **presence assertion** (a named workflow must contain the literal invocation), which reds loudly on any indirection but pins workflow filenames into the checker. The first is fail-open, the second is fail-closed, and the plan chooses neither.

**Impact.** The contract written to stop C5 shipping plan-level greps records a completeness it does not have, and one of its two acceptance criteria cannot be executed for 1 of 5 of its own member set. No security hole follows for the `uses:` form (AC-5.1 covers it), but R42's failure mode here is the attribution, which is what a later reader will trust.

**Recommended action.** Split the list by adjudicator and say so: four forms belong to `check-workflow-supply-chain.mjs` (C7), one to `check-actions-sha-pinned.sh` (I-5.1/AC-5.1). Scope AC-7.1 to the four, and add the fifth as a fixture in `check-actions-sha-pinned.test.mjs` instead. Choose the indirection reading explicitly. **Allow:** a workflow invoking the gate by literal path → `[]` under both readings — that is the case that must not change. **Deny:** the same workflow with the invocation replaced by an alias → `WORKFLOW_INVOKES_GATE_INDIRECTLY`. **Red-prove each clause separately, by execution:** replace the literal invocation with an alias → the indirection deny reds and, under the detector reading, confirm the four mask rules are still live for that file (if they are not, the reading is fail-open and must be rejected); revert each `maskRe` alternative one at a time → only its own fixture reds. **Fail loudly:** a workflow whose `run:` steps cannot be extracted is a violation, not a skip. **Do not** reconcile the lists by deleting the fifth form. **Boundary:** which file adjudicates which prohibition. **Tie:** `ci.yml`, which already matches `runsVerifier` through its three `npm audit signatures` steps and so cannot demonstrate the widening — the new standalone workflow is the only discriminating subject, and AC-7.2's revert mutation must name it.

### 7 — Severity: Major — DESIGN — AC-3.0 and AC-3.2 depend on argv carrying both a flag and manifest paths; the precedent they cite cannot, and its failure mode is a green

**Problem.** AC-3.0 requires `--report` "against scratchpad copies of the pre-C1 manifests, via the argv form (`main(manifests)`, the entry point `check-override-key-disjointness.mjs:260` already uses)", and AC-3.2 runs "on the same terms". That entry point is `main(process.argv.length > 2 ? process.argv.slice(2) : undefined)` — **every** argv element becomes a manifest path. Executed against the real sibling:

```
$ node scripts/checks/check-override-key-disjointness.mjs --report
override key disjointness guard passed (1 manifest(s)).   exit=0
```

`--report` was read as a path, `readFileSync` threw `ENOENT`, `main` swallowed it with `continue`, and the gate reported a pass having walked **nothing**. Revision 3 specifies no flag/path separation and no refusal for an unreadable manifest, while N5 requires every non-clean, non-stale outcome to carry a named token.

**Impact.** AC-3.0 is the criterion that retires the scratchpad twin (RT9), and AC-3.2 is the eight-shape red-proof. Under the cited form the flag is silently ignored, and a mistyped scratchpad path is silently skipped: AC-3.2's per-revert runs would red loudly (zero violations where one was expected), but AC-3.0's "reproduces exactly M1–M6" degrades to a *subset* with no diagnostic, and AC-3.4's `--report` invocation at the branch tip has the same shape. A criterion whose failure mode is a smaller correct-looking answer is the exact instrument defect that produced revision 1's numbers.

**Recommended action.** Specify the argv contract in C3's shape rather than inheriting it: elements beginning `--` are flags, the rest are manifest paths, an unrecognised flag is `UNKNOWN_FLAG` and refuses, and an unreadable or unparseable manifest path is `MANIFEST_UNREADABLE` / `MANIFEST_UNPARSEABLE` and refuses — never `continue`. Add `MANIFEST_DISCOVERY_FALLBACK` for the `git ls-files`-unavailable path, which today silently substitutes a hard-coded list. **Allow:** `--report` with **no** path arguments falls back to `discoverManifests()` and reports on the real tree — the operator's only invocation, and the one C6 documents. **Deny:** a nonexistent path → refusal naming the path; an unknown flag → `UNKNOWN_FLAG`. **Red-prove each clause separately, by execution:** restore the sibling's `ENOENT → continue` → the nonexistent-path deny greens with a smaller member set; treat flags as paths → the `--report` allow reds on the absence of report output, not on the exit code. **Fail loudly:** a run that yields **zero rows of any kind** is `EMPTY_WALK`, a refusal — an empty report is what both a correct clean tree and a broken invocation produce, and AC-3.0 cannot tell them apart otherwise. **Do not** satisfy AC-3.0 by re-running the retired scratchpad derivation. **Boundary:** argv elements are flags or paths, never both. **Tie:** a manifest path that legitimately begins with `-` — refuse it and require `./`-prefixing rather than guessing.

### 8 — Severity: Minor — DESIGN — I-5.7 requires a second `scripts/checks/` gate whose sibling self-test no contract owns

**Problem.** I-5.7 resolves my round-2 F5 by making the local step "a `scripts/checks/` file with its own sibling self-test". I read `check-gate-selftest-coverage.sh`: member set (1) enumerates **every** `scripts/checks/*.sh` and `*.mjs` and requires `scripts/__tests__/<base>.test.mjs|ts` or a debt entry. So the new local gate needs a sibling self-test. C4's subject is `scripts/__tests__/check-override-floor-staleness.test.mjs` only; O-1…O-9 and AC-4.1/4.3 are scoped to it; C5's acceptance criteria cover the step's behaviour (AC-5.4) but not its self-test. AC-4.2 requires the meta-gate to exit 0 with `gate-selftest-debt.txt` byte-identical, so the missing file reds — loudly, which is why this is Minor rather than Major, but it reds at the end of Phase 2 for a deliverable no contract commissioned.

**Recommended action.** Name the second test file in C4's subject line and give it the obligations that apply (O-1 pairing, O-3 reach, O-8 fixture hygiene). **Allow:** with both token vars unset, the step exits 0 and prints the skip line, the meta-gate exits 0, and the debt file is byte-identical. **Deny:** with a token and a scratchpad stale manifest, the step reds naming the package. **Red-prove:** delete the sibling self-test → the meta-gate reds with `MISSING_GATE_SELFTEST` naming the new path; delete the skip branch → the tokenless allow reds on the stdout assertion, not the exit code. **Fail loudly:** if neither meta-gate primitive matches any line in `pre-pr.sh`, that is an anchor failure, not a pass. **Do not** resolve it by adding a debt entry — AC-4.2 forbids it and the debt file is the suppression surface. **Boundary:** every file under `scripts/checks/` is in member set (1) the moment it exists. **Tie:** the step's `pre-pr` label, which member set (2) keys on and member set (1) does not.

*[Adjacent] Severity: Minor — this may overlap with Security's scope (raised there as SEC-R2-F8).* I-5.7 forbids the `queue_step "Static: …" bash -c` spelling in prose, correctly naming it as evasion of the meta-gate's anchor. The anchor is still `run_step[[:space:]]+"Static:[^"]*"[[:space:]]+bash[[:space:]]+-c`; measured in `pre-pr.sh` today: 47 `queue_step "Static:"` vs 13 `run_step "Static:"`, and 0 `queue_step … bash -c`. Headroom for widening the anchor to `(run_step|queue_step)` is zero, and a plan whose thesis is "a remembered rule that has failed is not a control" is leaving this one as a remembered rule.

### 9 — Severity: Minor — DESIGN — O-9's recorded fixture cannot discriminate the S3 filter under O-2, and never exercises the ecosystem clause

**Problem.** O-9 picks `lodash` "because `GHSA-r5fr-rjxr-66jc` carries four bands across four package names, so the fixture exercises S3 against reality". Measured, that advisory's four bands are:

```
npm:lodash          >= 4.0.0, <= 4.17.23 -> "4.18.0"
npm:lodash-es       >= 4.0.0, <= 4.17.23 -> "4.18.0"
npm:lodash-amd      >= 4.0.0, <= 4.17.23 -> "4.18.0"
npm:lodash.template >= 4.0.0, <  4.18.0  -> "4.18.0"
```

All four are `ecosystem: "npm"`, and all four carry the **same** floor. S3 has two clauses (`ecosystem === "npm" && name === pkg`); the ecosystem clause has no observable on this element at all. For the name clause, O-2 permits assertions on "package name, GHSA id, and the required floor" and forbids array length — and on this element the GHSA id is constant, the floor is constant, and the package name of an extracted band is same-package by construction. So every assertion O-2 permits passes identically with the filter present and with it deleted; only the band **count** distinguishes them, and O-2 forbids asserting on it.

O-9's other stated purpose — untrimmed, so a renamed field reds — is fully served and is the more important one. This is the narrower claim failing.

**Recommended action.** Keep the untrimmed `lodash` response and make the S3 case discriminating without touching O-2's rule. The same recorded file contains a `rubygems` band on another advisory (measured), and `nodemailer` carries a `maven` coordinate — either gives the ecosystem clause a real subject. **Allow:** `extractBands(element, "lodash")` yields the band whose range is `>= 4.0.0, <= 4.17.23`, and `extractBands(element, "lodash.template")` on the *same object* yields the one whose range is `>= 4.0.0, < 4.18.0` — two subjects, differing content, no length assertion. **Deny:** an element carrying only a non-npm coordinate for the subject → zero bands and the ecosystem clause named. **Red-prove:** delete the name filter → the two-subject assertion reds because both subjects return the same first band; delete the ecosystem filter → the non-npm deny reds. **Fail loudly:** the element not found by `ghsa_id`, or `withdrawn_at` non-null on it, is `FIXTURE_STALE` — a refusal, not a silently empty band list. **Do not** fix by trimming the fixture to the discriminating fields. **Boundary:** the fixture's job is to red on a shape change; the case's job is to red on a logic change — they need different assertions. **Tie:** `lodash-es`, whose band is byte-identical to `lodash`'s, so it is the one subject that proves nothing.

### 10 — Severity: Minor — PROSE — The census table's aggregate rows are not produced by the command written beside them, and the promised census command is not in the document

**Problem.** The member-set derivation says "Reproduce with the committed gate: `… --report`" above an eleven-row table, then states that "`--report` emits the structural rows and the per-package advisory counts; the aggregate advisory figures are a census, not a gate output, and are labelled as such with the command that produced them." No such command appears anywhere in the document, and the table does not mark which rows come from which instrument. Five rows (advisories returned, withdrawn, live same-package entries, null-patch, live unreviewed) are attributable only to the `--report` command printed above them, which the same paragraph says does not produce them. AC-6.2 then requires "every command in the new prose is executed once and its output matches what the doc claims" and that "the aggregate census figures are labelled as a census with the command that produced them" — a criterion with no command to execute.

All eleven figures are correct: I reproduced every one at `8d688731c`. This is provenance, not accuracy.

**Recommended action.** Split the table into a `--report` block and a census block, and write the census command beside the census block. **Allow:** the six member rows and their floors are unchanged by the split — they reproduce exactly and are the part that is already right. **Red-prove:** run the written census command and diff its output against the table; a row the command does not emit is a row with no provenance. **Fail loudly:** if any package is `undecidable` the census prints `CENSUS_INCOMPLETE` and suppresses the totals rather than printing a shrunk denominator — a smaller number that still prints is the shape that produced revision 2's 306. **Do not** drop the census table; it is what made revision 1's undercount findable. **Boundary:** no derived number appears in the plan or the runbook without the command that emits it. **Tie:** the per-package advisory counts, which `--report` does emit and which are also census inputs — they belong in both blocks, labelled once.

---

## Recurring Issue Check

- **R1** OK — N4 + C2's forbidden `function collectScopes` pattern; I re-read the real walker and the additive `pin`/`selfPins`/`parentKey` fields are transparent to `findOverlappingKeys` (destructures `{key, range}`) and `findAmbiguousEdges` (reads `.range`).
- **R2** OK — floors live only in the manifests; `check-dockerfile-prisma-pin.sh:68` reads only `/^brace-expansion@>=3/` (verified), which M4/M5 do not touch.
- **R3** Finding — 2 (the unparseable-string pin form and the non-object `overrides` root are not propagated to the new control), 6 (the `uses:` form is propagated to a prohibition list but not to C7's subject file).
- **R4** N/A — no event or notification dispatch.
- **R5** N/A — no transactions.
- **R6** N/A — no cascade deletes.
- **R7** N/A — no E2E selectors.
- **R8** N/A — no UI.
- **R9** N/A — no fire-and-forget work.
- **R10** OK — C3 imports C2 one-way; the disjointness gate imports nothing back.
- **R11** N/A.
- **R12** OK — no severity filter; C3 forbids one and the medium-severity M1 is the live proof it matters.
- **R13** N/A.
- **R14** N/A.
- **R15** N/A.
- **R16** OK — VE-1/VE-3/VE-4 name the parity gaps; I-5.6's probe is network-free and AC-5.4 asserts the skip line rather than the exit code. Residual is finding 8's missing self-test contract, a cost not a parity gap.
- **R17** OK — `collectScopes` and `semver.intersects` are both routed through the shared primitive (N3/N4).
- **R18** Finding (8) — `gate-selftest-debt.txt` is the allowlist AC-4.2 freezes while I-5.7 adds a file that member set (1) enumerates.
- **R19** OK — AC-2.1 keeps the 25 cases unedited and AC-2.2 adds assertions for each new field; no existing case deep-equals a `byPackage` entry.
- **R20** N/A.
- **R21** N/A — no sub-agent work; every number here is my own execution.
- **R22** OK — the plan extends `collectScopes` rather than reinterpreting it, and S1 records the no-`continue`-after-recursion behaviour rather than assuming it away.
- **R23** N/A.
- **R24** N/A.
- **R25** N/A.
- **R26** N/A.
- **R27** N/A.
- **R28** N/A.
- **R29** Finding (10, provenance only) — every one of the nine census figures reproduces exactly (25/24/1/18/158/6/223/0/0), as do M1–M6 with ids, severities, bands and floors, post-C1 zero members, the six lock-resolved versions, `ci.yml:687/716/743`, `pre-pr.sh:303`, `vitest.config.ts:11`, `check-override-key-disjointness.mjs:260`, `check-workflow-supply-chain.mjs:101-106`, `check-dockerfile-prisma-pin.sh:68`, the 25 disjointness cases and the `"."` case at :116. The one claim that does **not** reproduce is I-7.3's `release.yml:315` pipe (finding 5).
- **R30** OK — no autolink footguns.
- **R31** OK — AC-3.0 and AC-3.2 both run against scratchpad copies via argv and AC-3.0 asserts `git status --porcelain` empty afterwards; AC-4.3 mutates a scratchpad copy of the gate.
- **R32** OK — AC-5.3 requires an observed `gh workflow run` and AC-3.3 drives the shell as a process.
- **R33** OK — both the weekly workflow and the PR job are specified; I-5.3 refuses a paths filter, and `ci.yml`'s `changes` filter is opt-in via `needs:`, so no existing job must be touched.
- **R34** OK — SC-A…SC-G each carry a worst case, a likelihood, a cost and an owner; SC-E's likelihood argument rests on the 0-of-223 measurement, which I reproduced.
- **R35** OK — VE-1/VE-4 and AC-5.3/AC-5.4 give the manual paths.
- **R36** Finding (4) — the `process.env` prohibition, taken literally, deletes the proxy/endpoint refusal, which is a markerless weakening of the control that closes the ambient-input class.
- **R37** N/A.
- **R38** OK — S5/S6 give two remedies each, and the wedge was refuted by measurement (0 of 223 live null patches, reproduced).
- **R39** N/A — the only secret is the token; the `::` sanitizer must not echo headers, which O-4 covers.
- **R40** Finding (3) — the row/status shape does not carry the advisory-side refusals, so the strict consumer's partition is incomplete at the boundary.
- **R41** Finding (5, 6) — AC-7.1's deciding allow case has no backing artifact in the repo, and one of its five stated forms has no backing rule in its subject file.
- **R42** Finding (2, 3, 6) — three member sets are asserted rather than derived: the pin-shape refusals (strings excluded), N5's token/status set (four named outcomes unassigned), and the ambient-input probe set (two examples, not an enumeration). The pin/entry class itself (25/24/1/18) I re-derived independently with a second instrument and it is exact.
- **R43** OK — floors move up only, no new key (I-1.2, AC-1.5), no major crossed.
- **R44** Finding (5) — the pipe rule's exemption clause ships with no fixture that can red it, so the one form that reads a gate's exit through a lossy channel is unproven.
- **R45** OK — 18 sequential requests, linear; my own 18-query sweep completed well inside the bound.
- **R46** Finding (1) — the scope opener's children are resolved by position/spelling rather than by the binding the walker held at recursion time; executed collision at equal depth.
- **R47** OK for the bands — `semver.intersects` is the adjudicator and normalization is separator-only. The residual surface-form adjudication is `scopePath` (finding 1), which I-2.4 removed for identity but not for structure.
- **R48** OK — `npm audit`, Trivy, Dependabot and this gate are correctly distinguished, and VE-5 corrects the Trivy misconception by measurement. Finding 6 notes that one reading of the indirection rule would put an action-pin predicate in two gates.
- **R49** Finding (5) — "the tie that decides the pipe rule's shape" names an artifact that does not exist. Elsewhere the control-class declarations remain unusually honest: C1 "not a control", C3 "not an enforceable boundary", S12's residual, SC-G.
- **R50** Finding — walking every criterion for "would it fail if the thing it claims were false": AC-1.1/1.2/1.4/1.5 ✓; AC-1.3 ✓ (an absent root diff is a named stop condition); AC-2.1 ✓ (regression only, correctly labelled); AC-2.2 ✓ (names the record it inspects); **AC-3.0 ✗** (the argv form cannot carry the flag and swallows a bad path — finding 7); AC-3.1 ✓; AC-3.2 ✓ in content, ✗ in the same argv respect; AC-3.3 ✓ (S11 makes it executable — the round-2 Critical is closed); AC-3.4 ✓ (second instrument + `ENTRY_COUNT_DRIFT`); AC-4.1 ✓; AC-4.2 ✓ but see finding 8; AC-4.3 ✓ as an obligation (the loop is run and the pairing recorded as output); AC-5.1/5.2 ✓ (both name checks that exist and can fail — I ran neither's subject, but both are in `pre-pr.sh`); AC-5.3 ✓; AC-5.4 ✓; AC-6.1 ✓; **AC-6.2 partially ✗** (no census command exists to execute — finding 10); **AC-7.1 ✗** for 1 of 5 forms and vacuous for the pipe allow (findings 5, 6); AC-7.2 ✗ for the pipefail clause; AC-7.3 ✓; AC-7.4 ✓ (residual stated, and the code confirms `${{ true }}` *is* matched while other expression forms are not).
- **R51** Finding (1) — the scope opener's classification is bound to a formatted label rather than to the record the walker produced. C7's residual name-binding is acknowledged and given the indirection rule, whose trigger is unstated (finding 6).
- **R52** OK — the primitive was re-audited directly rather than inferred; that audit is what produced S1/S2/S9 and what produced finding 1. One behaviour change the plan does not flag as such: S1's "arrays are not recursed into" alters `into`'s contents, not just the fields on it. I executed the consequence — for `{"pkg": []}` the removed record is an empty scope that contributes no violations — so I-2.1 holds, but its stated justification (field additivity) does not cover the change.
- **R53** OK — 0 members after C1, 0 `AFFECTS_WITHOUT_MATCHING_BAND` across all 18, 0 null-patch, 0 unreviewed, 0 truncated: four independently measured zero-headroom enrolments, no suppression list, no tuned threshold. Findings 2 and 3 add two more branches with the same free headroom.
- **R54** OK in design, Finding in statement (4) — the host pin, `redirect: "error"` and the proxy refusal are the right closure; S11 states it as an absolute the design cannot satisfy, and the enumeration of what can suspend the control is two examples rather than a member set.
- **R55** Finding (3) — `clean` becomes the in-band sentinel for "no advisory matched the filter", which collides with the legitimate "this package has no advisories" (measured: 1 of 18 today).
- **R56** N/A.
- **R57** OK — pagination is refused rather than cursor-walked, and no package returns a `Link` header at `per_page=100` (re-measured across all 18, max 44 results).

---

```json
[
  {"id": "FUNC-R3-F1", "severity": "Major", "title": "S1's scope-opener-to-children linkage has no carrier; parentKey+depth is ambiguous and the forward scopePath reconstruction collides at equal depth (executed)", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 200, "adjacent": false, "escalate": null},
  {"id": "FUNC-R3-F2", "severity": "Major", "title": "String pins are never validated: PIN_NOT_A_RANGE covers only non-strings, so an unparseable pin on a package with no live bands is reported clean", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 200, "adjacent": false, "escalate": null},
  {"id": "FUNC-R3-F3", "severity": "Major", "title": "S10's four-way status partitions manifest-side outcomes only; NO_PATCH_AVAILABLE, UNIDENTIFIED_BAND, AFFECTS_WITHOUT_MATCHING_BAND and a failed $ref have no status, and each defaults to clean", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 209, "adjacent": false, "escalate": null},
  {"id": "FUNC-R3-F4", "severity": "Major", "title": "S11's absolute process.env prohibition contradicts the mandated GITHUB_API_URL/proxy refusal; the cheapest way to satisfy the forbidden pattern deletes the refusal", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 210, "adjacent": false, "escalate": null},
  {"id": "FUNC-R3-F5", "severity": "Major", "title": "I-7.3's tie does not exist: release.yml:315 is a redirect, not a pipe, so AC-7.1's deciding allow case is vacuous and AC-7.2's pipefail-clause mutation cannot red it", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 662, "adjacent": false, "escalate": null},
  {"id": "FUNC-R3-F6", "severity": "Major", "title": "C5 attributes all five forbidden forms to C7; uses:@v[0-9] has no rule in check-workflow-supply-chain.mjs, and C7's indirection member has no stated trigger", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 593, "adjacent": false, "escalate": null},
  {"id": "FUNC-R3-F7", "severity": "Major", "title": "AC-3.0/AC-3.2 need argv to carry a flag and paths; the cited precedent reads --report as a path and swallows ENOENT with exit 0 (executed)", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 469, "adjacent": false, "escalate": null},
  {"id": "FUNC-R3-F8", "severity": "Minor", "title": "I-5.7 requires a second scripts/checks gate whose sibling self-test no contract owns; AC-4.2 reds on the missing file", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 585, "adjacent": false, "escalate": null},
  {"id": "FUNC-R3-F9", "severity": "Minor", "title": "O-9's recorded fixture cannot discriminate the S3 filter under O-2 (four bands, one floor, one ecosystem) and never exercises the ecosystem clause", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 534, "adjacent": false, "escalate": null},
  {"id": "FUNC-R3-F10", "severity": "Minor", "title": "Census table: five of eleven rows are not produced by the one command written beside them, and the promised census command is absent, leaving AC-6.2 nothing to execute", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 123, "adjacent": false, "escalate": null}
]
```
agentId: a5530f4d42125e48a (use SendMessage with to: 'a5530f4d42125e48a', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 238259
tool_uses: 26
duration_ms: 982289</usage>

### Security expert — round 3

# Security Review: stale-override-floors (revision 3)
Date: 2026-08-06 · Round 3 · Reviewer: Security Engineer
Base: `8d688731c`, tree clean apart from the two untracked review docs. **No tracked file modified**; all experiments in `/tmp/sofr3`. Live API queried with an authenticated token (`gh`, 4990/5000 remaining at start, so no rate-limit artifact this round).

## Reproduction of revision 3's load-bearing numbers (R29)

Executed before any finding was written. Independent walk of the three tracked manifests + one query per distinct package name.

| Claim | Reproduction | Verdict |
|---|---|---|
| 25 walker entries / 24 pins / 1 scope opener / 0 `"."` / 0 unparseable | `entries 25, pins 24, scopes 1, selfpins 0, unparse 0`; per-manifest `19 / 2 / 3` **+1 nested** (root 19, cli 2, extension 4 — the extension's 4 = `rollup`, the `@crxjs/vite-plugin` opener, its nested `rollup`, `undici`) | **confirmed exactly** |
| 18 distinct package names | the same 18 names, alphabetically identical to revision 2's list | **confirmed** (but see F6a — 17 are judged, 1 is the scope opener) |
| 158 advisories / 6 withdrawn / 223 live same-package entries / 0 null-patch / 0 live unreviewed | `total 158, withdrawn 6, liveSame 223, nullPatch 0, unrevLive 0`; the six withdrawn are the same six GHSA ids | **confirmed exactly** |
| S12 layer 1 headroom: 0 advisories returned for `affects=X` lack an exact-npm-`X` band | `noMatchCount: 0` across all 18 | **confirmed exactly** |
| M1–M6: pins, lock resolutions, GHSA ids, severities, bands, floors, M3/M6 both → 8.5.23 | re-intersected every pin against every live same-package band via `semver.intersects` + `,→ ` normalization | **confirmed exactly** |
| Lock resolutions hono 4.12.31 / @hono/node-server 2.0.11 / root postcss 8.5.25 / cli postcss 8.5.23 | read from the three lockfiles | **confirmed** |
| Non-member `@crxjs/vite-plugin > rollup ^2.80.0` clean by one patch | `[]`; `GHSA-mw96-cpmx-2vgc` is `< 2.80.0` | **confirmed** |
| Canary `GHSA-rgw5-rvv9-x895` | `severity high`, `type reviewed`, `withdrawn_at null`, `updated_at 2026-08-03T20:17:20Z`, four npm bands, `>= 4.0.0, < 5.0.9` contains `5.0.8` | **confirmed** |
| O-9's fixture subject `GHSA-r5fr-rjxr-66jc` carries four bands across four package names | `lodash`, `lodash-es`, `lodash-amd`, `lodash.template`; live, `withdrawn_at null` | **confirmed** |
| `ci.yml:687/716/743` = `npm audit --omit=dev --audit-level=high` | exact | confirmed |
| `check-dockerfile-prisma-pin.sh:68` reads only `/^brace-expansion@>=3/` | exact | confirmed |
| `check-override-key-disjointness.mjs:260` argv form | `main(process.argv.length > 2 ? process.argv.slice(2) : undefined)` at **260** | confirmed |
| 25 disjointness cases; the `"."` case at `:116` | `25` `it(...)`; line 116 is `expect(findOverlappingKeys({ ".": "1.2.3", "pkg@1": "^1.0.0" })).toEqual([])` | confirmed |
| `check-workflow-supply-chain.mjs` `verifierLineRe` at `:101`, `maskRe` at `:106` | exact | confirmed |
| `vitest.config.ts:11` includes `scripts/__tests__/**/*.test.mjs` | exact | confirmed |
| `scripts/pre-pr.sh:303` queues `Static: workflow-supply-chain` | exact | confirmed |
| `actionlint` absent | `rg -l actionlint scripts/ .github/` → no match | confirmed |
| **`release.yml:315` is `npm audit signatures --json \| node -e …`, a legitimate pipe** | line 315 is `npm audit signatures --json --include-attestations > "$AUDIT_JSON"` — a **redirect**; the `node -e` is a separate command on the next line. **No verifier line in any workflow contains a shell pipe** | **refuted — F4** |
| **AC-3.2 shape 8: `rollup` reverted to `^4.21.0`, expect `GHSA-gcx4-mw62-g8wm`** | `^4.21.0` intersects **two** live bands; required floor is **4.59.0** from `GHSA-mw96-cpmx-2vgc`, not 4.22.4 from the advisory named | **refuted — F9** |

---

## Round-2 finding disposition

- **SEC-R2-F1** (host pin ⊥ AC-3.3; every cheap fix is an env test mode) — **PARTIALLY CLOSED.** The direction is right (parameter, not env) and AC-3.3 now requires the fixture's 200 to carry a canary-bearing payload, which was my clause-1 allow side. Remaining: the `process.env` forbidden pattern now contradicts the `GITHUB_API_URL`/proxy refusals I asked to be kept (F1); the seam moved to argv, which AC-3.0/AC-3.2 make necessary and nothing forbids (F2); my `ADVISORY_BASEURL_INJECTED_IN_MAIN` refusal was dropped with nothing in its place.
- **SEC-R2-F2** (single-package canary is not a positive control) — **CLOSED** in substance: three layers, both refusal tokens (`_FAILED` / `_REVISED`), per-package integrity with measured-0 headroom, residual stated as SC-G. Two details survive in F6. `CANARY_QUERY_FAILED` was not adopted, so a 5xx on the canary request itself falls into `undecidable` — acceptable, but it merges "retry is right" with "retry is wrong".
- **SEC-R2-F3** (C7 covers one of five weakening forms) — **PARTIALLY CLOSED.** Restating C7 as a member set of three primitives is the correct move. Not closed: the tie that decides the pipe rule's shape does not exist (F4); the indirection rule has no decidable predicate (F5); and my clause "bind the match to extracted `run:` commands, not raw `content`" was dropped by both experts' remedies and by revision 3 (F4).
- **SEC-R2-F4** (`"."` parent parsed backwards out of `scopePath`) — **CLOSED.** S2/I-2.4 carry `parentKey`/`parentName` on the scope record. Verified `splitOverrideKey("evil@1.0.0 || > 2.0.0")` → `evil` and `splitOverrideKey("@scope/pkg")` → `@scope/pkg`, so the tie holds. My "do not reject keys containing `' > '`" and "keep `scopePath` in the row" clauses were both honoured.
- **SEC-R2-F5** (3 of 4 hardening mechanisms untested) — **CLOSED.** O-4 names the host pin, shape validation, the `::` refusal, the `Map` cache, `AbortSignal`, the retry policy, both canary refusals and the integrity rule as requiring deny/allow pairs.
- **SEC-R2-F6** (S3 has no over-drop detector) — **CLOSED mechanically** by S12 layer 1. The "state both directions in S3" half was not done, and the tie I named was inverted — folded into F6b.
- **SEC-R2-F7** (306 / 7 unreproducible) — **CLOSED.** 223 / 6 stated and reproduced exactly. `CENSUS_INCOMPLETE` was not adopted; instead the aggregates are labelled a census outside `--report`, which is a defensible alternative and makes AC-6.2's "regenerate from `--report`" inapplicable to those rows by design.
- **SEC-R2-F8** (meta-gate anchors `run_step … bash -c`) — **PARTIALLY CLOSED.** I-5.7 forbids this plan's step from taking the evading shape, and I verified member set (1) (`ls scripts/checks/*.sh *.mjs` → sibling test or debt) does cover a new `check-override-floor-staleness-local.sh`, so AC-4.2 enforces it. The **class** is untouched: `check-gate-selftest-coverage.sh:170` still anchors on `run_step`, and `pre-pr.sh` re-measured at **47** `queue_step "Static:"` vs **13** `run_step "Static:"`. No SC row, no owner, no handoff item.
- **SEC-R2-F9** (S4 counts without naming; no authority statement) — **CLOSED.** "counted and **named**" plus "the PR run is authoritative for merge; the weekly run is detection".

---

## Findings

### SEC-R3-F1 — Severity: Major — DESIGN — The `process.env` forbidden pattern forbids the two refusals the hardening clause and AC-3.3 require, and the grep-checkable half is the one that will survive

**Problem.** Three clauses of revision 3 cannot all hold:

- Network-shell hardening: "refuse if `GITHUB_API_URL` or a proxy env var points elsewhere (`ADVISORY_ENDPOINT_NOT_PINNED`, `ADVISORY_PROXY_ENV_SET`)".
- AC-3.3, last clause: "`GITHUB_API_URL` set elsewhere refusing before any request".
- C3 forbidden patterns / S11 / I-3.7: "`process\.env` outside the token read"; "`main()` reads no environment variable that influences the endpoint, the canary, or the **verdict**".

Refusing on `GITHUB_API_URL` requires `process.env.GITHUB_API_URL`; refusing on a proxy requires `process.env.HTTPS_PROXY` and its siblings. Both are environment reads that change the verdict — they turn a `clean` run into a refusal — so they are inside I-3.7's prohibition and matched by the forbidden pattern. Revision 2's contradiction (host pin ⊥ local fixture) was replaced by a second one at the same seam.

The asymmetry decides which side survives: the forbidden pattern is a mechanically-checkable grep that will sit in a `scripts/checks` gate or a review checklist; the refusals are prose bullets whose only acceptance coverage is one AC-3.3 clause. Under implementation pressure the grep wins, the refusals are dropped, and the ambient path S11 exists to close stays open — the R54 class reproduced one level down.

Second half: the plan never enumerates *which* proxy variables (R42). Executed on Node v26.5.0 against a shell implementing the plan's exact pin:

```
HTTPS_PROXY=http://127.0.0.1:9/                       -> 200 from the REAL api.github.com (proxy ignored)
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9/  -> ECONNREFUSED 127.0.0.1:9 (proxy honoured)
```

So on the runtime this repo targets, the proxy vector needs **two** variables, and the gating one is `NODE_USE_ENV_PROXY`. Round 2's R54 row named it by name; revision 3 dropped the enumeration entirely and left "a proxy env var" as an unbounded phrase.

**Impact.** The gate's only stated defences against a redirected advisory source are a host pin (which a dispatcher bypasses without changing the URL) and refusals the plan forbids implementing. A gate that cannot read `process.env` cannot detect that its transport has been redirected, and every stated verdict is then a verdict about whatever answered.

**Recommended action.**
1. *Deny + allow.* Replace the blanket prohibition with a **positive allowlist of env reads**: `GH_TOKEN`, `GITHUB_TOKEN`, and the named ambient-refusal set — `GITHUB_API_URL`, `NODE_USE_ENV_PROXY`, `HTTP_PROXY`/`http_proxy`, `HTTPS_PROXY`/`https_proxy`, `ALL_PROXY`/`all_proxy`, `npm_config_proxy`, `npm_config_https_proxy`, `NODE_EXTRA_CA_CERTS`, `NODE_OPTIONS` (F3). Forbidden pattern becomes "`process.env.<name>` where `<name>` is outside the allowlist", which is still a grep and no longer forbids the refusals. **Allow side that must still succeed:** a run with none of these set, and a run with `GH_TOKEN` set, must reach `api.github.com` and exit 0 on a clean tree — the ordinary CI path, which an over-eager refusal would take down repo-wide (I-5.3 has no paths filter).
2. *Red-prove each clause separately, by execution.* (a) delete the `GITHUB_API_URL` read → the AC-3.3 clause-6 case greens and must red; (b) delete the `NODE_USE_ENV_PROXY` member → a case setting `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=…` and asserting `ADVISORY_PROXY_ENV_SET` before any socket greens; (c) widen the allowlist to `.*` → a case asserting an unlisted `process.env` read is refused greens. Three mutations, three cases.
3. *Fail loudly.* `ADVISORY_ENDPOINT_NOT_PINNED`, `ADVISORY_PROXY_ENV_SET` (naming *which* variable), and a new `AMBIENT_ENV_UNRECOGNISED` when a read reaches an unlisted name — never a silent continue, and never a refusal message that omits the variable name, or the operator cannot clear it.
4. *Do not fix by deleting what made the defect visible.* Do not resolve this by dropping `ADVISORY_PROXY_ENV_SET` and `ADVISORY_ENDPOINT_NOT_PINNED` so the grep passes. Those two refusals are the only thing in the plan that sees a redirected transport; the prohibition exists to stop a *test-mode* env read, not to blind the gate to its own environment.
5. *Boundary and tie.* The boundary is "an env read that can only **refuse**" vs "an env read that can **redirect**". The tie: `GITHUB_API_URL` set to exactly `https://api.github.com` — it must be allowed to proceed (a legitimate GHES-free default), while `GITHUB_API_URL` set to anything else refuses; that is the one value where reading-to-refuse and reading-to-redirect are indistinguishable from the outside, and the plan must say which it is.

---

### SEC-R3-F2 — Severity: Major — DESIGN — The parameter seam did not remove the ambient-input surface, it moved it to argv, where the plan forbids nothing and AC-3.0/AC-3.2 make a flag parser mandatory

**Problem.** S11 draws the boundary at environment variables and claims the parameter form is what "lets the shell be process-tested against a local fixture server without an env-var test mode". Three facts make the argv surface the live one:

- The shape block itself says so: `async function main(manifests = discoverManifests(), {baseUrl, canary} = DEFAULTS)  // argv-overridable`.
- AC-3.0 and AC-3.2 require `--report` **and** scratchpad manifest paths to be passed "via the argv form (`main(manifests)`, the entry point `check-override-key-disjointness.mjs:260` already uses)". Verified at that line: `main(process.argv.length > 2 ? process.argv.slice(2) : undefined)` — **every** argv element becomes a manifest path. Under the cited form `--report` is read as a path. So the new gate must add flag/path separation that no contract in revision 3 specifies.
- AC-3.3 requires the shell driven "**as a process**" reaching the fixture "by the `baseUrl` parameter". A spawned process receives parameters through argv unless the harness spawns `node -e 'import("…").then(m => m.main(…))'`. The plan names neither route.

Once a flag parser exists — and AC-3.0 forces one — `--advisory-base` is one line away (it is precisely what the round-2 Testing expert recommended), and nothing forbids it: the C3 forbidden-pattern list covers `process.env` only. The consumer that matters is a workflow `run:` line, and C7's mechanism inspects those lines for *exit masking*, not for flags. The seam therefore migrates from a surface the plan greps to a surface the plan neither greps nor governs, reachable from the one file C7 does govern.

**Impact.** R49/R54. The claim "`main()` reads no environment variable influencing endpoint, canary or verdict" is true and no longer sufficient: after this change the endpoint and canary are influenced by argv, which is caller-controlled by construction, and the plan's own scenario 5 ("a redirected `GITHUB_API_URL` … the canary fails and the gate exits 1") is silent about a redirected `--advisory-base`, against which nothing fires.

**Recommended action.**
1. *Deny + allow.* Specify argv parsing as a contract clause, not as a side effect: elements beginning `--` are flags drawn from a **closed** set (`--report` only); everything else is a manifest path; an unrecognised `-`-leading element is `UNKNOWN_FLAG` and refuses. State explicitly that `{baseUrl, canary}` is **not reachable from argv in any form** and that the self-test crosses the boundary by `import` + direct call inside a spawned `node -e` harness. **Allow side that must still succeed:** `--report` with no paths still falls back to `discoverManifests()` and reports on the real tree (the operator's invocation, C6's runbook line), and `main(["/tmp/x/package.json"])` still walks exactly that file.
2. *Red-prove each clause separately, by execution.* (a) add a `--advisory-base` alternative to the flag set → a new case asserting `UNKNOWN_FLAG` for it must red; (b) delete the flag/path split → the AC-3.0 invocation reports `ENOENT`-shaped nothing instead of a report, and a case asserting the report's entry count must red; (c) delete the `UNKNOWN_FLAG` branch → a case passing `-x` and asserting a refusal reds.
3. *Fail loudly.* `UNKNOWN_FLAG`; `MANIFEST_UNPARSEABLE` for a path that does not resolve (the sibling's `main` swallows this with `continue`, which is how a mistyped scratchpad path in AC-3.0 would report "0 members" from an empty walk); and `EMPTY_WALK` when a run yields zero rows of any kind, since an empty report is the shape both a correct clean tree and a broken invocation produce.
4. *Do not fix by deleting what made the defect visible.* Do not resolve this by dropping AC-3.3's process-level requirement or AC-3.0's argv invocation — those are round-1's RT5 fix and round-2's RT9 fix respectively. The fix is to name the route, not to remove the criterion that needs one.
5. *Boundary and tie.* The boundary is "the caller supplies **what to check**" (manifests, `--report`) versus "the caller supplies **who answers**" (`baseUrl`, `canary`); the first crosses on argv, the second only by import. The tie: a `baseUrl` whose host **is** `api.github.com`, supplied by import — allowed (a recorded-response replay against the real host must keep working); the same value supplied on argv — refused, because the route is what is being judged, not the value.

---

### SEC-R3-F3 — Severity: Major — DESIGN — The ambient-input member set omits the vectors that defeat every stated check, and SC-G defers the residual on a false equivalence. Executed.

**Problem.** Revision 3 replaced round 2's measured seven-vector enumeration with one rule (S11) and one sentence (S12: "TLS to a public CA, the host pin, and the refusal on proxy / `GITHUB_API_URL` env are what stand between the gate and that adversary"). Executed against a shell implementing the plan's exact hardening — `new URL(endpoint).host === "api.github.com"`, `protocol === "https:"`, `encodeURIComponent(pkg)`, `redirect: "error"`:

```
node gate-sim.mjs                                   -> {"status":200,"body":"[{\"ghsa_id\":\"GHSA-rgw5-rvv9-x895\",…"}
NODE_OPTIONS="--import ./patch.mjs" node gate-sim.mjs -> {"status":200,"body":"[{\"ghsa_id\":\"FORGED\"}]"}
node --import ./patch.mjs gate-sim.mjs               -> {"status":200,"body":"[{\"ghsa_id\":\"FORGED\"}]"}
```

`patch.mjs` is four lines replacing `globalThis.fetch`. Every stated check passes; so does the canary, because a patched `fetch` serves it. `NODE_EXTRA_CA_CERTS` is the same class on the TLS leg. Neither is named anywhere in revision 3, and — the compounding part — F1's forbidden pattern **forecloses the only in-process fix**, since refusing on `NODE_OPTIONS` requires reading it.

Two shapes of reach, and the plan costs only the harder one:

- **SC-G's dismissal is false as an equivalence.** "requires defeating TLS to a public CA or controlling the runner's egress, at which point the same adversary can edit the gate." Setting `NODE_OPTIONS` or `NODE_EXTRA_CA_CERTS` requires *environment* control — a self-hosted runner, a compromised action, a developer's shell when `pre-pr` runs the local step. Editing the gate requires a PR through CODEOWNERS review. A weaker capability is being priced as the stronger one, and that pricing is the entire ground on which SC-G is deferred (R49 applied to a scope-contract row).
- **C5's weakening-form member set covers exit-status *discarding*, not verdict *forging* (R42).** `env: NODE_OPTIONS: --import ./x.mjs` on the gate's step, or `run: node --import ./x.mjs scripts/checks/check-override-floor-staleness.mjs`, is not `continue-on-error`, is not a mask, matches no member of the five, and is invisible to C7's widened `runsVerifier`/`verifierLineRe`/`maskRe`. It reads in a diff as a tuning knob. By the plan's own standard — `continue-on-error` is forbidden *despite* CODEOWNERS, because "a remembered rule that has failed three times is not a control" — this shape belongs in the member set or in a stated, costed residual.

**Impact.** The plan's strongest claim about the gate ("every outcome that is neither checked-and-clean nor checked-and-stale is a violation") is conditional on the process having been started with an unmodified runtime, which nothing in the plan or in CI asserts. Not Critical: reaching it requires environment or workflow-file control, both of which sit behind other controls, and no secret is disclosed — the failure is a forged *clean* verdict on a supply-chain check.

**Recommended action.**
1. *Deny + allow.* Add three members to C5's forbidden-form list, each with a mechanism in C7: an `env:` block on the gate's step or job setting `NODE_OPTIONS` / `NODE_EXTRA_CA_CERTS` / `NODE_USE_ENV_PROXY`; a `node` invocation of the gate carrying `--import`, `--require`, `--experimental-loader` or `--conditions`; and any invocation of the gate whose command is not exactly `node <literal-path> [--report]`. In the gate itself, add the corresponding refusals under F1's allowlist. **Allow side that must still succeed:** the ordinary step `- run: node scripts/checks/check-override-floor-staleness.mjs` with `env: GITHUB_TOKEN: …` must stay green, and an unrelated workflow's `env: NODE_OPTIONS:` must stay green — the ban is scoped to the gate's own invocation, not repo-wide, or it collides with I-7.2.
2. *Red-prove each clause separately, by execution.* Four mutations: drop the `NODE_OPTIONS` alternative → the `env:`-fixture reds; drop the `--import` alternative → the flag fixture reds; drop the exact-command rule → a `bash -c "node …"` fixture reds; broaden the rule repo-wide → the unrelated-workflow allow fixture reds.
3. *Fail loudly.* `GATE_INVOCATION_NOT_LITERAL`, `GATE_RUNTIME_ENV_INJECTED` (naming the variable), and in-process `AMBIENT_RUNTIME_MODIFIED` when `process.execArgv` or the allowlisted env names carry a loader — a refusal, never a warning line.
4. *Do not fix by deleting what made the defect visible.* Do not resolve this by broadening SC-G to "any adversary with process control wins, so nothing is worth doing" — that is the sentence being challenged, and the measurement above is what refutes it. Keep S12's honest residual paragraph; correct only the capability equivalence.
5. *Boundary and tie.* The boundary is the process's runtime configuration, which is fixed **before** the gate's first statement and therefore cannot be closed by any rule about what the gate reads. The tie: `NODE_OPTIONS` set for an unrelated reason on a runner-wide basis (`--max-old-space-size`) — it must not red, so the refusal keys on loader-bearing flags, not on the variable's presence, and that distinction must be written down or the first false red gets the check deleted.

---

### SEC-R3-F4 — Severity: Major — PROSE + DESIGN — C7's tie does not exist: `release.yml:315` is a redirect, no verifier line in the repo contains a pipe, AC-7.1's named allow case is unbuildable, and the real trap (the block-scalar `run: |` header and comment text inside the joined logical line) is unnamed

**Problem.** I-7.3 states: "`release.yml:315` (`npm audit signatures --json | node -e …`) is a legitimate pipe on a verifier line and must stay green. It is the tie that decides the pipe rule's shape." AC-7.1 requires a fixture built from "`release.yml`'s real pipe". Read at `8d688731c`:

```
315:          npm audit signatures --json --include-attestations > "$AUDIT_JSON"
316:          node -e '
...
321:          ' "$AUDIT_JSON"
```

A **redirect**, then a separate command. Both round-2 experts mis-cited this and revision 3 promoted the mis-citation to a locked invariant and an acceptance fixture.

I then replicated `findMaskedVerifierViolations`'s logical-line joiner over all seven workflow files and asked which verifier-matching logical lines contain a `|`:

```
release.yml:210  pipeAlt=true  pipefail=true  first-pipe-context: '        run: | set -euo pipefail echo "Asserting SLSA '
release.yml:268  pipeAlt=true  pipefail=true  first-pipe-context: '        run: | set -euo pipefail WORK=$(mktemp -d) tra'
(15 other verifier-matching logical lines: pipeAlt=false)
```

The only `|` in either is the **YAML block-scalar header** `run: |`, folded into the logical line by the joiner. There is no shell pipe on any verifier line anywhere in the repository. Three consequences:

- **AC-7.1's allow case cannot be written.** The named real-world fixture does not exist — the round-2 defect class ("cases unwritable against the signature block") reproduced inside the contract added to retire it.
- **The rule shape was chosen against a constraint that does not exist.** With zero legitimate pipes repo-wide, the strictly simpler and stronger rule — *no pipe on a verifier line at all*, headroom 0, no threshold, no suppression (R53) — was rejected for a weaker, harder one whose correctness depends on where `pipefail` appears relative to a pipe. Naming a nonexistent tie as the deciding evidence is R29 applied to a rationale.
- **The trap that will actually bite is unnamed.** A naive trailing-pipe alternative (`\|(?!\|)`, round 2's own suggestion) false-positives *every* block-scalar verifier step, because the joined text begins `run: |`. release.yml's two survive only by accident: they happen to contain `set -euo pipefail` in the same joined string, for reasons unrelated to any pipe. A block-scalar step running the new gate **without** `pipefail` and **without** any pipe would be denied.

Compounding, and dropped from both round-2 remedies: `verifierLineRe` and `runsVerifier` match **raw content including comments**. Of the 17 verifier-matching logical lines in the repo today, **11 are pure comment lines**. Once `verifierLineRe` is widened to a literal gate path, a comment reading `# never write "node …check-override-floor-staleness.mjs || true"` becomes a violation of itself, and `runsVerifier` (whole-file, raw content) marks any workflow that merely *mentions* the gate in a comment as verifier-running — which under I-7.2's deliberately whole-file scope turns its unrelated `continue-on-error` into a violation.

**Impact.** C7 is the contract that converts C5's prohibitions from a remembered rule into a control. Shipping it against a fabricated tie and an unbuildable allow fixture produces either a rule that over-blocks the natural spelling of the new workflow (which gets it edited out), or one softened until it matches release.yml for the wrong reason. Either outcome leaves the gate's exit status maskable, which is the fail-open R44 guards.

**Recommended action.**
1. *Deny + allow.* Correct I-7.3: state that the repo has **zero** legitimate pipes on verifier lines (measured), and choose the rule on that basis. Match against `extractRunCommands(...)` — the export that already exists in this file at `:234`, strips comments and block-scalar headers, and is what `findPublishJobIsolationViolation` uses — rather than against raw joined lines. Then the pipe rule can be the simple one: a verifier command containing an unquoted `|` is a violation unless the same `run:` body sets `pipefail`. **Allow side that must still succeed:** `release.yml` and `dependency-signatures.yml` green **unedited** (AC-7.3, correctly present), *and* a `run: |` block-scalar step that runs the new gate with no pipe and no `pipefail` — the natural spelling of C5's own job — must be green.
2. *Red-prove each clause separately, by execution.* (a) revert the `extractRunCommands` substrate to raw content → a fixture whose only `|` is the `run: |` header must red, proving the substrate clause; (b) drop the `pipefail` exception → a `set -euo pipefail` + `gate | tee` fixture reds; (c) drop the pipe alternative → the `gate | tee` deny fixture reds; (d) revert `verifierLineRe`'s widening → the `gate || true` fixture reds; (e) revert `runsVerifier`'s widening → the `continue-on-error` fixture reds. Five mutations, five fixtures, run singly.
3. *Fail loudly.* A workflow whose `run:` bodies cannot be extracted (an unparsed block form) is `WORKFLOW_RUN_UNPARSED` — a violation, not a skip; and a fixture asserting `[]` that contains no `verifierLineRe` match at all is `FIXTURE_VACUOUS`, asserted before its emptiness is read.
4. *Do not fix by deleting what made the defect visible.* Do not delete the pipe clause because no real pipe exists — the absence is the headroom, not the argument against the rule. And do not narrow the whole-file scope of `runsVerifier` while extending it, or the existing `npm audit signatures` coverage in `ci.yml`, `release.yml` and `dependency-signatures.yml` regresses.
5. *Boundary and tie.* The boundary is between a `|` that is YAML and a `|` that is shell; today **every** `|` on a verifier line in this repo is the former, which is precisely why the substrate clause must be red-proven separately. The tie is `release.yml:268`'s 3690-character joined block, where a whole-file or whole-block `pipefail` search returns true for reasons unconnected to any pipeline — a rule that greens it must be able to say which pipeline the `pipefail` protects.

---

### SEC-R3-F5 — Severity: Major — DESIGN — C7's indirection rule has no decidable predicate, and the whole mechanism is switched off by removing the gate's own invocation

**Problem.** C7 closes the R51 half of the member set with: "bind the workflow-level flag to what the workflow *runs*, not to a spelling — an `npm run` alias for the gate must not silently flip the flag off (R51). Cheapest sufficient form: forbid indirection (`WORKFLOW_INVOKES_GATE_INDIRECTLY`) so the gate may only be invoked by literal path."

To *forbid* indirection something must *detect* it. Measured in `.github/workflows/`: **18 real `npm run` invocations** across `ci.yml`, `release.yml` and `ci-integration.yml` (20 lines mention `npm run`; two are comments). A blanket ban on `npm run` is a non-starter. Deciding "this alias resolves to the gate" requires reading `package.json`'s `scripts` — the option C7 explicitly declines as the expensive one. What remains is a prohibition with no adjudicator.

The implementable reading collapses to a **presence assertion** — "the new workflow must contain the gate's literal path" — which C7 never states, and which needs a member set of workflow files it never defines. And that exposes the structural fail-open: the entire C7 mechanism is conditional on a workflow self-identifying as verifier-running by containing that string. Delete the `run:` line from `override-floor-staleness.yml` and `runsVerifier` goes false, `verifierLineRe` matches nothing, and the file is silently exempt — a gate whose enforcement is disarmed by removing its own invocation, with nothing in the diff for the mechanism to see.

**Impact.** The R51 half of C7's member set — the half added because "widening one of three is how the correction reproduces the defect it corrects" — ships without a mechanism, inside the contract written to stop exactly that. And the mechanism that does ship is silent-when-absent rather than silent-when-healthy, so a green `check-workflow-supply-chain` is compatible with the gate not running at all.

**Recommended action.**
1. *Deny + allow.* Invert the primitive: make the **presence** assertion the rule and derive the indirection ban from it. Name the member set of workflow files that MUST invoke the gate by literal path (the new sweep workflow, and the `ci.yml` PR job), and make a missing literal invocation `WORKFLOW_MISSING_GATE_INVOCATION`. Then `WORKFLOW_INVOKES_GATE_INDIRECTLY` becomes decidable: within those files, a step whose command is not the literal path is a violation, regardless of what the alias resolves to. **Allow side that must still succeed:** the 18 existing `npm run` invocations in the other workflows stay green with no new entries anywhere, and `ci.yml`'s other jobs keep using `npm run` freely — the rule is scoped to steps that are supposed to be *this* gate, not to `npm run` as a form.
2. *Red-prove each clause separately, by execution.* (a) delete the gate's `run:` line from the sweep workflow → `WORKFLOW_MISSING_GATE_INVOCATION` must red (today: silence); (b) replace it with `npm run check:override-floors` → `WORKFLOW_INVOKES_GATE_INDIRECTLY` reds; (c) remove one file from the required set → a case asserting both files are required reds; (d) apply the rule repo-wide → the 18-`npm run` allow fixture reds.
3. *Fail loudly.* `WORKFLOW_MISSING_GATE_INVOCATION`; `WORKFLOW_INVOKES_GATE_INDIRECTLY`; and `REQUIRED_WORKFLOW_ABSENT` when a member of the required set does not exist as a file — deleting the workflow must be louder than deleting the step, not quieter.
4. *Do not fix by deleting what made the defect visible.* Do not drop the R51 clause on the grounds that `npm run` indirection is hypothetical — the repo uses that spelling 18 times, which is why the round-2 finding named it. And do not satisfy it by banning `npm run` in workflows.
5. *Boundary and tie.* The boundary is between "this workflow happens to mention the gate" (today's `runsVerifier` semantics) and "this workflow is required to run the gate" (a declared member set). The tie is `ci.yml`, which is *already* verifier-running via three `npm audit signatures` steps and therefore cannot discriminate the widening — so the sweep workflow is the only file whose behaviour the new rule changes, and every mutation proof must name it rather than `ci.yml`.

---

### SEC-R3-F6 — Severity: Minor — DESIGN — S12's three layers: layer 1 is genuinely baseline-free and measures 0, but the queried set is 17 judged + 1 unjudged, the detector's false-red mode is unnamed, and the canary re-imports a smaller version of the byte-exactness problem it removed

**Problem.** Layer 1 is derivable without a baseline — confirmed; I reproduced the headroom independently (`0` advisories returned for `affects=X` lack an exact-npm-`X` band, across all 18). Three properties stated around it do not hold as written.

**(a) The 18 is 17 judged plus 1 never judged, and layer 1's named allow case is the odd one.** Measured: distinct names over **pins** is **17**; the 18th, `@crxjs/vite-plugin`, is the scope opener, which S1 excludes from pin judgement. The plan queries 18 (VE-3's request budget, layer 1's "0 violations across all 18", layer 3's "per-package advisory count for all 18", and S12's allow example "`@crxjs/vite-plugin`, which returns 0 advisories, must still pass"). No clause states that the fetch set is derived from **all** yielded rows rather than **judged** rows. The natural implementation derives it from judged rows, silently turns every "18" into 17, and removes the one package the layer-1 allow case names — including from the R53 headroom measurement that is the plan's stated evidence that layer 1 costs nothing.

**(b) Layer 1's refusal has no member for "the advisory names the subject under a non-npm ecosystem".** Round 2's tie was explicit: such a band "is *not* a band (correct today) but *is* evidence the advisory is about the subject, so it satisfies the detector rather than tripping it." Revision 3's rule (`≥1 ecosystem === "npm" && package.name === X`) trips it. The shape already exists in this corpus — `nodemailer` carries `maven:org.webjars.npm:nodemailer` bands. Measured: **0** advisories currently carry *only* a non-npm subject band, so the headroom is real; but the false-red mode is unnamed, its token would be `AFFECTS_WITHOUT_MATCHING_BAND` (indistinguishable from the genuine over-drop it exists to catch), and its only remedy is editing the rule — the operator pressure the canary was restructured to remove.

**(c) Layer 2's `severity === "high"` clause is false-red surface with no channel-liveness value.** The canary's job is "this query returned real advisory data for this package". `withdrawn_at === null` plus a `brace-expansion` band containing `5.0.8` already establishes that. GitHub re-scoring `GHSA-rgw5-rvv9-x895` is at least as likely as the band re-split the plan removed byte-exactness for, and it lands on `ADVISORY_SOURCE_CANARY_REVISED` — honestly named, which is why this is a cost and not a hole, but it is a self-inflicted red on the one constant the plan says must not be edited to make a red go away.

**Impact.** Presentational for (c), latent for (a) and (b). (a) is the load-bearing one: the plan's R53 headroom argument for layer 1 is measured over a set whose derivation rule is unwritten and which two reasonable implementations disagree about.

**Recommended action.** State the fetch-set primitive explicitly — "the distinct `name` over **every** row `collectOverridePins` yields, judged or not, including `scope` rows" — and say why (the scope opener's own advisories are what a future `"."` self-pin would be judged against, per scenario 7). Add `AFFECTS_SUBJECT_FOREIGN_ECOSYSTEM_ONLY` as a distinct outcome from `AFFECTS_WITHOUT_MATCHING_BAND`, and adopt round 2's tie: a band naming the subject under a non-npm ecosystem satisfies the detector. Drop `severity === "high"` from layer 2. **Allow side:** `@crxjs/vite-plugin` (0 advisories) stays a pass under layer 1 and is *present* in `--report`'s per-package list; `nodemailer` (13 advisories, one carrying a Maven coordinate) stays a pass. **Red-prove separately:** derive the fetch set from judged rows only → a case asserting 18 per-package report lines reds; delete the foreign-ecosystem branch → a fixture whose only subject band is `maven:` reds on the wrong token; delete the `5.0.8` containment assertion → the `_REVISED` case reds. **Fail loudly:** a fetch-set name that `collectOverridePins` yielded but that never reached the map is `PACKAGE_QUERY_MISSING`, distinct from `undecidable`. **Do not** fix (a) by dropping `@crxjs/vite-plugin` from the census — it is the vacuous-truth allow case layer 1 needs. **Boundary and tie:** the boundary is between rows that are *judged* and rows that are *queried*; the tie is the scope opener, which is the only row in the repo today on the wrong side of it.

---

### SEC-R3-F7 — Severity: Minor — DESIGN — S10's four-way status has no member for "not judged", so a scope opener must be reported `clean` — the R55 shape the plan says it fixed, one field over

**Problem.** I-3.1: `scope` rows are "**Not judged** because their children were". S10: `status` is a four-way partition `clean | stale | refused | undecidable`, with exit 1 on the last three. A scope row must therefore carry `clean`. N5 says the opposite: "Every outcome that is neither 'checked and clean' nor 'checked and stale' is a violation with its own named token, never a pass" — a scope opener is neither, so N5 would deny it, which is absurd.

So `clean` carries two meanings: "compared against live bands, no intersection" and "never compared". `--report`'s clean rows and AC-3.4's "0 in the member set" both aggregate them. This is precisely the collision S10 was written to remove from `undecidable` (revision 2 "collapsed a malformed pin into the same bucket as an unreachable API — the in-band-sentinel shape (R55) it had just fixed elsewhere"), relocated to the adjacent field.

**Impact.** No live exposure — one row, `@crxjs/vite-plugin`, and its children are judged. The forward risk is the precedent: the next `kind` added to `collectOverridePins` inherits "unjudged ⇒ `clean`" with nothing in the diff to review, and I-3.1's "no silent skip" becomes a claim about a vocabulary that cannot express the distinction it asserts.

**Recommended action.** Add a fifth status, `not-applicable`, exit-neutral, reachable **only** from `kind === "scope"` whose scope satisfied S1's children test. **Allow side:** a scope opener whose children were judged yields exactly one `not-applicable` row and its children's own rows, and the run still exits 0. **Deny side:** the same shape with an empty scope yields `EMPTY_SCOPE` / `refused` and exits 1. **Red-prove separately:** map `not-applicable` onto `clean` → a case asserting the two appear distinctly in `--report` reds; make an unknown `kind` default to `clean` → a case injecting a synthetic kind and asserting a refusal reds. **Fail loudly:** any row whose `kind` is outside the enumerated set is `ROW_KIND_UNRECOGNISED`, a refusal — never a default. **Do not** fix this by deleting the `scope` kind and dropping scope openers from the report; their presence is what makes S1's children test observable. **Boundary and tie:** the boundary is "the gate compared this pin to live bands" vs "the gate had nothing to compare"; the tie is the empty scope, which the plan already routes to `EMPTY_SCOPE` and which is the only input where `not-applicable` and `refused` are one edit apart.

---

### SEC-R3-F8 — Severity: Minor — DESIGN — S8's truncation predicate rests on a header the plan's own threat model lets an intermediary strip, and the body-side check is neither adopted nor recorded as a residual

**Problem.** S8: "A `Link` header carrying only `rel="prev"`/`rel="last"` is **not** truncation — the predicate is `rel="next"`, not a `"next"` substring." The `rel="next"` half is right and is the correct fix to round 2's substring hazard. The half that was dropped is the body-side one: round 2's tie was "treat exactly `per_page` elements with no `Link` as truncated."

The truncation signal now lives entirely in a response **header** while the evidence lives in the **body**. S12's stated threat model is an intermediary that shapes per-package responses; stripping a header is strictly cheaper for that intermediary than shaping a body. Measured today: no `Link` on any of the 18 at `per_page=100`, and the largest list is `hono` at **44** (undici 35, nodemailer 13) — real headroom, but `hono` has already grown to 44 and the gate's own rationale (VE-2) is that this input moves.

**Impact.** A truncated list read as complete is a `clean` verdict over an unexamined tail — the exact "could not check spelled as checked" failure the whole plan exists to close, reached without any adversary at all once one package crosses 100.

**Recommended action.** Add `advisories.length >= per_page ⇒ ADVISORY_LIST_TRUNCATED` alongside the `rel="next"` predicate; one comparison, headroom 56 on the largest package, no threshold to tune (R53). **Allow side:** the 18 real packages today, none of which has a `Link` and the largest of which is 44, must all stay `clean` — the check must not fire on a short list; and a 99-element list with no `Link` must stay clean. **Deny side:** a 100-element list with no `Link` denies. **Red-prove separately:** delete the length clause → the 100-element fixture greens; delete the `rel="next"` clause → the `Link: rel="next"` fixture greens; relax `rel="next"` to a `"next"` substring → the `rel="prev", rel="last"` allow fixture reds. **Fail loudly:** a `Link` header present but unparseable is `ADVISORY_LINK_HEADER_MALFORMED`, a refusal, never "no next". **Do not** fix this by paginating — S8's refusal-over-pagination decision is correct and is what keeps the request count linear (R45). **Boundary and tie:** the boundary is exactly `per_page`; the tie is a list of exactly 100 that genuinely has no more, which under this rule denies — state that as a deliberate fail-closed cost, since the remedy (raise `per_page`, or paginate) is available and the alternative is a silent short read.

---

### SEC-R3-F9 — Severity: Minor — PROSE — R52/R29 residuals: C2's enumerated change set omits the one non-additive change S1 requires, and AC-3.2's eighth shape names the lower-floor advisory of an unrecognized multi-band case

**Problem.** Two separable items, both about the plan describing its own change inaccurately.

**(a) C2 vs S1 (R52).** C2 enumerates its changes as additive: `pin` on `byPackage` and `unparseable`, `selfPins`, `parentKey`/`parentName`, the parent key carried down. S1 additionally requires "A value that is an **array or any non-plain object** … is **not recursed into**." Read against the real walker (`check-override-key-disjointness.mjs:99-110`): `if (value !== null && typeof value === "object") collectScopes(...)` with **no `continue`**, so `{"pkg": ["1.0.0"]}` today recurses and yields a nested scope whose child package is literally named `"0"`. Adding `!Array.isArray(value)` changes what `collectScopes` **returns** to `findOverlappingKeys`, an existing shipped security gate that iterates the same array — so it is a behaviour change to a control, and the only non-additive item in the set. I-2.1 ("No existing caller's behavior changes") is therefore false in the general case, and AC-2.1 cannot detect it: none of the 25 existing cases uses an array-valued override. The direction is a narrowing (the phantom `"0"` scope disappears) and is probably an improvement — which is exactly why it must be enumerated in C2 with its own deny/allow pair rather than arriving as a side effect of a semantic-decision row.

**(b) AC-3.2 shape 8 (R29).** The plan writes "the `$ref` target `rollup` (reverted to `^4.21.0`, expect `GHSA-gcx4-mw62-g8wm`)". Measured live at `8d688731c`:

```
rollup ^4.21.0 -> GHSA-mw96-cpmx-2vgc [high] >= 4.0.0, < 4.59.0  -> 4.59.0
                 GHSA-gcx4-mw62-g8wm [high] >= 4.0.0, < 4.22.4  -> 4.22.4    required floor: 4.59.0
```

Two intersecting bands; the required floor comes from the advisory the plan does **not** name. (Shape 7 checks out: `^2.79.0` intersects `mw96` `< 2.80.0` → 2.80.0 and `gcx4` `< 2.79.2` → 2.79.2, max 2.80.0, which is what the plan names.) This matters past typography: the plan asserts M3 and M6 "are the only multi-band members, and they are why that rule exists", and O-5 exists to give `max(first_patched_version)` a deterministic case. Shape 8 is a third live multi-band instance, unrecognized as such, cited by its lower floor. An implementer writing the assertion to the plan's stated expectation either reds for the wrong reason (loud) or reconciles it by weakening `max` toward `first`/`min` (silent) — the single direction O-5 exists to prevent.

**Impact.** (a) an invariant stated, false, and untestable by the criterion meant to hold it (R50). (b) a mis-cited expectation on the criterion that red-proves the gate's nested and `$ref` paths.

**Recommended action.** Move the array/recursion-guard change into C2's change list with its own invariant ("`findOverlappingKeys` no longer sees a synthesised child scope for an array-valued override") and its own AC-2.2 assertion; reword I-2.1 to "no existing caller's behavior changes **for any input reachable from npm's overrides grammar**", which is the true and defensible claim. Correct AC-3.2 shape 8 to name **both** GHSA ids and floor **4.59.0**, and label it as the third multi-band instance — it is free live coverage for O-5, which otherwise has only injected fixtures once C1 clears M3 and M6. **Allow side:** shapes 1–7 keep their current expectations, all of which reproduce exactly; the 25 disjointness cases stay green unedited. **Red-prove separately:** remove `!Array.isArray` → a new C2 case asserting `{"pkg": ["1.0.0"]}` yields one `PIN_NOT_A_RANGE` row and **no** child named `"0"` reds; change `max` to `first` → shape 8's floor assertion reds while its GHSA-id assertion stays green (which is why the floor must be asserted, not the ids alone). **Fail loudly:** a derived package name outside npm's name grammar — `"0"` is the live example — is `PACKAGE_NAME_UNRECOGNISED` and is refused **before** any query, so a manifest-controlled string never reaches an outbound URL. **Do not** fix (b) by dropping shape 8 from AC-3.2 — the `$ref` path is the one AC-3.2 exists to reach. **Boundary and tie:** for (a) the boundary is "value is a scope" vs "value is a pin", and the tie is `{}` — a scope with no children under S1 and a non-range under `PIN_NOT_A_RANGE` — which the plan currently assigns to both; for (b) the boundary is one band vs several, and the tie is two intersecting bands whose floors differ, where `first`, `min` and `max` all return a plausible version.

---

## Recurring Issue Check

- **R1** OK — N4 + C2's forbidden `function collectScopes` pattern; verified the real walker supports the extension. No second walker proposed.
- **R2** OK — floors live only in the manifests; `check-dockerfile-prisma-pin.sh:68` reads only `/^brace-expansion@>=3/`, verified, and M4/M5 do not touch that key.
- **R3** **Fires — F3, F5.** The verdict-forging weakening forms and the `npm run` indirection form are enumerated in prose and propagated to no mechanism.
- **R4** N/A — no event or notification dispatch.
- **R5** N/A — no transactions.
- **R6** N/A — no cascade deletes.
- **R7** N/A — no E2E selectors.
- **R8** N/A — no UI.
- **R9** N/A — no fire-and-forget work.
- **R10** OK — C3 imports C2's exports one way; no back-edge.
- **R11** N/A.
- **R12** OK — no severity filter; the C3 forbidden pattern on `severity === 'high'|'critical'` is present and would have caught the medium band that hid M1.
- **R13** N/A.
- **R14** N/A.
- **R15** N/A.
- **R16** OK — VE-1/VE-3/VE-4 name the parity gaps; VE-3 is now a suite-level token precondition with a named refusal; I-5.6's probe is network-free. My own run was authenticated, so I could not re-observe the 60/h exhaustion; round 2's observation stands unrefuted.
- **R17** OK — C3 is the only new consumer of the extended primitive.
- **R18** **Fires — F3.** C5's forbidden-form list is not synchronized with the runtime-injection surface that decides the gate's verdict; `maskRe`/`verifierLineRe` remain the allowlists and F4 shows their substrate is unsynchronized too.
- **R19** OK — AC-2.2 adds assertions for `pin`, `selfPins`, `parentName` and the unparseable pin, and names `topLevelScope(...)` rather than `scopes[0]`; verified the walk is post-order at `:110-118`.
- **R20** N/A.
- **R21** N/A — no sub-agent work; every number re-derived by me.
- **R22** OK — the plan extends `collectScopes` and audits it rather than reinterpreting it. F9a is a gap in the *enumeration* of that extension, not a perspective inversion.
- **R23** N/A.
- **R24** N/A.
- **R25** N/A.
- **R26** N/A.
- **R27** N/A.
- **R28** N/A.
- **R29** **Fires — F4, F9b.** `release.yml:315` is a redirect, not a pipe (executed); AC-3.2 shape 8's expected advisory is the lower-floor one of two. Everything else in revision 3 reproduces exactly — see the reproduction table: 25/24/1/0/0, 18 names, 158/6/223/0/0, all six members with ids, severities, bands and floors, the canary's five properties, the `lodash` fixture's four bands, `ci.yml:687/716/743`, `check-dockerfile-prisma-pin.sh:68`, `check-override-key-disjointness.mjs:260`, 25 cases and `:116`, `check-workflow-supply-chain.mjs:101/106`, `vitest.config.ts:11`, `pre-pr.sh:303`, `actionlint` absent, all six lock resolutions, and layer 1's measured-0 headroom.
- **R30** OK — no autolink footguns.
- **R31** OK — AC-3.0 now carries AC-3.2's scratchpad-copy wording and asserts `git status --porcelain` empty; AC-4.3 mutates a scratchpad copy of the gate.
- **R32** OK — AC-5.3 requires an observed `gh workflow run`; AC-3.3 exercises the shell as a process (subject to F2's unnamed route).
- **R33** OK — seven workflow files enumerated; only `ci.yml` carries PR gate jobs; `dependency-signatures.yml` is the right precedent; I-5.3's no-paths-filter decision is implementable without touching `ci.yml`'s opt-in `changes` job.
- **R34** **Fires (minor) — disposition of SEC-R2-F8.** The `queue_step … bash -c` meta-gate gap is closed for this plan's instance by I-5.7 and left open as a class with no SC row and no owner; re-measured 47 vs 13.
- **R35** OK — VE-1/VE-4 and AC-5.3/AC-5.4 give the manual paths; AC-5.4 asserts the printed skip line rather than the exit code.
- **R36** **Fires — F3, F4, F5.** Verdict-forging via `--import`/`NODE_OPTIONS` is markerless and unforbidden; the pipe rule's substrate makes its own enforcement unreliable; the whole C7 mechanism is disarmed by removing the gate's invocation.
- **R37** N/A.
- **R38** OK — S5/S6 name two exits each; SC-E/SC-F record the revisit trigger; 0-of-223 null patches reproduced, so the wedge stays refuted.
- **R39** OK — the only secret is the token; the `::` sanitizer's scope is output lines, not headers. Worth one line in C6 confirming the sanitizer never echoes request headers.
- **R40** OK — `extractBands` returns `{bands, skipped:{withdrawn, foreignPackage}}`, the map entry carries `{ok, advisories, truncated, reason}`, and `validateAdvisoryShape`/`parseLinkTruncation` are exports. Round 2's shape gaps are closed. Confirmed against the live API that `first_patched_version` is a bare **string** on this endpoint, not `{identifier}` — round 2's Testing note to the contrary does not apply here.
- **R41** **Fires — F5.** `WORKFLOW_INVOKES_GATE_INDIRECTLY` is a declared refusal with no adjudicator that can produce it.
- **R42** **Fires — F1, F3, F5.** Three member sets are incomplete: the proxy-variable set (unnamed; `NODE_USE_ENV_PROXY` is the gating one, measured), the ambient-input set (`NODE_OPTIONS`/`--import`/`NODE_EXTRA_CA_CERTS` absent), and C7's weakening-form set (verdict forging, and the presence of the invocation itself). The pin/entry member set (25/24/1/18) and the member table are correct and independently re-derived.
- **R43** OK — floors move up only, no new keys (I-1.2, AC-1.5), no major crossed; C2 and C7 both widen primitives and both are audited below/above.
- **R44** **Fires — F4, F5.** The mechanism that keeps the gate's exit status unmaskable is specified against a nonexistent tie, its allow fixture is unbuildable, and its enforcement is conditional on the file naming the gate.
- **R45** OK — 18 sequential requests, linear, ~840 KB; `AbortSignal.timeout` and `timeout-minutes: 5` bound it, and O-4 now requires cases for both.
- **R46** OK — `parentKey`/`parentName` carried structurally; `splitOverrideKey` verified correct for `evil@1.0.0 || > 2.0.0` → `evil` and `@scope/pkg` → `@scope/pkg`. Round 2's F4 is closed. Residual `"0"` phantom name folded into F9a with a pre-query refusal.
- **R47** **Fires — F4.** `verifierLineRe`/`maskRe` adjudicate a surface form (the joined YAML text, comments and block-scalar header included) where the shell defines the meaning; measured, 11 of the 17 matching logical lines are comments and both `|` matches are YAML. `extractRunCommands` — the repo's own resolver-shaped export — exists and is not used by this rule.
- **R48** OK — `npm audit`, Trivy, Dependabot and this gate are correctly distinguished; AC-3.0 retires the scratchpad twin with an executable command and a `git status` assertion.
- **R49** **Fires — F2, F3, F5.** "`main()` reads no environment variable" is narrower than the boundary it is used to claim (F2); SC-G's capability equivalence is stronger than the mechanism (F3); C7's indirection prohibition is a declared closure of R51 with no predicate (F5). Control-class declarations remain unusually honest elsewhere — C1 "not a control", C3 "not an enforceable boundary", C5's "the scheduled half is detection", S12's residual paragraph, S9's own admission that completeness resting on another gate is a claim stronger than the mechanism.
- **R50** **Fires — F1, F9a.** AC-3.3's `GITHUB_API_URL` clause cannot be implemented under the forbidden pattern; I-2.1 is asserted by AC-2.1, which cannot observe the only change that could falsify it.
- **R51** **Fires — F5.** The workflow-level flag remains bound to a spelling, and the rule meant to fix that has no adjudicator.
- **R52** **Fires (audited) — F9a.** `collectScopes` audited directly rather than inferred: `pin`, `selfPins`, `parentKey`, `parentName` are safe additions (no existing case deep-equals a `byPackage` entry or a scope object; `findOverlappingKeys` destructures `{key, range}`, `findAmbiguousEdges` reads `.range`); the `"."` skip at `:99` precedes the `typeof` recursion at `:100`, so I-2.3's no-new-recursion constraint holds. The one non-additive change (`!Array.isArray` on the recursion guard) is required by S1 and enumerated nowhere in C2 — F9a. `check-workflow-supply-chain.mjs` audited directly: `runsVerifier` is whole-file over raw `content`, `verifierLineRe` is per-joined-logical-line including comments and the `run: |` header, and `maskRe` contains no `set +e` and no pipe alternative — F4.
- **R53** OK, and extended — 0 members post-C1, no suppression list, no threshold; layer 1's headroom independently reproduced at 0 across 18. F4 identifies a fourth free-headroom enrolment the plan declined on false evidence (0 pipes on verifier lines repo-wide), and F8 a fifth (`length >= per_page`, headroom 56).
- **R54** **Fires — F1, F2, F3.** Executed enumeration of what the stated design stops: `GITHUB_API_URL` — **only appears stopped**, because the refusal that stops it is forbidden by the plan's own pattern (F1); HTTP 3xx to another host — **stopped** (`redirect: "error"`); path/query injection from a manifest key — **stopped** (`encodeURIComponent`); `HTTP_PROXY`/`HTTPS_PROXY` alone on Node 26.5.0 — **not honoured by `fetch`**, so not a vector today; `NODE_USE_ENV_PROXY=1` + a proxy var — **honoured, and only appears stopped** for the same reason as `GITHUB_API_URL`; `NODE_OPTIONS=--import` and `node --import` — **not stopped**, executed, returns a forged payload through every check including the canary; `NODE_EXTRA_CA_CERTS` — **not stopped**; DNS/`/etc/hosts` — **stopped only by TLS**, i.e. by nothing in the plan; argv-supplied `baseUrl` — **not stopped and not forbidden** (F2).
- **R55** **Fires — F7.** `clean` now carries both "compared and no intersection" and "never compared"; the sentinel moved from `undecidable` to `status: clean` rather than being removed. Round 2's `undecidable` collision is genuinely fixed by S10's fourth member.
- **R56** N/A.
- **R57** **Fires (minor) — F8.** Pagination is refused rather than cursor-walked, which is right, but the refusal's evidence is a strippable header while the body-side signal is unused and unrecorded.
- **RS1** N/A — no credential comparison.
- **RS2** N/A — no new route.
- **RS3** OK — shape validation is an export (`validateAdvisoryShape`), fail-closed at the boundary, and O-4 now requires a deny/allow pair for it. The forward-compatibility allow (an unexpected extra field must not refuse) is not stated in O-4 and is worth one clause.
- **RS4** OK — no PII in the plan or any proposed artifact; the recorded `lodash` fixture is public advisory data.
- **RS5** **Fires — F1, F3.** The advisory response is an untrusted externally-supplied security parameter whose only transport pinning is TLS to a public CA plus a host pin; `NODE_EXTRA_CA_CERTS` and `--import` defeat the transport leg entirely, and the refusals that would cover the remaining env leg are forbidden by the plan's own pattern. Major rather than Critical because reaching it requires environment or workflow-file control.
- **RS6** OK — the only transform is `/,\s*/g → " "`, single-pass, no escape sequences; the `::`-prefix refusal is retained with its allow side (a band and summary containing `<`, `>` and quotes must survive intact), and O-4 requires the pair.

---

```json
[
  {"id":"SEC-R3-F1","severity":"Major","title":"C3's `process.env` forbidden pattern forbids the GITHUB_API_URL and proxy refusals the hardening clause and AC-3.3 require; the grep-checkable half wins and the ambient path stays open","file":"docs/archive/review/stale-override-floors-plan.md","line":466,"adjacent":false,"escalate":false},
  {"id":"SEC-R3-F2","severity":"Major","title":"The parameter seam moved the ambient-input surface to argv, which AC-3.0/AC-3.2 make mandatory and nothing forbids; a --advisory-base flag is reachable from a workflow run: line","file":"docs/archive/review/stale-override-floors-plan.md","line":281,"adjacent":false,"escalate":false},
  {"id":"SEC-R3-F3","severity":"Major","title":"Ambient-input member set omits NODE_OPTIONS/--import and NODE_EXTRA_CA_CERTS (executed: a forged advisory array passes every stated check), and SC-G defers the residual on a false capability equivalence","file":"docs/archive/review/stale-override-floors-plan.md","line":250,"adjacent":false,"escalate":false},
  {"id":"SEC-R3-F4","severity":"Major","title":"C7's tie does not exist: release.yml:315 is a redirect, no verifier line in the repo has a pipe, AC-7.1's allow fixture is unbuildable, and the run: | header plus comment text inside the joined logical line is unnamed","file":"scripts/checks/check-workflow-supply-chain.mjs","line":101,"adjacent":false,"escalate":false},
  {"id":"SEC-R3-F5","severity":"Major","title":"C7's indirection rule has no decidable predicate (18 real npm run invocations in workflows), and the whole mechanism is disarmed by removing the gate's own invocation","file":"docs/archive/review/stale-override-floors-plan.md","line":652,"adjacent":false,"escalate":false},
  {"id":"SEC-R3-F6","severity":"Minor","title":"S12: the queried set is 17 judged + 1 unjudged with no stated derivation rule, layer 1's foreign-ecosystem false-red is unnamed, and the canary's severity clause re-imports the byte-exactness cost","file":"docs/archive/review/stale-override-floors-plan.md","line":230,"adjacent":false,"escalate":false},
  {"id":"SEC-R3-F7","severity":"Minor","title":"S10's four-way status has no member for 'not judged', so a scope opener must be reported clean — the R55 collision relocated from undecidable to clean","file":"docs/archive/review/stale-override-floors-plan.md","line":209,"adjacent":false,"escalate":false},
  {"id":"SEC-R3-F8","severity":"Minor","title":"S8's truncation predicate rests on a strippable Link header while the body-side length check is dropped and unrecorded (measured headroom: largest list 44 of 100)","file":"docs/archive/review/stale-override-floors-plan.md","line":207,"adjacent":false,"escalate":false},
  {"id":"SEC-R3-F9","severity":"Minor","title":"C2 omits the non-additive !Array.isArray recursion-guard change S1 requires (I-2.1 false and untestable by AC-2.1), and AC-3.2 shape 8 names the lower-floor advisory of an unrecognized multi-band case","file":"docs/archive/review/stale-override-floors-plan.md","line":386,"adjacent":false,"escalate":false}
]
```
agentId: abf0d1de9b9869c38 (use SendMessage with to: 'abf0d1de9b9869c38', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 240690
tool_uses: 27
duration_ms: 984913</usage>

### Testing expert — round 3

# Plan Review Round 3 — Testing (QA Engineer)

## Round-2 finding disposition

- **TEST-F14** (AC-3.3 unexecutable — host pin vs local fixture server) — **NOT CLOSED**. The plan-level answer owed (env-var seam vs parameter seam) was given: S11 makes endpoint/canary parameters and forbids `process.env`. But the two clauses that make AC-3.3 *run* are still unstated: how a **spawned process** receives a parameter S11 calls "reachable only by direct import", and whether the host pin judges a parameter-supplied base. See F1.
- **TEST-F15** — CLOSED BY DECISION (O-6). The generalization beyond this one clause is not carried anywhere — F4.
- **TEST-F16** — CLOSED BY DEFERRAL. The 13-row table is gone; AC-4.3 records pairings as observed output.
- **TEST-F17** — CLOSED BY DECISION (O-5).
- **TEST-F18** — CLOSED BY DECISION (O-1's one-axis rule; O-4 keeps the severity non-filter covered).
- **TEST-F19** — CLOSED BY DECISION. `parseLinkTruncation`, `validateAdvisoryShape` and `formatReport` are exports; O-3 converts any residual into a shape defect.
- **TEST-F20** — CLOSED BY DECISION (S9 + C2 `pin` on `unparseable` + I-2.2 + O-7).
- **TEST-F21** — PARTIALLY / NOT CLOSED. Scratchpad wording and the `git status --porcelain` assertion landed. The argv clause did not: `main(process.argv.length > 2 ? process.argv.slice(2) : undefined)` makes every argv element a manifest path, and the read loop swallows `ENOENT` with `continue` (`:217-227`). See F2.
- **TEST-F22** — CLOSED BY DECISION (VE-3; 8 × 18 = 144 checks out). One consequence unhandled — F7.
- **TEST-F23** — CLOSED BY DECISION (S1).
- **TEST-F25** — PARTIALLY / NOT CLOSED. C7 as a member set is right. The pipe clause's allow case is fictional and AC-7.1's fixture set contains a form this check has no rule for — F3.
- **TEST-F26** — PARTIALLY. I-5.7's anchor claim verified against the real gate (`check-gate-selftest-coverage.sh:170`), so `queue_step … bash -c` does evade set (2). What remains unstated is **where the token probe lives** — F6.
- **TEST-F27** — CLOSED BY DECISION on the contradiction (O-9). **I withdraw clause (5)**: I claimed `first_patched_version` is an object. Executed against the live endpoint: `"first_patched_version": "4.18.0"` — a bare string. The plan's scalar treatment is correct and my round-2 tie was wrong. Residual — F9.
- **TEST-F28** — CLOSED BY DEFERRAL.

## Findings

### F1 — Critical — DESIGN — AC-3.3's process seam contradicts S11 and the host pin; the network shell is still reachable by no executable test

Three sentences cannot all hold: S11 says the endpoint and canary are "function parameters … reachable only by direct import"; the shape block says `main(..., {baseUrl, canary} = DEFAULTS)  // argv-overridable`; AC-3.3 says the shell is "driven as a process … reached by the `baseUrl` parameter". A spawned process cannot be handed a function parameter. Either the parameter is import-only, and AC-3.3's five fixture-server cases cannot run as a process; or argv carries it, and S11's "only by direct import" is false with the argv contract undeclared (F2). Separately, the hardening block still reads `new URL(endpoint).host === "api.github.com"`, so a `baseUrl` of `http://127.0.0.1:<port>` is refused even with an argv seam. The plan never says whether the pin judges the default endpoint or the effective one.

**Impact.** `fetchAdvisories`, `main`, the retry policy, the canary's two refusals, the `refused`/`undecidable` partition and `--report`'s exit code are reached by AC-3.3 and nothing else. If AC-3.3 cannot execute, the fail-closed half ships untested for a second revision, and O-4's obligations for the host pin, `AbortSignal` and the retry policy have no surface. One clause wide, but an unstated clause is the one Phase 2 resolves by weakening the pin, markerless in the diff.

**Recommended action.** State that the effective origin comes from exactly two places — a compiled-in default and an explicit argv flag — and that the pin's subject is *how the origin was supplied*: an ambient origin (`GITHUB_API_URL`, proxy vars, `NODE_EXTRA_CA_CERTS`) is refused unconditionally, an argv origin is accepted, the default is pinned. Allow paired with deny: the no-flag path still resolves to `https://api.github.com` and still refuses on a proxy var — same fixture, one axis. Red-prove separately: delete the ambient refusal → the "env points elsewhere" process case reds; delete the default pin → a case asserting the default's origin reds; delete the canary → a fixture serving `[]` for the canary with a stale floor reds. Named refusals: `AC33_FIXTURE_UNAVAILABLE`, `AC33_TIMEOUT`, `AC33_WRONG_TOKEN`. Do not resolve by dropping the pin, adding an env test-mode, or demoting AC-3.3 to an in-process import. Boundary: "origin supplied by an explicit diffable argument" vs "by ambient state"; tie: `--advisory-base https://api.github.com` on plain `http:`.

### F2 — Major — DESIGN — No argv contract is declared, and four acceptance criteria depend on one

AC-3.0, AC-3.2, AC-3.3 and AC-5.4 each require pointing the gate at something other than the tracked tree. The only entry form named is `check-override-key-disjointness.mjs:260`, which treats every argv element as a manifest path with `ENOENT → continue` (`:217-227`). So `--report` becomes a path, is silently skipped, and a mistyped scratchpad path yields an empty walk reporting clean. AC-5.4 is worse: the `pre-pr` step invokes the gate with no arguments, so a scratchpad-copied stale manifest is not in `discoverManifests()`'s walked set — AC-5.4's red half cannot be produced without editing a tracked manifest, which AC-3.0's rule forbids. The same primitive carries two silent-skip behaviours into C3 via N4 (`ENOENT → continue`, and `git ls-files` failure → `FALLBACK_MANIFESTS`), both contradicting N5, and neither has a token.

**Recommended action.** Declare the argv contract in C3's shape block: `--` elements are flags, the rest are manifest paths, an unrecognized `-…` is `UNKNOWN_FLAG`. Give the read loop and discovery their own refusals — `MANIFEST_UNREADABLE`, `MANIFEST_DISCOVERY_FALLBACK`. Restate AC-5.4's red half as a direct invocation with the scratchpad path. Allow: `--report` with no paths still falls back to `discoverManifests()`. Red-prove separately: unknown flag → assert the token; nonexistent path → `MANIFEST_UNREADABLE`; `git` off `PATH` → `MANIFEST_DISCOVERY_FALLBACK`. A `--report` producing zero rows is `EMPTY_WALK`. Boundary: pre-C1 vs post-C1 manifest content; tie: `cli/package.json`.

### F3 — Major — DESIGN — C7's pipe rule is decided by a tie that does not exist, and the real workflow reds under the obvious implementation

I-7.3 says `release.yml:315` is `npm audit signatures --json | node -e …`. Executed: it is `npm audit signatures --json --include-attestations > "$AUDIT_JSON"` — a **redirect**. `grep -rn "audit signatures.*|" .github/workflows/` returns nothing: no verifier line in the repo has a pipe. AC-7.1's "release.yml's real pipe" allow case cannot be written from the cited instance.

The real constraint is different. `findMaskedVerifierViolations` joins `run: |` block scalars into one logical line (`:73-89`), so a rule scoped to "the verifier line" is scoped to the whole block. I copied the check to scratchpad, widened `verifierLineRe` and added a naive pipe alternative to `maskRe`, and ran it over the real workflows: `release.yml orig=0 widened=2` (`:210`, `:268`). `release.yml:210` legitimately contains `echo "$VIEW" | node -e "…dist?.attestations…"` under `set -euo pipefail` — so the plan's stated rule is right in spirit and **this** is the true tie; a rule not looking for `pipefail` in the same joined line breaks AC-7.3 on contact. The block-scalar header and JS `||` inside the block are two more false-red surfaces.

Separately, AC-7.1 asks for fixtures covering "each of the five forms". One of the five is `uses:@v[0-9]`, which `check-workflow-supply-chain.mjs` has no rule for — that belongs to `check-actions-sha-pinned.sh`. And C7's own `WORKFLOW_INVOKES_GATE_INDIRECTLY` has no fixture and no mutation.

**Recommended action.** Rewrite I-7.3 around `release.yml:210` and state the predicate is evaluated on the joined logical line, treating `pipefail` in that line as protection. Move `uses:@v[0-9]` onto AC-5.1. Give the indirection clause its own fixture and mutation. Allow: `release.yml:210` yields `[]` **and** is asserted to match `verifierLineRe` first; the new workflow's unmasked run yields `[]`; a non-verifier workflow keeps `|| true`. Red-prove: revert each alternation singly. Do not remove the block-scalar joining — its own tests pin it. Boundary: "the pipeline's status is the verifier's" vs "the last stage's"; tie: `release.yml:210`.

### F4 — Major — DESIGN — AC-4.3 records *that* a case red, never *why*

With `normalizeBand` deleted, `semver.intersects` throws, and I-3.2 makes a throw a violation — so a case expecting a violation stays green and one expecting `[]` reds for the wrong reason. O-6 encodes this for band normalization only. The trap is general: `$ref` resolution, the S3 filter, the unparseable branches and `extractBands` all sit upstream of a throw-capable call, and a mutation that makes the gate throw reds every allow case at once — a maximally convincing run that proves nothing.

**Impact.** The recorded pairing is the artifact Phase 3 reviews, and "mutation M → case C red" is indistinguishable on paper between "the verdict changed" and "the code threw". This is the property no test run reveals, which is what belongs in the plan.

**Recommended action.** Each recorded pairing names the observed failure **mode** — the asserted content that changed. A red produced by a refusal token or an exception other than the clause under test is `MUTATION_WRONG_CAUSE`. Prefer expression edits over deletions where a deletion would throw. Allow: the pair's allow half must be recorded as still passing under the mutation; a mutation reding both halves is too coarse or throwing. Tokens: `MUTATION_INCONCLUSIVE`, `MUTATION_WRONG_CAUSE`, `MUTATION_INEFFECTIVE`. Do not soften I-3.2. Boundary: "mis-parsed" vs "not parsed at all"; tie: a fixture both comma-separated and non-intersecting after normalization.

### F5 — Major — DESIGN — Nothing forbids an expectation computed by the thing under test, and the canary constant is where that is a false green

AC-3.4 states the rule for one number (the second instrument). It survives nowhere else; O-1…O-9 contain no clause about where an expectation comes from. The instance that matters is the canary: S12 layer 2 defines it as a constant and calls it "the one constant that must not be edited", and O-4 requires a deny/allow pair for its two refusals. If that fixture is built from the gate's exported canary constant — the obvious way, and the way that survives a re-split — then editing the constant cannot red anything. AC-4.3 mutates the *code*; the change an operator is tempted to make is to the *constant*.

**Recommended action.** Add an obligation generalizing AC-3.4: no expected value is produced by the code under test or read from a constant it also reads; identity-bearing constants are spelled literally in the test. Allow paired with deny on one fixture: the canary present passes; its `ghsa_id` altered by one character raises `ADVISORY_SOURCE_CANARY_FAILED`; its `severity` changed raises `ADVISORY_SOURCE_CANARY_REVISED`. Red-prove: edit the gate's canary constant on the scratchpad copy — id, then severity, then the contained version — and confirm each reds a named case; if none do, the case is `EXPECTATION_NOT_INDEPENDENT`. Do not return to a byte-exact band comparison. Boundary: channel dead vs constant stale; tie: an advisory present but re-split.

### F6 — Major — DESIGN — Where the token probe lives is unstated, and one reading makes the CI job pass without checking

I-5.6 says the local step probes without a network call; I-5.7 says the local step is a `scripts/checks/` file with its own sibling self-test. Three readings: (1) the probe lives in `pre-pr.sh` outside the step, wrapping a direct gate invocation — the house pattern (`pre-pr.sh:678-690`, the Postgres probe) — and works; (2) the probe lives **inside the gate**, in which case "no token → exit 0 with a skip line" is a gate property both CI jobs inherit, and any run with an absent or empty token greens without checking — a fail-open ambient branch, the same R54 shape S11 closes for the endpoint; (3) a new `scripts/checks/*.sh` wrapper, which member set (1) keys on file existence (`:118-143`), so it needs its own sibling self-test — C4 names only one test file and AC-4.2 forbids a debt line, so AC-4.2 reds.

I-5.7's supporting claims check out: set (2) anchors on `run_step … bash -c` (`:170`), and the repo has 13 such gates matching 13 debt entries and zero `queue_step … bash -c`.

**Recommended action.** State that the probe is shell logic in `pre-pr.sh` outside the step, and that the gate has no token-absent branch: without a token it makes its requests, is rate-limited, and exits 1. Allow paired with deny: token present → the step is dispatched and counted in the tally; token absent → the skip line prints and the tally is unchanged. Red-prove: unset both vars → assert the skip line; invoke the gate directly with no token → assert exit 1 with the rate-limit token. Decide and write down the token-present-but-offline cell — VE-1's offline property and I-5.6's probe cannot both hold there. Do not resolve with `|| true`. Boundary: token present vs absent; tie: token present but offline.

### F7 — Minor — DESIGN — VE-3's suite-level token precondition would block the two criteria that require a token-absent environment

VE-3 makes a token a precondition for the whole suite with an up-front refusal. AC-5.4's second half requires both token vars unset; AC-3.3's fixture cases need no token and reach no API. Nothing exempts either. A verifier implementing VE-3 as a preflight cannot execute AC-5.4b, and will record it blocked or satisfy it by reasoning.

**Recommended action.** Scope VE-3's refusal to steps that reach the API, naming AC-5.4b and AC-3.3's fixture cases as deliberate exceptions. Red-prove in order: unset both vars and run a live-API criterion → `ACCEPTANCE_PRECONDITION_NO_TOKEN`; unset both and run AC-5.4b → green with the skip line. Route a present-but-rejected token (401) to `ADVISORY_AUTH_REJECTED`, distinct from rate-limit. Boundary: "this step reaches api.github.com"; tie: the `pre-pr` run, which reaches it in one branch and not the other.

### F8 — Minor — PROSE — "18 distinct package names queried" is only derivable under a rule the plan does not state

An independent walk (no shared code with `collectScopes`) reproduces the structural rows exactly — 25 entries, 24 pins, 1 scope opener, 0 `"."`, 0 unparseable — but the distinct package names carried by **pins** is **17**. The plan's 18 is reachable only by also querying `@crxjs/vite-plugin`, the scope opener, which S1 says is not judged. The plan's own S12 sentence "`[]` is unconditionally clean for the other **17**" confirms the intended arithmetic.

Three things hang off it: VE-3's budget (18/sweep, 144 for AC-3.2), S12 layer 1's "0 violations across all 18", and layer 3's per-package counts whose advisory-free witness *is* `@crxjs/vite-plugin`.

**Recommended action.** State in S1 that a scope opener's parent name **is** queried, and record 17 pin names + 1 scope-opener parent = 18. Allow paired with deny: a manifest whose only entry is a scope opener still produces one query and one report row; a manifest with a pin and a scope opener for the same package produces one query, not two. Red-prove: drop scope-opener names → the report row count falls to 17 and AC-3.4's second instrument reds on the symmetric difference. Boundary: "judged" vs "queried"; tie: `@crxjs/vite-plugin` itself.

### F9 — Minor — DESIGN — O-9's stated purpose has no trigger

O-9 requires the recorded response untrimmed "because a fixture trimmed to the fields the gate reads cannot red when a field the gate reads is renamed — which is the one thing it exists to do". A committed fixture is static: an upstream rename leaves it carrying the old name and the case green. What bounds an upstream rename is `validateAdvisoryShape` failing closed against the **live** response. The fixture's real property is the other direction — it pins the gate's reading to a shape the API demonstrably emitted (RT1). Nothing states a regeneration trigger or staleness signal.

**Recommended action.** Restate the fixture's role as the RT1 anchor and attribute rename detection to `validateAdvisoryShape` on live data. Select the element by `ghsa_id`, not index, and refuse if the lookup fails. Allow paired with deny: `extractBands(entry, "lodash")` returns the `lodash` band only; `extractBands(entry, "lodash-es")` on the same object returns the `lodash-es` band — one fixture answering two subjects proves S3 against reality. Red-prove: rename `vulnerable_version_range` in a scratchpad copy → the case reds; relax S3 to a prefix test → the two-subject assertion reds (`"lodash-es".startsWith("lodash")` is true, so this pair is discriminating where the `hono` pair is not). Element not found by `ghsa_id`, or `withdrawn_at` non-null → `FIXTURE_STALE`. Do not trim past `withdrawn_at`, `severity` or `package.ecosystem`. Tie: `first_patched_version`, re-measured today as a bare string — my round-2 claim that it is an object was wrong.

## Recurring Issue Check

- R1 OK — N4 + C2's forbidden `function collectScopes`; the real walker supports the additive extension. AC-3.4's second instrument is a deliberate, named duplicate.
- R2 Fires (minor): F8 (18 vs 17 derivable two ways); F5 (the canary constant is correctly single-sourced, which is why the test must not read it).
- R3 Fires: F3 (C5's five forms map to four mechanisms in C7 plus one in another gate; the sixth C7 clause has no fixture).
- R4–R9 N/A.
- R10 OK — C3 → C2 one way.
- R11 N/A.
- R12 OK — the API severity enum throughout; round 2's `moderate` defect is gone.
- R13–R15 N/A.
- R16 Fires: F6, F7.
- R17 OK.
- R18 OK, verified: 13 debt entries, 13 inline gates, zero `queue_step … bash -c`, so AC-4.2's "byte-identical" is achievable under F6 reading 1 only.
- R19 OK — AC-2.2 asserts the new shape; 25 existing cases verified.
- R20, R21 N/A.
- R22 Fires (contributing to F2) — C3 inherits `discoverManifests`'s fallback and `ENOENT → continue` without stating whether N5 permits them.
- R23–R28 N/A.
- R29 Fires: F3 (`release.yml:315` is a redirect — executed), F8 (18 vs 17 — independently walked). Verified correct: the structural census; all six members; `check-dockerfile-prisma-pin.sh:68`; `ci.yml:687/716/743`; `pre-pr.sh:303`; `actionlint` absent; `vitest.config.ts:11` and the src-only coverage allowlist; the `"."` case at :116; 8 × 18 = 144.
- R30 OK.
- R31 OK — all criteria operate on scratchpad copies; AC-3.0 asserts a clean tree.
- R32 Fires: F1.
- R33 OK.
- R34 OK — SC-A…SC-G carry worst case, likelihood, cost, owner.
- R35 OK, modulo F7.
- R36 Fires: F3 — a rule that reds legitimately is the pressure that produces the suppression.
- R37 OK.
- R38 Fires (minor): F6 reading 2.
- R39 N/A.
- R40 OK — round 2's gap is closed.
- R41 Fires: F1, F3.
- R42 OK on the primitive and the structural census; F8 is a residual on the name-count rule.
- R43 OK.
- R44 Fires: F3.
- R45 OK, measured.
- R46 OK — S2/I-2.4 carry `parentName`; the array recursion is closed by S1.
- R47 OK.
- R48 Fires — the scratchpad twin is retired only by AC-3.0, which still cannot execute (F2): the second consecutive round with that result.
- R49 Fires: F9, F3. S12's residual statement is the model of how this should read.
- R50 Walked all 26 criteria. AC-3.0 ✗ (F2); AC-3.2 ✓ in content, ✗ in invocation; AC-3.3 ✗ (F1); AC-4.3 ✓ that a red occurred, ✗ that it occurred for the clause's reason (F4); AC-4.2 ✓ under F6 reading 1 only; AC-5.4 ✓ on the skip-line half, ✗ on the red half (F2); AC-7.1 ✗ for one of five fixtures (F3). The rest ✓.
- R51 OK.
- R52 OK — AC-1.5 and AC-2.1 re-run the widened primitive's own gate and cases.
- R53 OK.
- R54 Fires: F1, F6 reading 2.
- R55 OK — S10 separates a refusal from a query failure.
- R56 N/A.
- R57 OK.
- RT1 Largely closed; residual F9. My round-2 `first_patched_version`-is-an-object claim is withdrawn.
- RT2 Fires: F1, F2 exist because the plan's own criteria are not executable against the declared shapes.
- RT3 Fires: F5.
- RT4 N/A.
- RT5 Fires: F1. O-3 is the right obligation but its second half points at AC-3.3, which cannot run.
- RT6 OK.
- RT7 Fires: F4, F3.
- RT8 OK in the obligations; F5 is the residual.
- RT9 Fires: AC-3.0 is the retirement mechanism and is non-executable for the second revision running (F2).
- RT10 OK — O-1 is the correct generalization of round 2's transposed columns.
- RT11 OK — O-8; F9's committed fixture needs a staleness refusal, not cleanup.

```json
[
  {"id": "TEST-F29", "severity": "Critical", "title": "AC-3.3's process seam contradicts S11's import-only parameter and the host pin; the network shell, canary, retry and exit path remain reachable by no executable test", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 484, "adjacent": false, "escalate": null},
  {"id": "TEST-F30", "severity": "Major", "title": "No argv flag/path contract is declared; AC-3.0, AC-3.2, AC-3.3 and AC-5.4 all need one, and the cited precedent treats every argv element as a path and swallows ENOENT", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 469, "adjacent": false, "escalate": null},
  {"id": "TEST-F31", "severity": "Major", "title": "I-7.3's deciding tie does not exist (release.yml:315 is a redirect); measured: a pipe alternative in maskRe false-reds release.yml twice, and one AC-7.1 fixture has no rule in the named check", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 662, "adjacent": false, "escalate": null},
  {"id": "TEST-F32", "severity": "Major", "title": "AC-4.3 records that a mutation red a case but never why; the throw-vs-verdict trap generalizes past the one clause O-6 names", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 545, "adjacent": false, "escalate": null},
  {"id": "TEST-F33", "severity": "Major", "title": "No obligation forbids an expectation computed by the code under test; a canary case built from the gate's own constant cannot red on a constant edit", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 519, "adjacent": false, "escalate": null},
  {"id": "TEST-F34", "severity": "Major", "title": "Where the token probe lives is unstated; if it lives in the gate, both CI jobs inherit a skip-and-green branch, and a new wrapper file would red AC-4.2", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 583, "adjacent": false, "escalate": null},
  {"id": "TEST-F35", "severity": "Minor", "title": "VE-3's suite-level token precondition would block AC-5.4's token-absent run and AC-3.3's fixture cases, which require exactly that environment", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 48, "adjacent": false, "escalate": null},
  {"id": "TEST-F36", "severity": "Minor", "title": "The census's 18 queried package names is only derivable if scope-opener parent names are queried; an independent walk of the three manifests yields 17 pin names", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 133, "adjacent": false, "escalate": null},
  {"id": "TEST-F37", "severity": "Minor", "title": "O-9's stated purpose has no trigger: a static committed fixture cannot red on an upstream rename, and nothing regenerates it or refuses when it goes stale", "file": "docs/archive/review/stale-override-floors-plan.md", "line": 536, "adjacent": false, "escalate": null}
]
```

The prose headings F1-F9 in this section correspond to TEST-F29 through TEST-F37 in
that order; the orchestrator's transcription condensed the headings and this index
restores the identifiers the plan's Carried-Forward entries cite.
