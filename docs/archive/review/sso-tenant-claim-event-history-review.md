# Plan Review: sso-tenant-claim-event-history
Date: 2026-07-31
Review round: 1

## Changes from Previous Round

Initial review. Ollama pre-screening (`pre-review.sh plan`) returned "No issues found",
so nothing below duplicates it.

**Perspective convergence** (severity floor raised where two or more experts reached the
same defect independently):

| Converged issue | Reached by | Floor |
|---|---|---|
| `client_addr` is NULL over a Unix-domain socket, and the plan does not state nullability | F7 (Major), S5 (Minor), T16 (Minor, adjacent) | **Major** |
| `old_tenant_id`/`new_tenant_id` population unspecified; VE2 cleanup and `history --tenant` both key on them | F6 (Major), T6a (Major) | **Major** |
| The member set omits `.sql` writers under `scripts/` and the `ON DELETE CASCADE` path | F1 (Major), S9 (Minor) | **Major** |
| `operation` is not a partition: `add --from` on a revoked row is reassign **and** un-revoke | F12 (Minor), S11 (Minor) | **Major** (2 perspectives) |
| C2's manifest criterion overstates what is mechanically checked | F3 (Major, wrong delta), T12 (Major, runs in no CI job) | **Major** |
| C5's gate cannot distinguish `cmdAdd`'s three writers / rests on an unpinned spelling | F2 (Major), T5 (Major), T9 (Major) | **Major** |

---

## Functionality Findings

Verified-true plan claims (checked against code, recorded so they are not re-derived):
the RLS-manifest discovery predicate is a `tenant_id`-column / `<t>_tenant_isolation`-policy
count parity (`scripts/rls-cross-tenant-verify.sql:112-134`), so the new table is exempt by
construction and the four-way count stays 56; `DEFAULTACL:passwd_user public r
passwd_app=arwd/passwd_user` (`db-grants-manifest.json:26`) makes the migration REVOKE
load-bearing; `cmdAdd` does print `NOT RECOVERABLE` (`scripts/tenant-domain.ts:1020`,
`README.md:353`, `README.ja.md:352`); `check-critical-audit-atomic.mjs:41` `SEARCH_DIRS`
excludes `scripts/`. Placement of the event write after `RELEASE SAVEPOINT`
(`src/lib/tenant/tenant-management.ts:438`) is achievable and cannot double-emit.

- **F1 — Major — R42: the writer member set omits two `scripts/` raw-SQL writers and the
  whole test tree, all inside C5's declared scan root.** `scripts/lib/tenant-claim-backfill.sql:34`
  and `scripts/rls-cross-tenant-seed.sql:150` are spelling-3 writers; 33 spelling-1 and 3
  spelling-2 writers live in test files. C5's enumerated non-members list only aliased
  delegates and runtime-assembled SQL, so the gate is red on day one or gets an
  out-of-contract exclusion.
- **F2 — Major — C5's "same enclosing function" predicate is coarser than the member set.**
  `scripts/tenant-domain.ts:936/960/973` are all inside the one `withBypassRls` callback at
  `:798-1035`; one event anywhere in it satisfies the predicate for all three arms. Both
  stated red-proofs are single-writer fixtures, so a gate with this hole passes them. Same
  shape as D-49 (the CAS tests all raced the field that *was* covered).
- **F3 — Major — C2's "the manifest delta is exactly one `TABLE:passwd_app … INSERT` line"
  is false.** `audit-db-grants.mjs` emits `FUNCTION:<grantee>…EXECUTE` per grantee; the
  existing `audit_outbox` guard function appears four times
  (`db-grants-manifest.json:29,33,38,42`). Two new trigger functions add ~8 lines.
- **F4 — Major — F4's two-kind attribution is unmet for the revoke writer.** `cmdRemove`
  (`scripts/tenant-domain.ts:1045`) takes no `--by`, and `db_user` is the shared privileged
  role for every operator, so a revocation event names no human. The plan's own scenario 2
  ("two rows, both principals") is unachievable for the first row.
- **F5 — Major — `history --tenant <ref>` cannot serve scenario 3.** `resolveTenantRef`
  (`scripts/tenant-domain.ts:168-188`) resolves only through live rows, all of which a tenant
  deletion removes. I4 guarantees the row survives; C6 gives no way to reach it.
- **F6 — Major — `old_tenant_id`/`new_tenant_id` population semantics unspecified for the
  three non-reassign operations**, while both the VE2 cleanup predicate and `history --tenant`
  key on them. Both-NULL rows are unreachable by cleanup on a table where DELETE is blocked.
- **F7 — Major — `client_addr` nullability unspecified; `inet_client_addr()` is NULL over a
  Unix-domain socket.** With C4's write fail-closed, a `NOT NULL` column turns every
  first-ever sign-in into a denial on a socket-connected deployment, and no TCP-based test
  can catch it.
- **F8 — Minor — `created_at` clock semantics.** `now()`/`CURRENT_TIMESTAMP` is
  transaction-start, which D-14 puts *before* the operator answered the prompt; `cmdRemove`
  writes `revokedAt: new Date()` (`:1127`), so an event can carry a `created_at` earlier than
  the `new_revoked_at` it records.
- **F9 — Minor — "a Prisma `create()` would fail, therefore raw INSERT" overstates it.**
  `createMany()` emits no `RETURNING` and is privilege-compatible; the real reasons (one
  producer, the no-`RETURNING` spelling guard) are already in C3.
- **F10 — Minor — C3's "takes the transaction client, never the global proxy" has no
  adjudicator.** `Prisma.TransactionClient` is `Omit<PrismaClient, ITXClientDenyList>`, so a
  `PrismaClient` satisfies it structurally.
- **F11 — Minor — no gate survey.** `check-operator-echo-escaped.mjs` (`SCAN_ROOT = "scripts"`,
  `pre-pr.sh:335`) and `check-gate-selftest-coverage.sh` (`pre-pr.sh:341`) both fire and are
  unnamed. Recorded N/A after checking: `check-critical-audit-atomic`,
  `check-null-tenant-fail-closed`, `check-count-then-create-lock`, `check-console-sinks`,
  `worker-policy-manifest.json`.
- **F12 — Minor (raised to Major by convergence with S11) — the four operations are not
  disjoint.** `scripts/tenant-domain.ts:936-939` sets `tenantId` *and* clears `revokedAt`.

## Security Findings

Principal reachability table (derived from `bootstrap-rds-roles.mjs:289-371`,
`db-grants-manifest.json:24-26`): `passwd_app` INSERT-only, correctly contained;
`passwd_outbox_worker` / `passwd_retention_gc_worker` / `PUBLIC` no access;
**`passwd_user` (owner — migrations and the CLI) can defeat the trigger layer three ways.**

- **S1 — Major — the GUC escape makes the append-only trigger voluntary for exactly the
  principal it is claimed to bind.** An unregistered two-part custom GUC is a `PGC_USERSET`
  placeholder; `pg_parameter_acl` cannot privilege it. The repo proves it — `passwd_app`
  (NOSUPERUSER) sets `app.bypass_rls` on every request (`src/lib/tenant-rls.ts:65-68`). R49:
  a control documented as `enforceable boundary` (I1) implemented as a convention, with
  SC-B declining a hash chain *because* this one was believed to close the class.
  Recommendation: a `SECURITY DEFINER` purge routine in the shape of
  `prisma/migrations/20260522000200_audit_log_revoke_via_definer/migration.sql:26-41`
  (`audit_log_purge`), so the escape has an ACL identity that `audit-db-grants.mjs` sees.
- **S2 — Major — `TRUNCATE` is not covered.** Statement-level TRUNCATE triggers are a
  separate event; a row-level `BEFORE DELETE` does not fire. The one statement that destroys
  the whole history is the one the control cannot see, and it is silent. The cited
  `audit_outbox` precedent has the same hole.
- **S3 — Major — `session_replication_role = 'replica'` disables the trigger, and this repo
  already does that in a migration** (`20260321100000_unify_all_ids_to_uuid/migration.sql:27`,
  reset at `:736`). Compounding: `db-grants-manifest.json` has no key form for triggers, so
  the trigger layer has **zero** deploy-time drift detection while the privilege layer has two
  enforcement consumers. Remedy: `ENABLE ALWAYS TRIGGER` and assert `tgenabled = 'A'`.
- **S4 — Major — C2 registers only `passwd_app`.** The two worker roles are protected by the
  descriptive manifest alone, which `--write` launders — the exact #745 mechanism. "This table
  should be retention-GC'd" is the most predictable future change against a table whose
  purpose is not being retention-GC'd. All three roles are in `AUDITED_ROLES`, so entries for
  them are live rather than inert.
- **S5 — Minor — F4's non-forgeable attribution is weaker than claimed.** `current_user`
  follows `SET ROLE` and becomes the routine owner inside a `SECURITY DEFINER` context (the
  repo already routes `CALL audit_log_tenant_migrate` on the auth path). If the trigger
  function itself is written `SECURITY DEFINER`, I2 is silently vacuous. `inet_client_addr()`
  is the container IP under Docker, the task ENI on ECS, the proxy behind RDS Proxy, and
  NULL over a socket — on the sign-in path it is constant and carries no attribution.
  Remedy: record `session_user` alongside `current_user`; declare the trigger
  `SECURITY INVOKER` explicitly.
- **S6 — Minor — no length bound or character CHECK on `actor_label`/`claim`** in a table
  nothing can delete. `tenant_claims` carries `VARCHAR(255)` + a printable-ASCII CHECK; the
  new table inherits none of it, and `--by` is length-unbounded everywhere. RS3.
- **S7 — Minor — client IPs retained indefinitely.** `audit_logs` also stores an IP but is
  retention-GC'd and strips `ip` at egress. Per S5 the column's value is near-zero on the hot
  path, so the retention is paid for very little.
- **S8 — Minor — SC-A's growth bound is attributed to the wrong actor.** First-ever tenant
  creation is not an operator action; it is reachable by anyone who can complete an IdP
  authentication, bounded by `withCallbackRateLimit` — the control D-33 names.
- **S9 — Minor (raised to Major by convergence with F1) — the member set is silent about the
  two writers no AST gate can see**: `scripts/rls-cross-tenant-seed.sql:150`, and the
  `tenants → tenant_claims ON DELETE CASCADE` path
  (`20260729110000_add_tenant_claims/migration.sql:29`), which changes what a claim resolves
  to and leaves no event.
- **S10 — Minor — `history` prints stored values, which `check-operator-echo-escaped.mjs`
  structurally cannot see** (`:19-30, 47-50` — a database row is deliberately not tainted),
  so the zero baseline does not cover it.
- **S11 — Minor (converged with F12) — `add --from` on a revoked row has no `operation`
  case**, and the acceptance criteria omit it.

Assessed, no finding: **egress** (`passwd_app` has no SELECT; `EXTERNAL_DELIVERY_METADATA_BLOCKLIST`
already strips `claim`/`claimRefusal`/`ip`); **injection** (parameterised tagged template,
`ident-markers=0` correct, Layer 2's interpolation ban applies regardless of allowlisting);
**SC-B's conclusion** (defensible — but its *argument* is falsified by S1/S2/S3 and becomes
true once those are fixed, because the remaining defeat requires DDL, which is louder and
which a hash chain would not prevent either).

## Testing Findings

- **T1 — Critical — C2's red-proof cannot fail for the reason it claims.** "On a throwaway
  table … exits non-zero **naming this table**" is self-contradictory, and the mechanism it
  actually exercises is already proved by `audit-db-grants.integration.test.ts` and
  `bootstrap-rds-roles.integration.test.ts:72-101`. Deleting C2's entry leaves it green.
  The real coverage is unnamed: `app-role-denied-privileges.integration.test.ts:49-52`
  derives its cases *from the policy file* and asserts `has_table_privilege` false live —
  non-vacuous precisely because `ci-integration.yml:167` re-grants `ON ALL TABLES` after
  `migrate deploy` and `:183-186` re-applies the revoke.
- **T2 — Critical — C4's atomicity and retry criteria are vacuous as written.** (a) The plan
  names one vacuity and misses the load-bearing one — *how the abort is injected*. A JS throw
  placed before the event write makes "neither row" trivially true. (b) The slug-retry arm is
  only taken on a P2002 on `tenants_slug_key`; without forcing it, `count === 1` passes on the
  happy path (RT4 — needs a positive lower bound, e.g. the surviving slug's random-hex suffix).
- **T3 — Major — C1's append-only trigger has no stated red-proof**, and the only obvious
  mutation (`DROP`/`DISABLE TRIGGER`) disarms the control durably on the shared dev DB (VE1) —
  the class `scripts/lib/denied-privileges.mjs:29-36` records as having actually happened.
- **T4 — Major — the `db_user` assertions have different correct values locally and in CI.**
  `MIGRATION_DATABASE_URL` is `passwd_user` locally and `postgres` in CI
  (`ci-integration.yml:190-196`); the CLI cases run in-process through the same URL. A literal
  assertion is red in CI; the obvious "fix" (`toBeTruthy`) makes I2 unfalsifiable.
- **T5 — Major — C5's spelling-2 detection rests on an unpinned identifier.** The AST project
  runs without a Program, so the gate can only match the spelling `claims:`; a schema rename
  retires the gate on real source with a green self-test (R47 / RT7 structurally blind). Also
  missing: the RT10 allow-side fixture.
- **T6 — Major — the cleanup predicate is not derived from the row set.** (a) both-NULL rows
  are undeletable by construction; (b) "the deletion is itself an assertion" is false — a
  zero-row DELETE fires no row-level trigger, and ~95 suites create no events; (c) the GUC
  must be pinned to `set_config(..., true)`, or it persists on a pooled connection (`max: 3`)
  and silently disarms the trigger for the rest of the file.
- **T7 — Major — C6's `history` criteria have no per-run claim token.** The shared fixtures are
  bare constants; every existing suite derives `${runToken()}.${ALIAS_CLAIM}`
  (`tenant-claim-cli.integration.test.ts:9-13`, F15). The events table has no `UNIQUE(claim)`
  to make a collision loud, so under VE1 "one row" silently becomes two.
- **T8 — Major — the const-object ↔ CHECK drift guard adjudicates the wrong artifact** (R48).
  A migration file is immutable once applied; the live constraint can change without it. The
  authoritative form is `pg_get_constraintdef` set-equality at integration level, with the
  D-7 shape's `toBeDefined()`-on-both-extractions guard retained.
- **T9 — Major — four forbidden patterns with no runner** — the shape D-13 recorded one PR
  ago. The one that matters: a direct `tx.tenantClaimEvent.create(...)` at a call site
  satisfies C5 while breaking the single-producer invariant and the no-`RETURNING` constraint,
  which fails at run time on the sign-in path and passes every mocked test.
- **T10 — Major — RT8 applied to I2 only.** "UPDATE and DELETE raise" and "the same statements
  succeed with the GUC" are verdicts; an `UPDATE … WHERE <wrong id>` also raises nothing and
  changes nothing.
- **T11 — Major — contracts with no acceptance criterion**: NF1 (nothing asserts that a
  sign-in resolving an *existing* claim writes zero events), NF2, C4's fail-closed sign-in
  direction (RT10 — the guard tested only on its allow side, on the auth path where a false
  deny is an outage), and F3's two-tenant half (delete *one* of the two tenants a reassign row
  names).
- **T12 — Major — C2's manifest criterion runs in no CI job.** `audit-db-grants` appears in no
  workflow and no `pre-pr.sh` step; its only automated consumers are the Dockerfile and
  `infra/terraform/ecs.tf`, i.e. deploy time. "Checked, not eyeballed" is false, and this is
  the #745 failure mode the plan cites as its own precedent.
- **T13 — Major — C6's "integration + unit" split is unstated**, and a `scripts/__tests__/*.test.mjs`
  placement lands in the **unit** suite — round-2 T6, recorded in
  `tenant-claim-cli.integration.test.ts:5-8`. Under D-25 the unit job's job-level
  `DATABASE_URL` means a `SKIP` guard does not skip in CI.
  Recorded reachable (so Phase 2 does not re-derive): `ci-integration.yml:31` already filters
  `scripts/**`; `ci.yml:50` puts `scripts/**` in the `app` filter; the C5 gate runs via
  `ci.yml:232` (`PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh`) once queued in `pre-pr.sh`;
  `check-gate-selftest-coverage.sh` hard-fails a gate landing without its sibling self-test.
- **T14 — Minor — `trackTenant` not required for the two `tenant-management.ts` writers**
  (`helpers.ts:197-208`, round-3 M8) — a failed assertion now leaks an undeletable event row.
- **T15 — Minor — pin the refusal SQLSTATE to `42501`**; a loose throw assertion greens on
  `42P01` (table absent), the one state where the control genuinely does not exist.
- **T16 — Minor [Adjacent] — `inet_client_addr()` is NULL over a Unix socket**; any
  `not.toBeNull()` criterion is environment-locked green.

## Adjacent Findings

- **A1 (Functionality → Security) — Major — three post-migration blanket
  `GRANT … ON ALL TABLES` sites do not apply the denied-privileges policy.**
  `scripts/rls-smoke-seed.sql:23` and `scripts/rls-cross-tenant-seed.sql:41` run in `app-ci`
  after migrations with no `--denied-only` behind them (`ci.yml:606-620`); `ci.yml:598` runs
  before `migrate deploy` and is harmless. C2's claim that the policy makes it so "the
  table-blind convergence GRANT cannot re-open it" is true of the two covered sites and
  broader than the mechanism. Pre-existing for `audit_logs`/`audit_chain_anchors`; out of this
  diff, but the claim must be scoped.
- **A2 (Functionality → Testing) — Minor — R16: VE3 covers dev-vs-CI *role* divergence but not
  grant-*ordering* divergence.** Dev grants at initdb (pre-migration, so the REVOKE survives);
  CI grants post-migration then re-applies `--denied-only`. A precondition assertion
  (`has_table_privilege(...) = false` before the SQLSTATE case) keeps the case from becoming
  vacuous in one environment.
- **T16 (Testing → Functionality)** — see above; folded into F7's remedy.

## Quality Warnings

None. Every finding cited a file:line or a reproducible mechanism; no `[VAGUE]`,
`[NO-EVIDENCE]` or `[UNTESTED-CLAIM]` flags were raised, and the two Criticals (T1, T2) are
both arguments about what a stated criterion *cannot* fail on, verified against the named
existing tests rather than asserted.

## Recurring Issue Check

### Functionality expert
R1 OK · R2 OK · R3 FINDING-F1 · R4 N/A · R5 OK · R6 FINDING-F6 · R7 N/A · R8 N/A · R9 OK ·
R10 N/A · R11 N/A · R12 OK · R13 N/A · R14 FINDING-F3 · R15 OK · R16 FINDING-A2 · R17 OK ·
R18 FINDING-F11 · R19 N/A · R20 N/A · R21 N/A · R22 OK · R23 N/A · R24 OK · R25 FINDING-F6 ·
R26 N/A · R27 N/A · R28 N/A · R29 OK · R30 N/A · R31 OK · R32 N/A · R33 FINDING-A1 · R34 OK ·
R35 N/A · R36 N/A · R37 OK · R38 N/A · R39 N/A · R40 N/A · R41 FINDING-F5 · R42 FINDING-F1 ·
R43 N/A · R44 N/A · R45 N/A · R46 OK · R47 OK · R48 OK · R49 FINDING-F2 · R50 FINDING-F3

### Security expert
R1 OK · R2 OK · R3 OK · R4 OK · R5 OK · R6 FINDING-S9 · R7 N/A · R8 N/A · R9 OK · R10 N/A ·
R11 N/A · R12 FINDING-S11 · R13 N/A · R14 FINDING-S4 · R15 OK · R16 OK · R17 OK ·
R18 FINDING-S4 · R19 N/A · R20 N/A · R21 N/A · R22 OK · R23 N/A · R24 OK · R25 N/A · R26 N/A ·
R27 N/A · R28 N/A · R29 OK · R30 N/A · R31 FINDING-S2 · R32 N/A · R33 OK · R34 OK · R35 OK ·
R36 OK · R37 OK · R38 N/A · R39 N/A · R40 N/A · R41 OK · R42 FINDING-S9 · R43 N/A · R44 OK ·
R45 OK · R46 N/A · R47 OK · R48 OK · R49 FINDING-S1 · R50 FINDING-S3 ·
RS1 N/A · RS2 FINDING-S8 · RS3 FINDING-S6 · RS4 OK · RS5 N/A · RS6 FINDING-S10

### Testing expert
R1 OK · R2 OK · R3 FINDING-T9 · R4 N/A · R5 OK · R6 OK · R7 N/A · R8 N/A · R9 FINDING-T2 ·
R10 N/A · R11 N/A · R12 OK · R13 N/A · R14 OK · R15 OK · R16 FINDING-T4 · R17 FINDING-T14 ·
R18 OK · R19 N/A · R20 N/A · R21 N/A · R22 OK · R23 N/A · R24 OK · R25 OK · R26 N/A · R27 N/A ·
R28 N/A · R29 N/A · R30 N/A · R31 OK · R32 N/A · R33 FINDING-T12 · R34 OK · R35 OK · R36 N/A ·
R37 OK · R38 N/A · R39 N/A · R40 N/A · R41 FINDING-T12 · R42 FINDING-T5 · R43 FINDING-T6 ·
R44 OK · R45 OK · R46 OK · R47 FINDING-T5 · R48 FINDING-T8 · R49 FINDING-T12 · R50 FINDING-T1 ·
RT1 OK · RT2 OK · RT3 FINDING-T7 · RT4 FINDING-T2 · RT5 OK · RT6 OK · RT7 FINDING-T1 ·
RT8 FINDING-T10 · RT9 FINDING-T9 · RT10 FINDING-T11

---

## Round-1 Disposition

Two user decisions were taken before revising the plan, both on the recommended option:

- **F4** → `remove` gains a **required** `--by`, so all four CLI writers carry a
  self-asserted label. This changes a CLI contract shipped in #740; C6 and C7 own the
  README/`CLAUDE.md` updates.
- **S1** → the trigger escape becomes a **tenant-scoped purge routine**, not a bare GUC.
  The GUC survives only as the routine's internal mechanism.

  **Corrected in place after round 2** (**U11**/**G9**): as first recorded, this entry read
  "a `SECURITY DEFINER` … routine (`audit_log_purge` shape, `EXECUTE` revoked from
  `PUBLIC`, denied to `passwd_app` in C2)". The plan ships `SECURITY INVOKER`, and two of
  those three sub-clauses are retired rather than deferred. The reasons, verified
  independently by both the security and functionality experts in round 2:
  - `prisma/migrations/20260725140000_revoke_definer_execute_from_public/migration.sql`
    already put the **unscoped** `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM
    PUBLIC` in force, and `bootstrap-rds-roles.mjs` issues no function grants at all — so a
    new routine is owner-only from birth and needs no `REVOKE … FROM PUBLIC` statement. The
    mechanism is self-aligning across environments because the ADP and the new migration run
    as the same connection role in one `migrate deploy` stream.
  - under those conditions `SECURITY DEFINER` would **add** risk: it would let a future
    `GRANT EXECUTE` hand evidence deletion to a role that deliberately holds no `DELETE`.
  - "denied to `passwd_app` in C2" was never expressible: `scripts/lib/denied-privileges.mjs`
    restricts privileges to `SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER` — no
    `EXECUTE` — and its subject to a table identifier, so such an entry throws
    `DENIED_POLICY_INVALID` and breaks both consumers.

  The intent the decision expressed — an escape with a bounded predicate and a named,
  greppable identity instead of an ambient GUC — is delivered. What round 2 also established
  is that the routine is **not** a bound (round-2 **G5**): the bound is the table ACL. The
  plan states that rather than claiming the ACL identity as a control.

All Critical and Major findings are reflected in revision 2 of the plan. Minor findings
reflected: F8, F9, F10, F11, F12/S11, S5, S6, S7, S8, S10, T14, T15, T16.

**Skipped, with Anti-Deferral cost-justification:**

- **A1 (Major, Adjacent)** — *Skipped: pre-existing and out of scope.* The two uncovered
  post-migration grant sites (`rls-smoke-seed.sql:23`, `rls-cross-tenant-seed.sql:41`) already
  re-open `audit_logs`/`audit_chain_anchors` in `app-ci` today; that is a defect in #745's
  wiring, not one this diff introduces, and fixing it means changing the RLS-smoke job's
  bootstrap for reasons unrelated to claim history. **Cost of deferral**: `app-ci`'s
  `rls-smoke` job continues to run with an over-privileged `passwd_app`. It is bounded — that
  job seeds and reads its own fixtures and asserts nothing about immutability — and the
  integration job, where C1's privilege assertions actually run, is on the covered path
  (`ci-integration.yml:183-186`). **Owner**: recorded here and to be filed as its own issue
  after this PR merges, since it is the same class as #745 and deserves that issue's
  treatment rather than a rider. C2's wording is narrowed so the plan does not claim coverage
  it does not have.
- **S3's second half (trigger-layer deploy-time drift detection)** — *Skipped: deferred with
  an owner.* Extending `audit-db-grants.mjs` with a `TRIGGER:<table>\t<name>\t<tgenabled>` key
  form is a change to the shared grants auditor's output schema, which regenerates every
  manifest key and touches a file two other controls read. **Cost of deferral**: a migration
  that drops or disables the trigger passes the deploy-time audit; the loss is detected only
  by CI. **Mitigation shipped instead**: `ENABLE ALWAYS`, the `TRUNCATE` trigger, and an
  integration assertion on `tgenabled = 'A'` rather than mere trigger existence, so the
  regression is caught before deploy rather than after. C1 states the limit explicitly.

---

# Round 2 — revision 2

**Result: 1 Critical, 8 Majors, 10 Minors. None against the design.** Three of the
Majors were *introduced by round-1's own fixes*, which is the empirical reason round 3
was run rather than locking here.

## Changes from Previous Round

Revision 2 rewrote the plan against round 1: the escape hatch became a routine, the
trigger set gained `TRUNCATE` and `ENABLE ALWAYS`, `remove` gained a required `--by`,
the tenant columns gained a per-operation population rule and a `CHECK`, and every
vacuous acceptance criterion was respecified.

## Findings

**Critical**

- **U1** (Testing) — C5's predicate (1) was a *global-existence* check over the scanned
  tree. `register` is emitted by three sites, so `cmdAdd`'s create arm could lose its
  event with all three predicates green. The listed single-file fixture could not
  red-prove the blindness, because in an isolated tree the unemitted operation appears
  nowhere else and even the blind predicate reds — a green self-test certifying a
  predicate blind on the subject it ships against.

**Major**

- **G1 / S12** (converged) — the `audit-db-grants.mjs` CI step added in revision 2
  cannot pass: the manifest hardcodes `passwd_sso`/`passwd_user`, `ci-integration.yml`
  runs `passwd_test` owned by `postgres`, and `passwd_user` is never created there. Ten
  keys mismatch before the diff adds anything, and both natural repairs (a second
  manifest; a `--write` in CI) are the shapes #745 and `denied-privileges.mjs` exist to
  prevent.
- **G2** — `set_config(…, true)` inside a plpgsql body persists to the end of the
  *caller's* transaction, so calling the purge routine from `deleteTestData` would
  disarm the trigger for that transaction's remaining ~25 statements, on a superuser
  connection. Only a function-level `SET` clause scopes it to the call.
- **G3 / S17** (converged) — a tenant-scoped purge deletes a `reassign` row that still
  names a live tenant, and the plan resolved neither the semantics nor the test.
- **G5 / S13** (converged) — the escape hatch's "the capability is a named object with
  an ACL", I1's "except through the purge routine", and SC-B's "defeat requires DDL"
  all survived the `SECURITY INVOKER` refinement that negates them. R49, in the same
  direction as round-1 S1, one round later.
- **S14 / U5 / A3** (converged) — `remove --by` was specified as a flag and not as a
  guard: no unsafe-character rejection carried over from `cmdAdd`, nine existing call
  sites unnamed, no CLI usage-refusal arm, no allow/deny criteria.
- **U2** — cleanup now requires the harness's client to own the table, but
  `MIGRATION_DATABASE_URL` is optional and falls back to `passwd_app`.
- **U3** — the throwaway-table red-proof left three things open: DDL provenance (an
  RT9 twin if hand-written), object lifetime (a Prisma `$transaction` **commits** on
  success), and the pairing that makes it non-circular.
- **U4** — `deleteTestData` would call the purge routine unconditionally; on a
  checked-out-but-unmigrated database that is `42883`, which is not retryable, in every
  integration file.
- **U6** — the fail-closed deny-side case revoked `INSERT` from a role that is
  SUPERUSER in both environments, so it silently tested the allow path.
- **G4** — the F2 fix introduced a *second* derived identifier (the operation names)
  and pinned only the first.

**Minor**: S15 (`ENABLE ALWAYS` omitted from the INSERT trigger, whose bypass makes
attribution *forgeable*), S16 (`actor_label` bound described as a backstop to a
nonexistent CLI length check; principal columns unbounded on a fail-closed path), S18 /
U9 / G6 (C1 and C2 contradict each other on the expected `FUNCTION:` delta), S19 / G7
(predicate 3 prosed broader than C3's pattern, banning C6's required read; verb lists
disagree), S7-residual, S8, S10, S11, U7 (`check-env-docs` check 12 covers `src/**`
only), U8 (C6 overstated the escaping gap — every `cmd*` parameter *is* tainted), U10
(`runToken` mandated but not shared), U11 / G9 (the Round-1 Disposition still recorded
`SECURITY DEFINER`), A4 (a global derived-case count couples this PR to unrelated
future entries), G8 (two in-file documentation sites, one falsified by this PR).

## Round-2 Disposition

All Critical and Major findings, and every Minor listed above, are reflected in
revision 3 of the plan. The **orchestrator refinement both non-testing experts were
asked to attack and both verified** is recorded above, in the corrected Round-1
Disposition for S1.

---

# Round 3 — revision 3

**Result: 2 Criticals, 5 Majors, 6 Minors. None against the design** — the third
consecutive round with design findings at zero and mechanism findings carrying the
weight. All three experts independently recommended fixing in place and locking rather
than running a fourth round.

## Findings

**Critical**

- **V1** (Testing) — C5 is **fail-open on an empty scan set**. `ast-project.mjs`'s
  walker treats a missing directory as empty by design, and all three of C5's
  predicates are violation-detecting, so zero files scanned means exit 0. The sibling
  it copies (`check-critical-audit-atomic.mjs`) is fail-closed only *incidentally*,
  because its predicate requires each action to be seen. The self-test cannot notice,
  because a fixture tree is populated by construction.
- **V2 / H2 / S21** (converged, Testing Critical + Functionality Major + Security
  Minor) — the fail-closed deny-side case passes for the wrong reason. A freshly
  created role holds nothing: `CONNECT` is revoked from `PUBLIC`, `CREATE ON SCHEMA
  public` is revoked in both environments, and the writer path needs `SELECT`/`INSERT`
  on `tenants` and `tenant_claims` before the event INSERT is reachable. So "the
  sign-in fails and no tenant row survives" is satisfied 100% of the time, for a reason
  unrelated to `tenant_claim_events`. The cited precedent (`bootstrap_probe_app`) is an
  ACL-probe role that never runs application code.

**Major**

- **H1 / S20** (converged) — the U1 fix over-corrected: a per-function **cardinality**
  predicate reds on `findOrCreateTenantForClaim`, which has two writer statements (the
  create and its `catch`-clause retry) and which C4 mandates emit **one** event. The
  plan committed a red fixture and a green production site of the same shape, and the
  cheapest repair under time pressure — loosening the predicate — reopens U1.
- **H3** — the G3 resolution puts `deleteTestData` in conflict with F3's own
  acceptance criteria: cleanup now purges the events those criteria assert survive.
- **S22** — the "requires DDL" / "sole GUC producer" / "sole escape" retraction was
  applied to SC-B and C1's bypass list but not to three other sites, one of them
  labelled "the honest statement". R49, third consecutive round, same direction.
- **V3** — the cardinality fix orphaned the operation-set pin while the plan still
  said predicate (1) depended on it.
- **V4** — C5's two derived inputs had no stated resolution root and no fail-closed
  behaviour when absent or unparseable; the sibling precedent moves auxiliary files
  with the scan-root override, which would make the self-test exercise fake copies.
- **V5** — "twelve cases" reintroduced the count defect A4 removed, one level down: it
  reds on a policy *tightening* and greens on a net-zero weakening.
- **V6 / H6** (converged) — the `createTestContext` precondition was stated as table
  *ownership*, which is stronger than an invoker-rights routine needs; a superuser that
  is not the owner would be falsely denied, in front of ~95 integration files.
- **V7** — the reassign-purge case asserts a negative on an effectively empty set, so
  it passes against a routine that deletes nothing.

**Minor**: V8 / S23 / H7 (stale Go/No-Go rows — the withdrawn CI step, and "four
triggers" where C1 specifies three), V9 (the enumerated non-member cites
`check-raw-sql-usage.mjs`'s `EXCLUDE_RE` where the gate would use
`walkSourceFiles`), H4 (the shared `--by` validator inherits a message false for
`remove`), H5 (validator ordering stated as "before the CAS write" permits the
mid-transaction post-prompt refusal C1 spends five lines rejecting), H8 (the plan had
become the defect surface again at 1072 lines), A5 (the swallowed purge failure in
`sweepOutstandingTenants` has no acceptance criterion).

## Round-3 Disposition

**All findings are reflected in revision 4**, which also acts on **H8**: the growth
class it identified — "what a previous revision said and why it was wrong", threaded
through every contract — is removed from the plan and lives here instead. The plan went
1072 → 943 lines *while* absorbing every round-3 fix.

Two findings were resolved by choosing between two offered remedies:

- **H1 / S20** — S20's per-`(function, operation)` **set equality** is adopted over
  H1's `CatchClause` exclusion, because it is derived from C4's member-set table rather
  than from a syntactic accident, and because it simultaneously discharges **V3** (the
  operation-set pin is consumed after all). H1's exclusion is recorded in C5 as an
  admissible implementation, since both must satisfy the same two named shapes.
- **V2 / H2 / S21** — S21's **positive control on the same role** is adopted over
  enumerating the grant set in prose: with `INSERT` granted the call must succeed and
  both rows be present, then revoked it must fail with `42501` naming the table. That
  makes the grant set self-proving — it reds if any prerequisite is missing — and it
  cannot drift from an enumeration. The teardown detail the precedent carries
  (`REVOKE ALL ON DATABASE` → `DROP OWNED BY` → `DROP ROLE`, plus `pool.end()`) is
  stated, since a role holding grants cannot be dropped.

**No round 4.** Three consecutive rounds returned zero design findings; every finding
has been against this document's own mechanism prose, and the last two rounds each
found defects *introduced by the previous round's fixes*. All three experts said so
independently. The remaining verification — whether the function `SET` scopes, whether
`tgenabled` is `'A'`, whether the `42501` assertions carry their preconditions, whether
the per-run role's teardown drops — is Postgres's to give, in Phase 2, against real
code.
