# Plan Review: team-key-prune-blob-sweep-strict-aad
Date: 2026-11-08
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screen: two Minor prose findings (an unexplained INV-C4b reference;
the C5 member-set cited an off-plan investigation) — both fixed before expert review.

## Merged findings and dispositions

Convergent findings (raised by more than one expert) are merged; the severity is the highest
any expert assigned.

| ID(s) | Sev | Finding | Disposition (plan section) |
|---|---|---|---|
| F1, S2, T1 | Major | Sweeps typed on `pg.PoolClient`; the worker runs Prisma tx through `inSweepTx`; tests would miss the production path and grants | Fixed: Worker integration; C1/C4 signatures; cells on the worker role |
| F2 | Major | Dispatch undecided; `grantForEntry` does not cover the tables; deletion-retention matrix would turn false | Fixed: dedicated sweeps, two named grants, `counts` keys; C8 matrix regenerate |
| F3 | Major | Rotation-input-lock gate cannot see `*Unsafe` SQL; exemption stale or count bump | Fixed: DELETE moved into a definer function; gate note |
| F4, T12 | Major | Worker manifests, bypass-source tests, raw-SQL allowlist, docs missing | Fixed: C9, C8 |
| F5, S5 | Major | Mode-0 attachment normalisation narrower than the reader (`< 1 → 1`) | Fixed: predicate `v = k OR (k = 1 AND COALESCE(v,0) < 1)`; cell (e') |
| F6 | Major | Non-UUID segment wedges `IN` on uuid; case mismatch could delete a live object | Fixed: UUID-syntax parse, lowercased id, `= ANY($1::uuid[])`, cells |
| F7, S12 | Major | Restart-from-start never reaches keys past `maxObjects` | Fixed: in-memory cursor across ticks; 3-tick coverage cell |
| F8 | Major | Tx/IO structure and `deleteObject` stored-ref input unspecified | Fixed: per-page list → tx read → delete outside tx with `encodeObjectRef` |
| F9, S3, T7 | Major | (c') import tripwire misfires on mixed modules, blind in the extension; floor removal loses coverage | Fixed: (c') function-scoped incl. extension, measured; (d') floor kept |
| F10, S8 | Major | Legacy confinement vs shared `tryDecrypt`; optional-ctx laundering; builder defaults | Fixed: `tryOpen(closure)`, call-only confinement, required ctx, defaults removed |
| F11 | Major | `buildEncryptedEntryBody` shape unspecified | Fixed: `seal` callback |
| F12 | Major | Audit action downstream list and scope undecided | Fixed: TEAM scope, groups/webhooks as `TEAM_KEY_ROTATION`, C9 list |
| S1 | Major | Sweep deletes when rows are invisible (RLS, wrong DB, shared bucket) | Fixed: `assertSweepBypass`, deployment marker, breaker, report mode |
| S4, T11, F16 | Major | C2 limited to team-related models and names; prune on by default | Fixed: all models, `/version/i` on name and `@map`, (model, field) classification; kill switch |
| T2 | Critical | Race cell ordering and non-vacuity unspecified | Fixed: deferred-promise ordering, `idle in transaction` check, positive and negative controls, three shapes, red-proofs |
| T3 | Major | Global LIMIT makes cells depend on DB state | Fixed: assert by id; batch ≥ global eligible; own-team bound cell |
| T4 | Major | MinIO cells planned as skippable though CI runs MinIO | Fixed: mandatory, dedicated bucket, pagination |
| T5 | Major | Grace check untestable without injected clock | Fixed: `now` dependency; ±1 ms cells; wiring cell |
| T6 | Major | Azure/GCS pagination mock divergence | Fixed: `satisfies` against SDK types; per-backend page cells |
| T8 | Major | Factory mocks break or go vacuous; wrong-ctx not proved per reader | Fixed: per-site swap/version cells, `importOriginal` mocks |
| T9 | Major | Golden vectors only at itemKeyVersion 0; extension suite not run | Fixed: ≥1 vectors web/extension/iOS; extension vitest in strategy |
| T10 | Major | Untested new exports | Fixed: C5/C3 cells listed |
| S6 | Minor | Table-wide grants on teams / team_member_keys | Fixed: SECURITY DEFINER function, EXECUTE only |
| S7 | Minor | Concurrency rationale omits FOR SHARE dependency; probe lacks negative control and interleavings | Fixed: two-part argument; race cells incl. rotation and negative control |
| S9 | Minor | Forensic retention rationale dropped silently | Fixed: `holderUserIds` in audit; §3 states replacement evidence |
| S10 | Minor | Backups and versioned buckets | Fixed: docs requirement grace ≥ backup retention |
| S11 | Minor | Keys leak through error messages | Fixed: `{name, httpStatusCode}` only; forbidden pattern; log cell |
| F13, T14 | Minor | C5 member-set unreproducible; forbidden pattern hits tests | Fixed: inline list at HEAD, test exclusions |
| F14 | Minor | Azure vars missing; MAX_OBJECTS unbounded | Fixed: pick list and bounds |
| F15 | Minor | Predicate cost | Fixed: distinct pairs first, index-friendly predicate, EXPLAIN in Phase 2 |
| F17 | Minor | `TeamEntryVaultType` → `VaultType`; `-1` written by dispatcher | Fixed |
| T13 | Minor | DELETE-side duplicate predicate untestable | Fixed: dropped |
| T15 | Minor | Exemption key hand-written | Moot: no exemption (definer function) |

## Recurring Issue Check

Per-expert statuses as filed (non-N/A lines; every other rule was reported N/A or
checked-no-issue by that expert).

### Functionality expert
R1 F8 · R3 F4, F11 · R4 F12 · R11 F12 · R12 F12 · R17 F10, F11 · R18 F4, F14 · R22 F2 · R29 F13,
F2 · R38 F7 · R40 F6, F8 · R41 F3 · R42 F5, F9, F13 · R45 F15 · R47 F6 · R48 F5 · R49 F9 · R50 F1 ·
R53 F14 · R56 F7 · R57 F7. Checked-no-issue: R2, R5, R6, R9, R10, R14, R16, R25, R31–R36, R43, R44,
R46, R51, R52, R54, R55.

### Security expert
R3 S8 · R14 S6 · R16 S2 · R17 S3 · R29 S2, S7 · R31 S4, S10 · R42 S4 · R48 S5 · R49 S3, S12 ·
R50 S7 · R54 S2 · R57 S12. OK: R1, R2, R5, R9, R12, R18, R22, R25, R34, R36, R39, R43, R45–R47,
R51, R52, R55, RS3, RS4. RS1, RS2, RS5, RS6 N/A.

### Testing expert
R3 T8 · R14 T1 · R16 T4 · R17 T7, T8 · R18 T12 · R19 T8 · R29 T1 · R40 T6 · R41 T4 · R42 T11, T8 ·
R46 T10 · R47 T11 · R49 T7 · R50 T4 · R53 T7 · R57 T6 · RT1 T6, T8 · RT2 T13 · RT4 T2 · RT5 T1 ·
RT6 T10 · RT7 T7, T11 · RT8 T5 · RT9 T9 · RT10 T10 · RT11 T3, T4. Checked: R2, R5, R12, R31–R33,
R55, RT3.

---

# Review round: 2
Date: 2026-11-08

## Changes from Previous Round
Plan rewritten for every Round 1 finding: definer-function prune with kill switch, dedicated
sweeps in `inSweepTx`, blob sweep with marker / breaker / report mode / cursor, strict helpers
with call-only legacy confinement, function-scoped tripwire plus kept floor.

## Merged findings and dispositions

All Round 1 fixes were verified by their filing expert (S1 and S10 partially; completed here).

| ID(s) | Sev | Finding | Disposition |
|---|---|---|---|
| R2-1 | Critical | Race cell vacuous if Prisma tx A times out and rolls back | Fixed: explicit timeout, A's pid, await A resolved, post-commit state asserted by id |
| R2-2 | Major | Negative control must straddle A's commit | Fixed: per-shape straddling order |
| R2-3, G3 | Major | Cursor owned by stateless `sweepOnce` resets per tick | Fixed: `createWorker` owns `blobCursor` → `SweepOpts`; consecutive-`sweepOnce` cell; `buildSweepOpts(env)` wiring cells |
| R2-4, G1 | Major | Definer cells; report-mode arm; EXECUTE denial; E-RLS-SECDEF allowlist and manifest list | Fixed: definer cells mirroring the audit definers; C9 inventory entries |
| R2-5 | Major | MinIO grace cells must use listed LastModified | Fixed |
| N1, G4 | Major | Marker trust-on-first-use; no store primitive; empty prefix | Fixed: operator-created via conditional `createMarker`; worker read-only, refuses when absent; prefix rule; docs on unique `DEPLOYMENT_ID` |
| N2, G5 | Major | Per-page breaker misses spread deletion and wedges on dense orphan pages | Fixed: per-tick two-phase decision on cumulative counts, absolute cap, cursor advances on trip, operator path documented |
| G2 | Major | Blob module cannot use module-private `inSweepTx` | Fixed: `readAttachmentRefs` in `sweep.ts`, closure passed in; `EXPECTED_MEMBERS` |
| R2-6 | Minor | `inSweepTx` private — no test twin | Fixed: cells drive `sweepOnce` |
| R2-7 | Minor | Breaker boundary/allow cells; pageSize source | Fixed |
| R2-8, G7 | Minor | Batch unit pairs vs rows | Fixed: function bounds pairs; sweep returns rows; (i) asserts pairs |
| R2-9, N5, G9 | Minor | C2 must read latest function definition; alias-qualified match | Fixed: latest CREATE, `<alias>.<column>`, live `pg_get_functiondef` cell, redefinition self-test |
| N3 | Minor | Restore remedy wrong; 30-day cap < 35-day RDS retention | Fixed: max 35 days; versioning alternative; post-restore step separate |
| N4 | Minor | Definer never exercised with a non-superuser owner | Fixed: stand-in-owner cell under FORCE RLS, enforce on |
| N6, G8 | Minor | (c') nested-closure scope; importer mixes branches | Fixed: declared scope incl. nested expressions; importer branches split; `.map` fixture |
| N7, G9 | Minor | EPQ writer set incomplete | Fixed: derived set listed |
| G6 | Minor | RETURNS TABLE OUT names collide | Fixed: `pruned_*` OUT names, qualified columns, final statement shape |

## Recurring Issue Check (non-N/A, as filed)

### Functionality expert
R3 G1, G2 · R17 G2 · R18 G1 · R29 G9 · R38 G5 · R41 G4 · R42 G8, G9 · R45 G7 · R50 G1 · R52 G2 ·
R53 G7 · R56 G3, G5. Checked-no-issue: R12, R14, R49, R57.

### Security expert
R16 N4 · R29 N3, N7 · R31 N1, N2 · R38 N2 · R42 N5 · R49 N6. OK: R1, R3, R5, R14, R17, R47, R48,
R50, R54, R55, R57, RS3, RS4.

### Testing expert
R14 R2-4 · R49 R2-4 · R50 R2-1 · R57 R2-3 · RT2 R2-5 · RT4 R2-1, R2-2 · RT5 R2-3, R2-6 · RT8 R2-4 ·
RT9 R2-6, R2-8 · RT10 R2-4, R2-7. Checked: R12, R18, R42, RT1, RT3, RT6, RT7, RT11.

---

# Review round: 3
Date: 2026-11-08

## Changes from Previous Round
Round 2 dispositions applied: race-cell vacuity closed, cursor owned by `createWorker`, definer
cells and SECDEF inventory, operator-created conditional marker, per-tick cumulative breaker,
`readAttachmentRefs` in `sweep.ts`, importer split, C2 latest-definition rule.

All Round 2 fixes verified by their filing experts.

| ID | Sev | Label | Finding | Disposition |
|---|---|---|---|---|
| H1 | Major | design | tsx npm script cannot run from the deployed image | Fixed: `--init-blob-marker` flag on the worker bundle, smoke entry, cells |
| R3-1 | Major | design | RDS-shape definer cell mutates DB-global state | Fixed: single superuser tx ending in ROLLBACK, fresh-connection leak check |
| R3-2 | Major | design | No cell proves one `blobCursor` across `createWorker` ticks | Fixed: `createWorker` cell asserting reference identity |
| N8 | Minor | design | Wrong same-deployment DB deletes ticks with ≤ 20 old keys | Fixed: a tick deletes only if it saw ≥ 1 referenced key; R2 restated; cell |
| H2 | Minor | prose | Memory bound wording; refused-tick counts value; `buildSweepOpts` placement | Fixed: per-tick bound; `-1` on every refusal; entrypoint import graph |
| R3-3 | Minor | design | Loop-until-0 needs `-1` check and cap | Fixed |
| R3-4 | Minor | prose | Negative control role; reuse `race-helpers.ts` | Fixed |
| R3-5 | Minor | design | Conditional create proven on real MinIO | Fixed |

## Recurring Issue Check (non-N/A, as filed)

### Functionality expert
R29 H2 · R35 H1 · R41 H1. Checked-no-issue: R3, R14, R18, R38, R42, R50, R52, R56.

### Security expert
R49 N8. OK: R1, R3, R5, R14, R16, R29, R31, R38, R42, R47, R48, R50, R54, R55, R57, RS3, RS4.

### Testing expert
R1 R3-4 · R50 R3-5 · RT5 R3-2 · RT10 R3-5 · RT11 R3-1. Verified fixed: RT4, RT10 (R2-7). Checked:
R14, R49, R57, RT1, RT2, RT6, RT7, RT8, RT9.

---

# Review round: 4 (verification)
Date: 2026-11-08

All Round 3 fixes verified by their filing experts. Findings — all Minor:

| ID | Label (as filed) | Finding | Disposition |
|---|---|---|---|
| N9 | build-only / prose | Worker PutObject for `--init-blob-marker` unscoped | Fixed: SC3 follow-up scopes PutObject to the marker key; ops doc names operator credentials |
| J1 | design (liveness) | Tick-scoped evidence refuses all-orphan tail ticks permanently | Fixed: evidence is pass-scoped (`blobCursor.sawReferenced`); cells |
| R4-1 | design (test spec) | Empty / young-only tick would emit `-1` | Fixed: breaker evaluated only with unreferenced old keys; allow cells |
| R4-2 | design (test spec) | `sweepOnce` outcome mapping unasserted | Fixed: per-outcome cells |
| R4-3 | design (test spec) | `--init-blob-marker` cell harness; DB-backend case | Fixed: MinIO spawn cells + store-less exit-1 cells |

Recurring Issue Check (non-N/A): functionality R38 J1, R56 J1; checked R29, R35, R41.
Security: none new. Testing: R55 R4-1, RT10 R4-1, R4-3, RT5 R4-2; verified RT4, RT5, RT11, R1, R50.

## Saturation call (Step 1-6)

Round 4 completed; four rounds total (≥ 2). No Critical or Major finding is open in any
category. The Round 4 findings are all Minor; the experts labelled them build-only/prose (N9) or
test-specification/liveness details, each closed by a one-line plan edit above, and each expert
stated that nothing else remains settleable at plan level — the rest (red-proofs, the measured
(c') hit list, EXPLAIN timing against the statement timeout, whether the pinned MinIO image
honours `If-None-Match: *`) is reachable only by building and executing the implementation.
Plan phase saturated; proceeding to Phase 2. No finding is carried forward open.
