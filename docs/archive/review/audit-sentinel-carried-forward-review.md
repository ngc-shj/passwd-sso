# Plan Review: audit-sentinel-carried-forward

Date: 2026-09-03
Review round: 1
Plan: `docs/archive/review/audit-sentinel-carried-forward-plan.md` (revision 1 reviewed; revision 2 is the response)
Base: `1628b97fe`

## Changes from Previous Round

Initial review. Three experts ran in parallel against plan revision 1 and returned **43 findings, 7 Critical**. All `file:line` citations in this artifact anchor `1628b97fe` plus plan revision 1.

**Merge method — deviation recorded.** Step 1-5 specifies saving three raw outputs and merging via `llm-commands.sh merge-findings`. The orchestrator held all three outputs in context, so the mechanical json-index join (the documented pre-pass) was performed in-context and the prose merge done manually — the documented fallback. Writing three raw files to re-read them would have reproduced the same prose twice. The json indices were joined on (file, ±5 lines, root cause); every convergence below comes from that join.

## Perspective Convergence

Four findings were raised independently by two or three experts. Per "Perspective Convergence as a Severity Signal", each takes the severity floor of its highest reporter.

| Cluster | Reporters | Floor | What converged |
|---|---|---|---|
| **C4's primitive cannot deliver its claim** | F-F07, S-F07, T-F04 (+T-F02, T-F03, T-F05, T-F16) | Major → **design-level, mechanism withdrawn** | Three independent routes to the same conclusion: one header read fans out to four columns; two live writers are column-to-column copies and not header reads at all; the read population is 20 against 5 columns so ~12 would be manifested |
| **The `users` CHECK fires before `tenant_members`** | F-F04, S-F02 | **Critical** | C3 rooted detection at the membership writer; both experts traced `user.create`/`user.update` executing first, making I3.1 unsatisfiable *while its test passed* |
| **`REFUSAL_BUCKET` is a second exhaustive map** | F-F05, T-F09 | Major | C3's acceptance criterion 4 is decided by a table the plan never named, and by `bucketOf`'s `claim_refusal !== null` precedence |
| **Derivation counts do not reproduce** | F-F10, S-F03, T-F15 | Major | "24 call sites" (→31), "seven ingress sites" (→8 lines), "thirteen of fourteen" (→12 of 13) |
| **The I1.2 witness normalizes to 15 characters** | F-F08, S-F04 | Major | Both proved it by execution |
| **The consumer-flow table is not exhaustive** | F-F11, S-F08 | Major | 11 rows against 31 call sites, and the omitted set contained the one fail-open |
| **`scope` is unbounded at the same INSERT C5 protects** | F-F02, S-F06 | **Critical** | CF15's stated worst case survives the contract written to close it |

## Orchestrator verification

Per the recorded rule that sub-agent findings are not adopted unadjudicated, the orchestrator independently verified every Critical and the highest-leverage Majors **by execution or by reading the cited source**. All held; none was rejected.

| Finding | Method | Result |
|---|---|---|
| F-F01 | Read `consent-form.tsx:100-110`, `consent-form.test.tsx:242` | Confirmed — deny submits no `code_challenge`, and a test pins the absence |
| F-F02 / S-F06 | Read `consent/route.ts:274-277` | Confirmed — `.filter()` preserves duplicates, no cap |
| F-F03 | Re-ran the widened writer grep | Confirmed — `auth.ts:211` is a declaration; the writes are `upsert` at `:326`, `:336`, `:496` |
| F-F04 / S-F02 | Read `auth-adapter.ts:330→347`, `auth.ts:409` | Confirmed — the `users` write precedes the membership write on both paths |
| F-F05 / T-F09 | Read `scripts/lib/tenant-domain-buckets.ts:92-98` | Confirmed — a second `satisfies Record<ClaimRefusalKind, …>` exists |
| F-F06 | Ran `node scripts/checks/check-migration-transaction.mjs` | Confirmed — `ddlCount <= 1` exempts the cited sibling; two statements would flag |
| F-F08 / S-F04 | Ran a probe under `npx tsx` | Confirmed — `0000:…:ffff:255.255.255.255` normalizes to `"255.255.255.255"`, length 15 |
| S-F01 | Enumerated schema `tenantId` columns; counted `withTenantRls` call sites; read `scim-token.ts:77` → `scim/v2/Users/route.ts:38` | Confirmed — 56 models carry `tenantId`, 126 direct call sites, token tables reach the sink |
| S-F03 | Read `mcp/token/route.ts:65`; ran `check-bound-unknown-ip.mjs` | Confirmed — `if (ip)` skips the limiter; the gate reports 13 scopes, not 14 |
| S-F05 | Ran `node -e 'require("net").isIP("fe80::1%eth0")'` | Confirmed — returns `6` on v26.5.0; the plan's stated rationale was false |
| T-F15 / F-F10 | Re-ran all three derivation commands | Confirmed — 31 external call expressions across 28 files; 12 column lines; 8 ingress lines |

**Self-found while applying the fixes**: the derivation command revision 2 wrote for C3's two `ClaimRefusalKind` maps (`grep -rn "satisfies Record<ClaimRefusalKind"`) returns **only one of the two** — `auth-failure-mapping.ts:103-104` spells the construct across two lines. This is the same formatting-artifact failure T-F13 raised against C6's line grep, found in the plan's own command by running it. Replaced with `rg -Un --multiline`, and both the defect and the reason are recorded in the plan.

## Functionality Findings

13 findings (2 Critical, 9 Major, 2 Minor). All resolved in revision 2.

| ID | Sev | Title | Disposition |
|---|---|---|---|
| F-F01 | Critical | C5's "validate before the stale-session branch" breaks the Deny button | **Fixed** — C5 validates on the `action !== "deny"` arm only |
| F-F02 | Critical | `scope` at the same INSERT is unbounded and non-deduped, so CF15's worst case survives | **Fixed** — C5 bounds and dedups `scope`; the route becomes C6 member 8 |
| F-F03 | Major | C3's writer member set is a declaration line and misses three `upsert` sites | **Fixed** — member set re-derived with the widened primitive, table in C3 |
| F-F04 | Major | Three constraint names are reachable; the `users` one fires first | **Fixed** — C3 matches a set of three names, derived from the migration files |
| F-F05 | Major | `REFUSAL_BUCKET` is a second exhaustive map and decides acceptance 4 | **Fixed** — both maps named; bucket = `UNREGISTERED`; `claimRefusal: null` decided and its reason stated |
| F-F06 | Major | C2's two-statement migration reds `check-migration-transaction.mjs` | **Fixed** — wrapped in `BEGIN;…COMMIT;`; acceptance 5 forbids a baseline entry |
| F-F07 | Major | C4's header-read primitive cannot bind the bound | **Fixed by redesign** — C4 ships a boundary and no gate; the objection dissolves because all five columns are one width |
| F-F08 | Major | Acceptance 3's 45-character witness returns length 15 | **Fixed** — witness replaced; the mapped form gets its own canonicalisation case |
| F-F09 | Major | `parseSaTokenScopes` does not dedup, so stored rows stay un-approvable | **Fixed** — dedup added at the approval adjudicator; residual measured (SC6, zero) |
| F-F10 | Major | Three quantitative claims do not reproduce | **Fixed** — "Derived figures" table; every number ships its command |
| F-F11 | Major | The consumer table omits both proxy sites and the `metadata.clientIp` sink | **Fixed** — table regenerated from the command and asserts its own row count |
| F-F12 | Minor | I1.2's rationale names C4; the dependent is SC4 | **Fixed** |
| F-F13 | Minor (question) | Is dedup in class for `String[]` destinations? | **Answered** — no. C6 member 7 and the two webhook sites have widthless `String[]` destinations and take a request-size bound only; dedup is in class for CSV-joined destinations. Recorded in C6's table |

## Security Findings

10 findings (2 Critical, 5 Major, 3 Minor). Eight resolved; two carry Anti-Deferral entries.

| ID | Sev | Title | Disposition |
|---|---|---|---|
| S-F01 | Critical (escalate: false) | C2 declares its member set complete after deriving two of ~10 | **Resolved by design change** — see the Anti-Deferral entry below |
| S-F02 | Critical (escalate: true) | The `users` CHECK fires at `auth-adapter.ts:330`, so C3 never sees it | **Fixed** — C3 matches the three-name set and asserts the caught name by value |
| S-F03 | Major | Rate-limit direction derived from the wrong primitive; a fail-open at `mcp/token` | **Fixed** — C1 re-derives the limiter class and closes `mcp/token:65` |
| S-F04 | Major | The I1.2 witness is falsified by execution | **Fixed** (with F-F08) |
| S-F05 | Major | The zone-id rationale is false in both halves | **Fixed** — both false reasons removed and marked as falsified; the sound reason kept, with the `net.isIP` disagreement recorded as a standing note against a "simplifying" swap |
| S-F06 | Major | C6's grep cannot see the OAuth scope ingress | **Fixed** (with F-F02) — C6's class redefined by destination |
| S-F07 | Major | C4 does not cover the worker column-to-column copies | **Fixed by redesign** — I4.3 names all three; I4.2's constant-to-column tie covers them |
| S-F08 | Minor | The consumer walkthrough lists 11 of 24(→31) | **Fixed** (with F-F11) |
| S-F09 | Minor | C7 widens what is discarded from a tenant-readable sink, colliding with F3 | **Fixed** — the marker retains `metadata.reason` |
| S-F10 | Minor [Adjacent] | SC2's two writers gain an unhandled 23514 with no envelope | **Deferred** — Anti-Deferral entry below |

### S-F01 Critical "C2's `app.tenant_id` member set is incomplete" — Resolved by design change, with a recorded residual

- **Anti-Deferral check**: not a deferral for the class itself. The finding is adopted in full and the remedy changed rather than the enumeration extended.
- **Justification**: the finding's own recommendation offered two positions — CHECK all ~10, or scope them out with the transitive chain — and required the same position for all. A third was available and was taken: guard the **sink**. `set_config('app.tenant_id', …)` appears at 8 sites; seven pass literals (`NIL_UUID`, or `SYSTEM_TENANT_ID` deliberately in the anchor publisher, always beside `app.bypass_rls = on`), and exactly one takes a caller-supplied value (`tenant-rls.ts:53`). A refusal there covers all 126 call sites, every column that feeds them, and any column added later. Verified not to disturb the deliberate sentinel contexts: the anchor publisher never routes through `withTenantRls`, and no caller passes the sentinel today. The `users`/`teams` CHECKs are kept because those two are reachable from IdP-influenced claim resolution rather than from an admin's membership, and a CHECK survives an out-of-band write the app-level guard cannot see. I2.3 adds a narrow manifest over the 8 `set_config` sites so a ninth is a refusal — a one-statement class, not the open write-shape set C4 withdrew.
- **Residual, quantified**: a direct out-of-band `INSERT` into a token table naming the sentinel is refused only when the row is later *used*, not when it is written. Worst case — such a row sits undetected until use, then fails closed at the sink. Likelihood — low: it requires database write access outside the application, at which point the sentinel row itself is writable. Cost to fix — ~8 more CHECK constraints across token tables, each needing its own allow arm proving token issuance still works, on a shared dev database.
- **User decision**: the sink-guard position was put to the user with the three options and their costs, and chosen. Recorded here rather than implied.
- **Orchestrator sign-off**: acceptable risk, three values stated, remedy stronger than the finding's own recommendation for the reachable paths and explicitly weaker for the out-of-band one.

### S-F10 Minor [Adjacent] "SC2's writers gain an unhandled 23514" — Out of scope (different feature)

- **Anti-Deferral check**: out of scope (different feature), tracked.
- **Justification**: SCIM provisioning and directory sync are separate ingress features with their own error envelopes and their own allow arms. Worst case — after C2, a sentinel-pointing `tenant_id` at either writer surfaces as a bare 500 from the SCIM route or a failed sync run with no `directory_sync_logs` entry naming the cause. Likelihood — low; requires the C12 incident to have happened. Cost to fix — a shared 23514-to-envelope mapping at two sites, roughly 30 lines, but it needs allow arms at two provisioning paths to prove ordinary provisioning is unaffected, which is where it belongs.
- **Tracked as**: plan `SC2`, which now names the surface each writer takes rather than only asserting "C2's CHECK still covers them at the engine".
- **Orchestrator sign-off**: exception satisfied; routed to the Functionality expert's scope by the [Adjacent] tag and recorded as an ID'd scope-out.

## Testing Findings

20 findings (3 Critical, 15 Major, 2 Minor). All resolved; five dissolved with C4's redesign.

| ID | Sev | Title | Disposition |
|---|---|---|---|
| T-F01 | Critical | Acceptance 2/4/5 draw fixtures from a probe the plan does not contain; the F1 "before" column has no source | **Fixed** — the 13 deny inputs are enumerated in the plan; acceptance 4's baseline is a fixture generated from `1628b97fe` in a worktree and committed *before* the C1 slice, with three named refusal arms |
| T-F02 | Critical | The mutation table has no derived clause set and no runner | **Dissolved** — C4 ships no gate |
| T-F03 | Major | The "real tree" column cannot discriminate for narrowing mutations | **Dissolved** |
| T-F04 | Major | C4 scans 20 header reads but asserts a count over 5 columns | **Dissolved** — and the underlying observation drove the redesign |
| T-F05 | Major | No acceptance case for the exclusion manifest's staleness arms | **Dissolved** — no manifest |
| T-F06 | Critical | C3's fixture writes sentinel rows the teardown is forbidden to remove | **Fixed** — C3 gains a full fixture-lifecycle clause: `pg_constraint` pre-probe, count-based `beforeEach` refusal, claim-set-scoped teardown in `try/finally`, and a `SENTINEL_ESTATE_LEAKED` post-run arm naming the runbook |
| T-F07 | Major | "Asserted as a refusal" licenses a catalog read, a tautology over the migration | **Fixed** — deny arm is an executed INSERT asserting SQLSTATE and constraint name; **VC3 narrowed** to its real subject (guard-removal proofs and committing fixtures), since a rejected INSERT writes nothing |
| T-F08 | Major | C3 has no allow arm | **Fixed** — acceptance 5, asserting zero emits by count with an `EMIT_SINK_UNMOCKED` refusal |
| T-F09 | Major | The second `ClaimRefusalKind` map decides acceptance 4 | **Fixed** (with F-F05); acceptance 4 now executes `bucketOf` against the real producer's output |
| T-F10 | Major | I6.1 cannot fail for 3 of 7 members | **Fixed** — I6.1 split by destination kind; sites 3/4 bound by `service_account_tokens.scope`, member 7 labelled a request-size bound |
| T-F11 | Major | The twin-file instruction is a no-op | **Fixed** — per-twin disposition table plus the proof obligation that reverting the slice reds in **both** trees |
| T-F12 | Major | C5's arms never touch 64/65, so `.max(64)` is unpinned | **Fixed** — 42/43/64/65 plus a charset case, each asserting which clause rejected |
| T-F13 | Major | "No row created" is unavailable in the unit harness; `not.toHaveBeenCalled()` passes on any early return | **Fixed** — paired with a positive control and a `CONTROL_PATH_UNREACHED` refusal |
| T-F14 | Major | Acceptance 3 is a tautology on ASCII; acceptance 2 has no upper companion | **Fixed** — multi-byte fixture asserts `_originalSize` **≠** the code-unit count; 10,241-byte companion added |
| T-F15 | Major | Three derivation commands do not reproduce their counts | **Fixed** (with F-F10) |
| T-F16 | Major | A gate can satisfy every criterion and never run in CI | **Dissolved** — no gate to wire |
| T-F17 | Minor | C2 acceptance 3 understates the parity self-test edit | **Fixed** — the four edits enumerated |
| T-F18 | Major [Adjacent] | C1 acceptance 5 duplicates the manifest's adjudication | **Fixed** — the assertion reads `bound-unknown-ip-manifest.json` |
| T-F19 | Major [Adjacent] | C2's migration has no stated order, owner or rollback | **Fixed** — rollout order and rollback in C2 |
| T-F20 | Minor [Adjacent] | N1's "the existing audit benchmark, if any" admits its own absence | **Fixed** — verified no benchmark exists (`find src -iname "*bench*"` → none); N1 restated as a claim about the call |

## Adjacent Findings

- F-F02 `[Adjacent] Critical` — an unauthenticated-adjacent path consuming a per-tenant resource slot per failed attempt → routed to Security, converged with S-F06, fixed in C5.
- F-F05 `[Adjacent] Major` — the `toEqual` at `auth-failure-mapping.test.ts:56` → routed to Testing, converged with T-F09.
- T-F10 `[Adjacent] Major` — rows created before C6 are already un-approvable → routed to Functionality, converged with F-F09; measured as SC6.
- S-F10, T-F18, T-F19, T-F20 — dispositions above.

## Quality Warnings

None. The `merge-findings` quality gate was not run (see the merge deviation above); the orchestrator applied the same three checks manually. No finding was `[VAGUE]` (every one cites a file and line or a command), `[NO-EVIDENCE]` (each Critical was independently re-verified — see the verification table), or `[UNTESTED-CLAIM]` (the four claims resting on runtime behaviour — `net.isIP`, the witness normalization, the gate's scope count, the migration-transaction rule — were each executed by the orchestrator).

## Round 1 disposition summary

- 43 findings, 7 Critical, 0 open Critical or Major.
- 2 deferrals, both with the mandatory Anti-Deferral format: S-F01's out-of-band residual, S-F10 / SC2.
- 2 contracts changed **mechanism**, not wording: C2 (source enumeration → sink refusal) and C4 (AST gate → boundary). Round 2 is therefore warranted rather than optional: every Round-2 Major would sit inside a Round-1 remedy, which is the signature the saturation criterion treats as "another round is worth its cost".

## Recurring Issue Check

### Functionality expert

R1 [N/A — no code in the change to check] · R2 [N/A] · R3 [Finding F-07] · R4 [N/A] · R5 [Checked — no issue] · R6 [N/A] · R7 [N/A] · R8 [N/A] · R9 [Checked — no issue: C3's emit placement after `withBypassRls` settles is explicitly preserved] · R10 [N/A] · R11 [N/A] · R12 [N/A] · R13 [N/A] · R14 [N/A] · R15 [Finding F-06] · R16 [N/A] · R17 [N/A] · R18 [N/A] · R19 [N/A] · R20 [N/A] · R21 [N/A — no sub-agent production mutations in a plan review] · R22 [N/A] · R23 [N/A] · R24 [Checked — no issue] · R25 [N/A] · R26 [N/A] · R27 [N/A] · R28 [N/A] · R29 [Findings F-10, F-12] · R30 [N/A] · R31 [N/A] · R32 [N/A] · R33 [N/A] · R34 [N/A] · R35 [N/A] · R36 [N/A] · R37 [N/A] · R38 [N/A] · R39 [N/A] · R40 [N/A] · R41 [N/A] · R42 [Findings F-02, F-03, F-07, F-11, F-13] · R43 [N/A] · R44 [N/A] · R45 [N/A] · R46 [Checked — no issue] · R47 [N/A] · R48 [Checked — no issue] · R49 [Checked — no issue] · R50 [Checked — no issue] · R51 [N/A] · R52 [N/A] · R53 [Finding F-07] · R54 [N/A] · R55 [N/A] · R56 [N/A] · R57 [N/A]

### Security expert

R1 [N/A — plan-stage] · R2 [Checked] · R3 [Findings F-01, F-03, F-06, F-07] · R4–R8 [Checked] · R9 [Checked — the plan preserves the emit-after-`withBypassRls` placement] · R10–R20 [Checked] · R21 [N/A — probe file removed, `git status` verified clean] · R22–R28 [Checked] · R29 [Findings F-03, F-04, F-05, F-08] · R30–R41 [Checked] · R42 [Findings F-01, F-03, F-06, F-07 — four classes re-derived, four incomplete] · R43 [Finding F-09] · R44, R45 [Checked] · R46 [Checked — C4's scope-aware clause correctly stated] · R47 [Finding F-02 — `pgErrorCode` correctly identified; the defect is which name] · R48 [Checked for C1 (0 differential violations over 31 inputs × 3 allow arms); Finding F-06 for C5's `scope`] · R49 [Finding F-07] · R50 [Checked] · R51–R57 [Checked] · RS1, RS2 [Checked] · RS3 [Checked — `escapeHtml` verified at both email sinks; `vault-lockout.test.ts:85` already pins an XSS fixture] · RS4 [Checked] · RS5 [Finding F-03] · RS6 [Checked]

### Testing expert

R1 [Checked] · R2 [Checked] · R3 [Finding F-11] · R4–R8 [N/A] · R9 [Checked] · R10, R11 [N/A] · R12 [Finding F-09] · R13, R14 [N/A] · R15 [Checked] · R16 [Finding F-16] · R17 [Checked] · R18 [Finding F-05] · R19 [Finding F-11] · R20, R21 [N/A] · R22 [Checked] · R23–R28 [N/A] · R29 [Findings F-15, F-01] · R30 [Checked] · R31 [Findings F-06, F-07] · R32, R33 [N/A] · R34 [Checked] · R35 [N/A] · R36 [Checked] · R37 [N/A] · R38 [Checked] · R39, R40 [N/A] · R41 [Finding F-16] · R42 [Findings F-02, F-04, F-09, F-10, F-11] · R43 [N/A] · R44 [Checked — the plan forbids reading exit codes through a pipe] · R45, R46 [Checked] · R47 [Finding F-04] · R48 [Finding F-18, F-12] · R49 [Checked] · R50 [Findings F-02, F-16] · R51, R52 [Checked] · R53 [Findings F-04, F-12] · R54 [N/A] · R55 [Checked] · R56, R57 [N/A] · RS1–RS6 [N/A — security scope] · RT1 [Findings F-13, F-11] · RT2 [Checked] · RT3 [Checked] · RT4 [Findings F-01, F-03, F-10, F-14] · RT5 [Findings F-07, F-13] · RT6 [Checked] · RT7 [Findings F-02, F-03] · RT8 [Findings F-07, F-13] · RT9 [Finding F-11] · RT10 [Findings F-05, F-08, F-12] · RT11 [Finding F-06]

---

# Round 2 (incremental)

Date: 2026-09-03 · Plan revision 2 reviewed; revision 3 is the response.

## Changes from Previous Round

Revision 2 changed two contracts' **mechanism** rather than their wording — C2 from source enumeration to a sink refusal, C4 from an AST gate to a boundary helper — and rewrote C1's, C3's, C5's, C6's and C7's acceptance criteria. **42 findings, 7 Critical** (Functionality 14/2, Security 12/0, Testing 16/5). Count is flat against Round 1's 43/7; character is not. The great majority sit inside a Round-1 remedy, which the saturation criterion treats as "another round is worth its cost" — and which, when it recurs, is the recorded signal that a scope is wrong rather than a wording.

## The three facts that changed scope

1. **All eleven writers of the five user-agent columns already slice at the correct constant** (F2-05, verified independently by the orchestrator across all eleven sites). C4's helper therefore changed no behaviour anywhere, and no criterion required it to be adopted (T-R2-05). **C4 is withdrawn; CF14 is carried forward a third time** (SC4), with the sharpest evidence yet: three mechanisms have now failed, and the exposure is entirely future-tense.
2. **`tenant-domain add` already refuses a sentinel target** (S2-F09, `scripts/tenant-domain.ts:919-932`, read by the orchestrator). The state C3 audits is reachable only out-of-band. **C3's objective is resized** (SC8) rather than dropped — it is the observability half of S-F01's accepted residual.
3. **`bucketOf` never consults `REFUSAL_BUCKET`** (F2-02, verified: it branches on `claim_refusal !== null`, then on a string equality with `claim_taken`'s reason; `REFUSAL_BUCKET` is referenced only from its own test). Round 1's Functionality **and** Testing experts both asserted that map decides the bucket. Both were wrong about the mechanism — a converged pair sharing one blind spot — and the consequence was that C3's reason string collided with `claim_taken`'s, failing the plan's own requirement F3 while acceptance 4 passed for the wrong reason.

## Perspective Convergence

| Cluster | Reporters | Floor |
|---|---|---|
| C4 delivers nothing / Objective 4 overclaims | F2-05, T-R2-05, S2-F11 | **Critical** (T-R2-05) |
| C3's constraint-to-path map is wrong and one member is unfalsifiable | F2-03, T-R2-08 | Major |
| Derived figures stated outside the table do not reproduce | F2-12, S2-F12, T-R2-15 | Minor |
| C5's placement clause is impossible / leaves a sink on the deny arm | F2-01, S2-F07 | **Critical** |

## Orchestrator verification

| Finding | Method | Result |
|---|---|---|
| T-R2-01 | Read `access-restriction.ts:153` | Confirmed — `evaluateAccessPolicy` is module-private; acceptance 4 was unimplementable |
| T-R2-05 / F2-05 | Read all eleven user-agent write sites | Confirmed — every one already slices at the right constant |
| T-R2-07 | `grep -rnE "\.constraint\b\|constraintName" src/` | Confirmed — **zero** hits; no constraint-name extractor exists, and `pgErrorCode` returns SQLSTATE only |
| F2-02 | Read `tenant-domain-buckets.ts:68-98` + reference grep | Confirmed — `bucketOf` does not consult `REFUSAL_BUCKET` |
| S2-F01 | Executed on the dev database + in Node | Confirmed — Postgres holds braced and unhyphenated UUIDs equal to canonical; JS `===` does not |
| S2-F09 | Read `scripts/tenant-domain.ts:915-935` | Confirmed — `cmdAdd` refuses a sentinel target on the resolved id |
| SC7 chain | Read all four links | Confirmed — `emergency-access/[id]/vault/route.ts:52` → `autoPromoteIfElapsed` → `vault-auto-promote.ts:135` `logAuditAsync` → `audit-outbox.ts:53` `prisma.$transaction` folds at `prisma.ts:178-179` |
| Derived figures | Re-ran all eight commands | All reproduce at the stated values |

## Disposition

All 42 are resolved in revision 3 except the entries below, which carry Anti-Deferral records in the plan.

**Withdrawn / dissolved (11).** T-R2-02, T-R2-03, T-R2-04 (C1's baseline-fixture apparatus — replaced by a property assertion needing no baseline, no worktree and no snapshot); T-R2-05, F2-05, S2-F11, F2-06, T-R2-14 (C4 withdrawn → SC4); T-R2-09, T-R2-06 partially (harness allocation — the two load-bearing choices are fixed in the plan, the rest is Phase 2's); T-R2-10 (C6's isolated-database demand dropped — VC3 as narrowed does not reach it, and no such harness exists in this repo).

**New scope-outs (2), both with Anti-Deferral entries.** **SC7** — the reachable GUC fold breaking `logAuditAsync`'s durability contract (S2-F04 plus a transitive-reachability trace): R9 class, one reachable site, not a member of any CF11–CF17 class, and touching every audit emit in the deployment. **SC3 restated** — revision 2 claimed its residual-data query "bounds the population from above"; it bounds from **below** (F2-07), and covered 4 of 6 IP and 1 of 5 user-agent columns. The disposition is now the weaker, true claim: no *shape-invalid* rows, parser-invalid population unmeasured.

**Design fixes applied (the rest).** C1: five value sources not four, the `mcp/token` fail-open closed, member (5)'s direction corrected from "tightens" to "loosens observability". C2: a canonical-form check before the equality (R48), and the refusal is now audited under its own reason (F3, which revision 2's bare throw failed on the branch's primary remedy). C3: its own reason string, `bucketOf` widened to a membership test so `REFUSAL_BUCKET` stops being decorative, the constraint-to-path map stated, `auth.ts:336` recorded as unreachable-by-construction, `teams_not_system_tenant` labelled unfalsifiable-by-design, the constraint-name extractor named as something this contract must build, and the by-value assertion moved to integration because the unit harness mocks `@/lib/prisma` wholesale. C4 (ex-C5): validation moved to `:67` on the `action !== "deny"` arm — before the stale-session echo, before the DCR claim block, and before the write — and the third PKCE ingress (`mcp/authorize/route.ts:127`) added, plus the cap/dedup order fixed so C4 and C5 stop contradicting. C6 (ex-C7): the retained `reason` gets a string type guard, a byte cap, and a marker-size assertion.

## Recurring Issue Check — Round 2

### Functionality expert
R1, R2 [N/A] · R3 [F2-01, F2-05] · R4 [N/A] · R5 [Checked] · R6–R8 [N/A] · R9 [Checked] · R10–R14 [N/A] · R15 [F2-11] · R16–R20 [N/A] · R21 [N/A — `git status` clean] · R22, R23 [N/A] · R24 [Checked] · R25–R28 [N/A] · R29 [F2-07, F2-12] · R30 [N/A] · R31 [F2-03, F2-09] · R32–R40 [N/A] · R41 [F2-05] · R42 [F2-01, F2-03, F2-07, F2-08; C6's eight and C2's eight re-derived and correct] · R43, R44, R45, R46 [Checked] · R47 [Checked] · R48 [F2-02] · R49 [Checked] · R50 [F2-05] · R51, R52 [N/A] · R53 [F2-06, F2-08] · R54 [N/A] · R55 [Checked] · R56, R57 [N/A]

### Security expert
R1 [N/A] · R2 [Checked] · R3 [S2-F01, S2-F02, S2-F06, S2-F11] · R4–R8 [Checked] · R9 [Checked — S2-F04 is the adjacent tx-boundary class] · R10–R20 [Checked] · R21 [N/A — `git status` clean] · R22–R28 [Checked] · R29 [S2-F05, S2-F12] · R30–R41 [Checked] · R42 [S2-F03, S2-F07, S2-F09, S2-F11; C1's six re-derived and complete] · R43 [Checked] · R44–R46 [Checked] · R47 [Checked] · R48 [S2-F01, S2-F07; C1 is the contrast case and satisfies it] · R49 [S2-F11, S2-F06, S2-F09] · R50 [Checked] · R51–R57 [Checked] · RS1, RS2 [Checked] · RS3 [Checked] · RS4 [Checked] · RS5 [S2-F03] · RS6 [Checked]

### Testing expert
R1, R2 [Checked] · R3 [T-R2-05, T-R2-08] · R4–R8 [N/A] · R9 [Checked] · R10, R11 [N/A] · R12 [Checked] · R13, R14 [N/A] · R15 [Checked] · R16 [Checked] · R17 [Checked] · R18 [T-R2-16] · R19 [T-R2-03] · R20 [N/A] · R21 [Checked — worktree removed, real tree unmutated] · R22 [Checked] · R23–R28 [N/A] · R29 [T-R2-13, T-R2-15] · R30 [Checked] · R31 [T-R2-01, T-R2-02] · R32, R33 [N/A] · R34 [Checked] · R35 [N/A] · R36 [Checked] · R37 [N/A] · R38 [T-R2-10] · R39, R40 [N/A] · R41 [Checked] · R42 [T-R2-05, T-R2-08, T-R2-14] · R43 [Checked] · R44 [Checked] · R45, R46 [Checked] · R47 [T-R2-07] · R48 [Checked] · R49 [Checked] · R50 [T-R2-03, T-R2-06] · R51, R52 [Checked] · R53 [T-R2-01, T-R2-05] · R54 [N/A] · R55 [Checked] · R56, R57 [N/A] · RS1–RS6 [N/A] · RT1 [T-R2-09, T-R2-16] · RT2, RT3 [Checked] · RT4 [T-R2-04, T-R2-11, T-R2-13] · RT5 [T-R2-06, T-R2-16] · RT6 [Checked] · RT7 [T-R2-08, T-R2-10] · RT8 [T-R2-09] · RT9 [T-R2-02] · RT10 [T-R2-03, T-R2-06] · RT11 [T-R2-12]

---

# Round 3 (incremental)

Date: 2026-09-03 · Plan revision 3 reviewed; revision 4 is the response.

## Changes from Previous Round

Revision 3 withdrew CF14's contract, resized C3, deleted the invented verification apparatus, and introduced two new mechanisms — an audit emit inside `withTenantRls`'s guard, and a widening of the shipped `bucketOf` adjudicator. **34 findings, 6 Critical** (Functionality 13/1, Security 9/2, Testing 12/4).

Trend: **43/7 → 42/7 → 34/6**. Declining in both, and the character changed again: Round 3's Criticals cluster in two places rather than spreading — C1's acceptance criterion 4 (three of Testing's four) and the two new mechanisms (both of Security's).

## Round 3's decisive measurements

1. **C1 acceptance criterion 4 was measured to carry zero information.** The Testing expert built the property over 132 cells (22 inputs × 6 policies) and ran it against seven boundary mutants. The shipped contract and a *no-validation* mutant both red on the same single cell; the mutant implementing forbidden pattern #2 (`return leftmost || socketIp`) and a **full revert of C1** are both green. Three revisions specified three mechanisms for this one criterion — no source, then an unimplementable worktree fixture with 3/54 discriminating cells, then a property that is a theorem of the design. **Deleted in revision 4**; F1 is stated as what it is, a design argument backed by the probe taken on `1628b97fe` before any change, with acceptance criterion 1 as the over-rejection guard — the only direction F1 can break.
2. **`bucketOf` is not the first adjudicator on the `unmapped` path.** `UNMAPPED_SELECTED_REASONS` (`tenant-domain-buckets.ts:55-58`) is, bound as `$3` at `tenant-domain.ts:522`, and `AuthLoginFailureReason` is a closed six-member union. Revision 3's two C3 bullets — "its own reason string" and "`REFUSAL_BUCKET.claim_system_tenant = UNREGISTERED`" — were **mutually unsatisfiable** without a third edit neither named. Raised independently by Functionality (F3-01, Critical) and Security (S3-F03).
3. **`boundary and policy cannot disagree (R48)` was false.** Verified by execution: `isIpInCidr` passes the raw string to `parseIpv6` while `normalizeIp` unwraps brackets, so `[::1]` is boundary-accepted and policy-rejected. Revision 4 states the true, narrower claim — after C1 the policy sees only normalized values, so the accept sets coincide **on the reachable domain** — which is an argument for C1 rather than against it.
4. **The emit revision 3 added to satisfy F3 is unsafe in both spellings** (S3-F01, escalated). With an explicit `tenantId`, `enqueueAudit`'s raw `$transaction` folds and turns RLS off for the caller's transaction; without one, `resolveTenantId`'s `withBypassRls` is refused by the nesting guard and the row is lost. `withTenantRls` also has no request context to attribute a row with.

## Orchestrator verification

| Finding | Method | Result |
|---|---|---|
| F3-01 / S3-F03 | Read `tenant-domain-buckets.ts:50-58`, `tenant-domain.ts:522`, `auth-failure.ts:34-40` | Confirmed — closed union; the reason list has two members; the two bullets are unsatisfiable together |
| T-R3-03 | Executed a probe over bracketed/padded IPv6 | Confirmed — `isValidIpAddress(raw)=false` / `(norm)=true`, `isIpInCidr(raw)=false` / `(norm)=true` |
| S3-F05 | Read `constants/app.ts:47` | Confirmed — `UUID_RE` carries `/i`; the guard is sound only because the sentinel has no hex letters |
| T-R3-01/02 | The expert's 132-cell harness and seven mutants | Accepted as measured; the structural reason (shared parser) is independently evident |
| SC7's mechanism | Previously verified in Round 2 across all four links | Unchanged |

## Disposition

All 34 addressed in revision 4, except two **user-approved deferrals** carrying full Anti-Deferral records.

**Deleted rather than respecified (1).** C1 acceptance criterion 4 — T-R3-01, T-R3-02, T-R3-03, T-R3-11. Three mechanisms, three failures; the remedy for a clause that keeps seeding its own defects is discard, not a fourth specification.

**Mechanism changed (1).** C2's refusal: audit emit → named `RlsSentinelContextRefused` throw plus the structured log line `logAuditAsync` emits before any DB work. F3 gains two explicitly-reasoned exceptions (C2's sink refusal, C4's ingress 400s) rather than being stated as a universal it does not meet. **User's decision.**

**New scope-outs (1), both deferred by user decision with Anti-Deferral entries.** **SC9** — the RLS nesting guard rejects two of four combinations while its own comment claims all four; one tenant-in-tenant and two bypass-in-bypass sites are live, all benign today. Tracked with **SC7** as one follow-up issue: both are the same Prisma-Proxy fold class, both touch the audit-durability path or RLS core, and both need allow arms across every emit in the deployment. **Note for the follow-up**: Round 3 corrected SC7's own mechanism description — the unguarded component is `enqueueAudit`/`enqueueAuditBulk`'s raw `$transaction`, not `resolveTenantId`'s short-circuit, and "route them through `withBypassRls`" would convert the silent fold into a throw for every emit inside a tenant transaction, so the fix is a redesign rather than a rewrap.

**Design fixes applied.** C1: the R48 claim corrected; I1.2 re-pointed at its four live dependents (the `AUDIT_IP_MAX_LENGTH` slice sites) after revision 3 left it pointing at a withdrawn contract; the team-IP path's lost `ACCESS_DENIED` emit restored (a same-class observability regression this branch causes); `/api/mcp/token` given an allow arm and its invisibility to `check-bound-unknown-ip.mjs` stated. C2: case-folded comparison, guard order relative to the nesting guard, `DOC_SITES` stated as conditional on whether the runbook edit spells the UUID. C3: the five-site reason change enumerated with (3) marked load-bearing; the `bucketOf` derivation pinned to `REFUSAL_BUCKET[kind] === UNREGISTERED` (the `!== null` near-miss regresses round-5 F1/S3); an injectivity guard added; criteria allocated to harnesses; the fixture's dirtied tables corrected to `tenant_claims`/`audit_outbox` (revision 3 checked `users`/`tenant_members` counts that cannot be non-zero under their own precondition). C4: the passkey gate identified as a **third** post-claim exit and moved above the claim block, with the invariant stated over all pre-mint gates; the dedup dropped as unfalsifiable under its own cap; the cap widened to admit standard OAuth scopes; the deny-plus-stale hand-off given a case. C5: the dedup-then-cap order stated with its spelling, because the idiomatic Zod form gives the opposite. C6: the reason cap named, measured on the serialized post-`sanitizeMetadata` value, asserted `isWellFormed()`, with an escape-heavy witness alongside the Japanese one; the cycle case moved to a payload under the cap, where the sanitize walk actually runs; twin-file disposition added. Contract ID map added — revision 3 reused IDs while asserting it did not.

## Recurring Issue Check — Round 3

### Functionality expert
R1, R2 [N/A] · R3 [F3-01, F3-04] · R4 [N/A] · R5 [Checked] · R6–R8 [N/A] · R9 [Checked] · R10–R14 [N/A] · R15 [Checked] · R16–R20 [N/A] · R21 [N/A — read-only] · R22, R23 [N/A] · R24 [Checked] · R25–R28 [N/A] · R29 [F3-06] · R30 [N/A] · R31 [Checked — F2-03 resolved] · R32–R40 [N/A] · R41 [F3-04] · R42 [F3-01, F3-05, F3-08; SC8's and C3's constraint-to-path sets re-derived **complete**] · R43–R47 [Checked] · R48 [F3-02, F3-08] · R49 [Checked] · R50 [F3-04] · R51, R52 [N/A] · R53 [F3-04, F3-11] · R54 [N/A] · R55 [Checked] · R56, R57 [N/A]

### Security expert
R1 [N/A] · R2 [Checked] · R3 [S3-F01, S3-F03, S3-F04] · R4–R8 [Checked] · **R9 [S3-F01, S3-F02 — the round's centre]** · R10–R20 [Checked] · R21 [Checked — read-only sub-agent, tree clean] · R22–R28 [Checked] · R29 [Checked] · R30–R41 [Checked] · **R42 [S3-F02, S3-F03, S3-F04, S3-F06 — the nesting class is 2-of-4, the `unmapped` adjudicator chain is 2 not 1, the post-claim exit set is 3 not 2, the PKCE reader set is 4 not 3]** · R43 [Checked] · R44–R47 [Checked] · **R48 [S3-F03, S3-F05]** · R49 [S3-F01] · R50 [Checked] · R51–R57 [Checked] · RS1, RS2 [Checked] · RS3 [Checked] · RS4 [Checked] · RS5 [S3-F04] · RS6 [Checked]

### Testing expert
R1, R2 [Checked] · R3 [T-R3-01, T-R3-05] · R4–R8 [N/A] · R9 [Checked] · R10, R11 [N/A] · R12 [Checked] · R13, R14 [N/A] · R15–R17 [Checked] · R18 [T-R3-12] · R19 [T-R3-04] · R20 [N/A] · R21 [Checked — scratchpad copy only, tree unmutated] · R22 [Checked] · R23–R28 [N/A] · R29 [T-R3-07, T-R3-11] · R30 [Checked] · R31 [T-R3-01, T-R3-02] · R32, R33 [N/A] · R34 [Checked] · R35 [N/A] · R36 [Checked] · R37 [N/A] · R38 [Checked] · R39, R40 [N/A] · R41 [T-R3-09] · R42 [T-R3-04, T-R3-05, T-R3-10] · R43, R44, R45, R46 [Checked] · R47 [T-R3-05] · R48 [T-R3-02, T-R3-03, T-R3-09] · R49 [T-R3-01] · R50 [T-R3-01, T-R3-06] · R51, R52 [Checked] · **R53 [T-R3-01, T-R3-02, T-R3-03 — the mechanism escaped a second measurement; the remedy is to change the mechanism, not to add cases]** · R54 [N/A] · R55 [Checked] · R56, R57 [N/A] · RS1–RS6 [N/A] · RT1 [T-R3-12, T-R3-10] · RT2, RT3 [Checked] · RT4 [T-R3-01, T-R3-06, T-R3-09] · RT5 [T-R3-05, T-R3-08] · RT6 [Checked] · RT7 [T-R3-03, T-R3-07] · RT8 [T-R3-02] · RT9 [T-R3-11] · RT10 [T-R3-03, T-R3-07] · RT11 [T-R3-04]

---

# Round 4 (targeted)

Date: 2026-09-03 · Plan revision 4 reviewed; revision 5 is the response and is final.

Scoped by user decision to the surfaces revision 4 changed, not the whole plan. **32 findings, 8 Critical** (Functionality 10/3, Security 9/0, Testing 13/5).

Trend: **43/7 → 42/7 → 34/6 → 32/8**. Volume declining, Criticals not — and the *location* is what matters: every Round-4 Critical sits inside a mechanism **revision 4 itself introduced** (C5's cap order, C3's five-site reason list, C4's all-pre-mint-gates invariant), none in the original CF11–CF17 analysis. Two of three experts independently wrote the same conclusion: stop specifying and go measure.

## The three measurements that ended Phase 1

1. **C5's cap can never fire — established independently three times.** Both experts executed it against the repo's `zod@4.5.4` and the orchestrator reproduced it: for `z.array(z.enum(X))`, dedup-then-cap and dedup-with-**no** cap are indistinguishable on every fixture, because the post-dedup array cannot exceed `|X|` by pigeonhole. Revision 4's stated red proof — "remove the ingress cap → criterion 2 reds alone" — is false by construction: criterion 2's fixture must contain an out-of-enum value and rejects at the element schema. The same clause had its order specified in revision 3 and re-specified in revision 4 without ever being able to fire. **The cap is deleted in revision 5**; dedup alone is the mechanism and I5.1's bound becomes a derivation from the closed enum.
2. **C3's `beforeEach` precondition was already violated on the target database.** Measured read-only on dev: `audit_logs_sentinel=5`, `audit_outbox_sentinel=5`. The sentinel is what unattributable audit emits FK to, so sentinel-scoped audit rows are the **normal steady state** of a live deployment. Revision 4's rule ("non-zero → refuse") would refuse on every run before C3 wrote a line, and the Derived-figures row "sentinel rows on dev → all 0" measured only `teams`/`users`/`tenant_members` while reading as though it covered the tables the fixture gates on. **Revision 5 records both counts in the table and replaces absolute-zero with baseline-plus-per-run-marker**, the shape `helpers.ts:414-421` already prescribes.
3. **`isWellFormed()` cannot detect the defect it was chosen for.** A byte cut through a multi-byte character yields U+FFFD, which *is* well-formed; `isWellFormed()` returns false only for a lone surrogate, which a byte cut never produces. Revision 5 replaces it with assertions that can fail — no introduced U+FFFD, and `reason.startsWith(retained)`, the property an operator's grep depends on — and requires the cut to be taken on a character boundary.

## Orchestrator verification

| Finding | Method | Result |
|---|---|---|
| F4-01 / T-R4-03 | Executed both orders and no-cap against `zod@4.5.4` | Confirmed — identical output on both fixtures; the cap is dead |
| T-R4-04 | `psql` read-only on dev | Confirmed — `audit_logs_sentinel=5`, `audit_outbox_sentinel=5` |
| S4-F01 | Read `audit-logger.ts:56,93,99`, `.env.example:281` | Confirmed — `auditLogger` is `enabled: AUDIT_LOG_FORWARD === "true"`, shipped `false`; `deadLetterLogger` is unconditional |
| S4-F03 | Read `auth.ts:74`, `:171` | Confirmed — both carry their own `Extract<AuthLoginFailureReason, …>`; the registration set is larger than five |
| F4-09 | Read `ip-access.ts:401-402` | Confirmed — the raw `socketIp` return is `:402`, not `:401` |
| F4-04 | Derived the slice-site set by constant | Confirmed — 9 at 45-wide (`AUDIT` 4, `SESSION` 2, `SHARE_ACCESS` 3) across 3 columns and 3 constants, not 4 across 3; 6 at 64-wide |

## Disposition — revision 5 keeps decisions and drops specifications

**Decisions applied (10).** C5's cap deleted (F4-01, T-R4-03). C3's registration set restated as **eight** sites including `ClaimRefusalKind` as a table-key-only fourth constituent and `auth.ts:74`/`:171` (F4-02, S4-F03), with the `unmapped` chain stated as **three** adjudicators and `metadata.claim` named as the middle gate's requirement (T-R4-06). C4 gains a **client-independent** pre-claim scope gate closing the `scope=openid` path, with the residual `invalid_scope` named as the invariant's one exception because it reads the claim block's own output (F4-03, T-R4-09), and the passkey gate's placement stated as a closed interval after the deny arm (S4-F05). C2's sink becomes `getLogger()` with a fixed event field — not `auditLogger`, disabled by default, and not the `audit.*` envelope F3's own exception excludes (S4-F01, F4-05). C1 **normalizes inside `isIpInCidr`**, removing the third F1 direction rather than documenting it (T-R4-01 option ii). C1's team path **delegates** rather than inlining a second emit with a false reason string (F4-07). C1's F1 evidence becomes a **committed test** (T-R4-07). C6's entry point becomes `buildOutboxPayload(…).metadata` (F4-06) and `isWellFormed()` is replaced (T-R4-02). Counts and citations corrected (F4-04, F4-08, F4-09, T-R4-13).

**Specifications dropped.** Per-criterion harness assignments beyond the two measurement showed load-bearing; exact assertion spellings; fixture construction detail. Phase 2 builds and measures those. The rule revision 5 adopts: a mechanism that cannot be described without being run is one to run.

**Carried forward into the plan (4), each with an Anti-Deferral entry and what would settle it**: CFP1 (C3's `metadata.claim` requirement verified first, not last — the chain has been under-counted twice), CFP2 (C4's now-redundant `:141`/`:145` checks), CFP3 (`/api/mcp/token`'s capacity property has no harness), CFP4 (`isIpInCidr` normalization is a change to a shipped policy primitive).

**Still deferred by user decision**: SC7 and SC9, as one follow-up issue.

## Phase 1 exit

Exited **by decision, not by saturation** — the skill's criterion 2 is unmet while SC7 and SC9 carry Anti-Deferral dispositions, and Round 4 left Criticals that revision 5 addresses without a further review round. Surfaced to the user with the numbers and the trend; the user chose to apply the decisions and proceed to Phase 2.

The judgement this rests on, recorded because it is the reusable part: **four rounds in, the plan had stopped removing defects and started producing them.** Round 4's Criticals were all in revision 4's own new mechanisms, three were settled by a single execution taking under a minute, and two clauses had their fix generate the next round's finding twice running. Prose specification of a mechanism is cheaper than building it only until the specification becomes the defect surface; past that point the cheaper order is to build, measure, then write down what was measured.

## Recurring Issue Check — Round 4

### Functionality expert
R1, R2 [N/A] · R3 [F4-01, F4-05, F4-07] · R4 [N/A] · R5 [Checked] · R6–R8 [N/A] · R9 [Checked — C2's emit→throw removed the tx-boundary hazard; the residual was the sink, F4-05] · R10–R14 [N/A] · R15 [Checked] · R16–R20 [N/A] · R21 [Checked — probe created and removed in one command; tree clean] · R22, R23 [N/A] · R24 [Checked] · R25–R28 [N/A] · R29 [F4-04, F4-08, F4-09] · R30 [N/A] · R31 [F4-03] · R32–R40 [N/A] · R41 [Checked] · **R42 [F4-02, F4-03, F4-04]** · R43 [Checked] · R44–R47 [Checked] · **R48 [F4-05, F4-10]** · R49 [Checked] · **R50 [F4-01 — measured green whether or not the mechanism ships]** · R51, R52 [N/A] · **R53 [F4-01 — the cap escaped two rounds of specification while never able to fire]** · R54 [N/A] · R55 [Checked — F4-01 and the C6 order question both settled by running the real primitive] · R56, R57 [N/A]

### Security expert
R1 [N/A] · R2 [Checked] · R3 [S4-F01, S4-F02, S4-F05] · R4–R8 [Checked] · **R9 [S4-F01, S4-F02, S4-F09 — three emit-position findings, all in the audit path]** · R10–R20 [Checked] · R21 [Checked — read-only, tree clean] · R22–R28 [Checked] · R29 [S4-F03, S4-F04, S4-F06] · R30–R41 [Checked] · **R42 [S4-F03, S4-F04, S4-F06]** · R43 [Checked] · R44–R47 [Checked] · R48 [S4-F07] · R49 [S4-F01] · R50 [Checked] · R51, R52 [Checked] · **R53 [S4-F01 — the C2 record escaped a second round: removed in Round 3, replaced by a sink disabled by default]** · R54 [N/A] · R55 [Checked] · R56, R57 [N/A] · RS1, RS2 [Checked] · RS3 [Checked — CSV formula injection verified closed for the retained `reason`] · RS4 [Checked] · RS5 [S4-F03, S4-F06] · RS6 [Checked]

### Testing expert
R1, R2 [Checked] · R3 [T-R4-05, T-R4-09] · R4–R8 [N/A] · R9 [Checked] · R10, R11 [N/A] · R12 [Checked] · R13, R14 [N/A] · R15–R17 [Checked] · R18 [T-R4-08] · R19 [T-R4-04, T-R4-12] · R20 [N/A] · R21 [Checked — probes from `/tmp` and a deleted scratch copy; tree clean] · R22 [Checked] · R23–R28 [N/A] · R29 [T-R4-04, T-R4-13] · R30 [Checked] · R31 [T-R4-02, T-R4-03] · R32, R33 [N/A] · R34 [Checked] · R35 [N/A] · R36 [Checked] · R37 [N/A] · R38 [Checked] · R39, R40 [N/A] · R41 [T-R4-11] · **R42 [T-R4-03, T-R4-06, T-R4-08, T-R4-09]** · R43, R44 [Checked] · R45, R46 [Checked] · R47 [Checked] · **R48 [T-R4-01 — the boundary/policy correction was made in prose and not propagated to F1's direction partition]** · R49 [T-R4-07] · R50 [T-R4-03, T-R4-11] · R51, R52 [Checked] · **R53 [T-R4-05 — the `bucketOf` derivation escaped a second measurement in the paragraph written to fix it]** · R54 [N/A] · R55 [Checked] · R56, R57 [N/A] · RS1–RS6 [N/A] · **RT1 [T-R4-08, T-R4-12]** · RT2, RT3 [Checked] · **RT4 [T-R4-02, T-R4-03 — two assertions that cannot fail for the reason they claim, both measured]** · RT5 [T-R4-08, T-R4-09, T-R4-11] · RT6 [Checked] · RT7 [T-R4-03, T-R4-06] · RT8 [T-R4-07] · RT9 [T-R4-04] · RT10 [T-R4-01, T-R4-13] · RT11 [T-R4-04, T-R4-12]
