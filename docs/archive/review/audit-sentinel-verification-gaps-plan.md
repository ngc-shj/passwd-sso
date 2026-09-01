# Plan: audit-sentinel-verification-gaps

Follow-ups to #806 (`e3f50de5e`). **Revision 4 — final for Phase 1.**

Three review rounds. Round 3 confirmed that revision 3's de-specification **worked**: for
C1, C10's Bucket C, C11 and C12, an implementer following the derivation obligation alone
reproduces the set exactly — and C12's derivation reached a member (`e2e/helpers/db.ts`)
that neither frozen list had. Every surviving defect round 3 found sits in the one
enumeration revision 3 kept frozen (C14's per-field table) or in the two contracts whose
primitive was left as prose (C5, C10). Revision 4 applies that lesson consistently: it
states obligations and adjudication rules, records currently-derived membership as a
**seed** rather than as truth, and carries the remaining findings to Phase 2 where real
code settles them.

The litigation for all three rounds is in `audit-sentinel-verification-gaps-review.md`.

## Project context

- **Type**: web app (Next.js 16 App Router + Prisma 7 + PostgreSQL 16), plus Node gate
  scripts and worker processes.
- **Test infrastructure**: unit (vitest) + real-DB integration + E2E + CI + `scripts/pre-pr.sh`.
- **Verification environment constraints**:
  - **VC1 — shared dev database.** Destructive operations forbidden. Writes go into a
    `ctx.createTenant()` tenant, or are reclaimed by a discriminator the test itself sets.
    `ctx.cleanup()` sweeps only tenants it handed out, so it can never reclaim anything
    written under the sentinel. **The sentinel is not empty**: round 3 measured live
    `audit_outbox` and `audit_logs` rows under it, written by the retention-GC heartbeat.
    Any post-run assertion must therefore be marker-scoped, never a bare count.
  - **VC2 — integration tests cannot share the database with a live worker.**
    `docker compose stop audit-outbox-worker retention-gc-worker` → run → `start`.
  - **VC3 — no `/proc` on macOS.** The `unallocatablePid()` probe path is unexercisable
    here and in CI. `blocked-deferred` under SC9.
  - **VC4 — a gate executes only where it is wired.** `scripts/pre-pr.sh` is the primary
    path; a CI workflow is the other. A gate referenced by neither does not run. Round 3
    derived seven `scripts/checks/*.mjs` unreferenced by `pre-pr.sh`, of which **three**
    are referenced by no workflow either — so wiring must be pinned, and VC4 must be read
    as "pre-pr **or** a CI workflow", not "pre-pr alone".

## Objective

Close the verification gaps #806's Phase 3 identified, correct the prose that still asserts
pre-#806 behaviour, reconcile the review-artifact chain's stale `Open` sections, enforce the
read-side invariant the sentinel encoding depends on, and widen the narrative gate's sink set
to every field that carries caller-supplied text into a tenant-readable `audit_logs` row.

**Established across three rounds, by execution** (so Phase 2 need not re-derive):
the #806 sentinel branch is mutation-proved twice already, so C2 repairs a misleading third
twin rather than closing a gap; membership is the only gate on `audit_logs` (13 readers,
three resolvers); both `logAuditAsync` catch arms are still log-only, which keeps C10's
three protected security arguments true; and C14's cost premise reproduces — the widened
sink produces zero violations on the current tree.

## Requirements

1. Every behavioural change #806 made has a test that reddens when it is reverted, proved by
   execution, with the failing test **name** recorded.
2. No prose **a reader acts on** — production code, `docs/operations`, `docs/security`, infra
   config, scripts — asserts that an unattributable audit emit writes no row, except where
   scoped to the catch arm. `docs/archive/review/**` is out of class.
3. `docs/archive/review/*.md` `Open`-style sections reflect the code at this branch's base.
   **This branch's own artifacts are out of class** — they are the live record, not a
   historical one, and including them would make the contract circular.
4. A `tenant_members` row naming the sentinel cannot be created by any caller.
5. The narrative gate's sink set covers **every** field that can carry caller-supplied free
   text into a tenant-readable `audit_logs` row **by any path** — including the outbox
   worker's own dead-letter writer, not only the direct insert.
6. Every quantitative claim carries the command that reproduces it **and the command was run**.
7. Every class is re-derived from a **stated, executable** primitive at implementation time.
   A prose label is not a primitive: round 3 showed three plausible readings of one label
   returning 1, 24 and 142 rows. Every exclusion is an adjudication with a reason.
8. No gate is weakened, suppressed, or narrowed to make a check pass. A gate that is added is
   wired (VC4) and that wiring is pinned by an anchored self-test.

## Technical approach

**Obligations, not frozen tables.** Each contract names the defining primitive as a runnable
expression and the adjudication rule. Membership is produced at implementation time and
recorded with its count. Where a derivation returns more rows than the subject, the residue
is adjudicated **by class — one row per file with a reason**.

**Where a derived set is recorded here, it is a seed, not the truth.** Round 3's rule, earned
three times over: a frozen list is a surface that can be wrong, and every one of this plan's
frozen lists eventually was. A seed exists so the pre-edit validation is decidable; it does
not license skipping the derivation.

**C5 and C10 use a diff criterion**, with the derivation expression recorded verbatim and
re-run byte-identically for the "after" pass. Round 3 established both directions of the
hazard: revision 2's element-wise criterion was unsatisfiable, and a criterion with no stated
expression is trivially satisfiable. Both need the expression pinned **and** a pre-edit
validation against a seed.

**Invariant strength.** C12's invariant is expressible in the storage engine, so it is
schema-enforced. The operator-tool refusal is a message over that boundary, not a second
adjudicator.

**No concurrency probe required.**

---

## Contracts

### C1 — The two sentinel emits `e3f50de5e` added are mutation-proved

**Class.** Emit sites stating a literal sentinel tenant **and** touched by `e3f50de5e` — the
intersection of

```bash
grep -rn "tenantId: SYSTEM_TENANT_ID" src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

with `git show --stat e3f50de5e`. Round 3 reproduced this exactly: the grep returns seven
sites, the intersection is the two route emits, and the anchor-publisher and retention-GC
sites fall out because that commit does not touch those files. They are adjudicated **out of
scope under SC8**, never filtered.

*Naming note*: these are called "the two `e3f50de5e` sentinel emits" rather than "pre-auth"
— one of them issues a token to an existing session, and SC1's bound is stated over IP-metered
routes, so the looser label invited reading SC1 as covering C1 by title alone.

**Defect.** The existing assertions do not **name** `tenantId`. `objectContaining` is not the
cause — it ignores extra keys but requires every key it lists — so listing `tenantId` inside
it is the correct, non-brittle fix; an exact-shape matcher is the failure mode.

**Control class**: `detection or audit only`. No gate enforces the assertion shape; the two
mutation proofs below are the mechanism, and that is stated rather than implied by a
forbidden-pattern list.

**Acceptance criteria**:
- **Deny**: delete the field from each route in turn on a committed tree → at least one case in
  that route's test file fails. Two mutations, two runs, both failing test names recorded.
- **Allow**: with the field present **and one unrelated field added to the same emit call**,
  every case in both files still passes — the clause that rules out the exact-shape matcher.
  Red-prove, then revert the throwaway field. (It also moves the C14 parity figure while it is
  in the tree; see the Go/No-Go note.)
- **Do not delete** the existing assertions. Add the key.
- **Tie**: `SYSTEM_TENANT_ID` imported from `@/lib/constants/app`, never re-spelled.
- **Fail loud**: vitest reporting 0 collected tests for either file is a failure, not "no gap".

---

### C2 — `src/__tests__/audit.mocked.test.ts` stops misleading

**Scope**: repairs or retires a third twin whose mocks make its cases assert less than they
appear to. It is not closing a #806 gap.

**Two blockers, in order**: most `logAuditAsync` calls use a non-UUID actor, so the actor guard
returns before tenant resolution — `withBypassRls` is reached zero times today; behind that,
the `@/lib/prisma` mock lacks `$executeRaw`, which `withBypassRls` calls three times.

**Signature**: the mock gains `$transaction`, `$executeRaw`, `user.findUnique`,
`team.findUnique`, typed as:

```ts
type MockPrisma = Pick<PrismaClient, "$transaction" | "$executeRaw"> & {
  user: Pick<PrismaClient["user"], "findUnique">;
  team: Pick<PrismaClient["team"], "findUnique">;
};
```

A flat `Pick<PrismaClient, "user" | "team" | …>` does **not** compile — `Pick` selects whole
members and demands the full delegate (`TS2740`). The nested form compiles; renaming a mocked
method fails (`TS2561`), and renaming inside the `Pick<>` list fails (`TS2344`) — both red, so
the deny arm holds either way. It catches signature drift on those four members and **not** a
newly called fifth; that residual is covered by the per-case dead-letter assertion below, and is
stated rather than papered over. Never use a cast. `deadLetterLogger` must be mocked.

**Forbidden pattern**: a non-UUID actor id in any case that asserts on the enqueue mock. Scoped
to those cases — the structured-JSON case runs before the guard, so a non-UUID actor is correct
there and is what makes that case non-vacuous.

**Acceptance criteria**:
- **Deny (branch)**: change `resolveTenantId`'s sentinel fallback → the new case reddens.
- **Deny (mock completeness)**: delete `$executeRaw` → the same case reddens **on the
  dead-letter-not-called assertion**, not on the enqueue assertion. Two mutations, two runs, two
  distinct failure messages.
- **Deny (typing)**: rename one mocked delegate method → `npx tsc --noEmit` fails. It is already
  wired into `pre-pr.sh`, so the arm has a green baseline.
- **Allow**: a case with an explicit `tenantId` still enqueues under **that** tenant.
- **Do not delete** the invalid-actor coverage: keep one case with a non-UUID actor asserting the
  dead-letter reason. That guard holds the outbox worker's UUID invariant.
- Assert dead-letter-not-called in **every** enqueue-path case.
- **Fail loud**: a run collecting 0 cases from this file, or a case where the enqueue mock is
  called zero times without an explicit assertion of that, is a failure.
- Rename the case whose name claims a resolution flow it does not exercise, or drop its explicit
  `tenantId`.
- **RT9**: record what each of the three `logAuditAsync` suites exists for, or delete the
  redundant one. Do **not** delete the working sentinel proof in `audit-fifo-flusher.test.ts`.

---

### C3 — The integration file proves FK acceptance by writing, and reclaims what it writes

**Defect**: the docblock claims to show the row is accepted by the database; the file contains
three read-only `SELECT`s.

**Reclaim.** `logAuditAsync` returns void and `audit_outbox` carries no caller-supplied key, so
the test sets its own discriminator: emit with `targetId` = a per-run `randomUUID()` (a literal
UUID — `targetId` is a narrative sink under C14, so caught-error text there would be a
self-inflicted violation), then select ids by
`tenant_id = <sentinel> AND payload->>'targetId' = <marker>`. Round 3 confirmed `payload` is
`jsonb` and `targetId` a top-level key. Reclaim in an `afterEach` — not a trailing statement,
which does not run when an assertion throws — scoped by those ids and **never** by
`tenant_id = <sentinel>` alone. Order: `UPDATE … SET status = 'FAILED'::"AuditOutboxStatus"`
then `DELETE`, because the BEFORE DELETE trigger blocks deleting `PENDING`/`PROCESSING` rows.

Add a guard in the integration helpers' `trackTenant` that throws on the sentinel, so a future
test cannot reach `DELETE FROM tenants` on it.

**Control class**: `fail-closed verification gate`.

**Acceptance criteria**:
- **Deny**: point `SYSTEM_TENANT_ID` at a UUID with no `tenants` row (throwaway copy, reverted
  immediately) → the case reddens on the row's **absence**. The channel is the **enqueue helper's
  explicit `SELECT EXISTS (… FROM tenants …)` guard**, which throws before the insert, so the FK
  never fires on this path — round 3 corrected this, and the testing strategy requires the
  observation confirm the channel. FK acceptance is proved by the **allow** arm, not the deny arm.
- **Allow**: the same call with an explicit `ctx.createTenant()` tenant lands a row — this is
  the FK-acceptance proof.
- **Allow (`trackTenant` guard)**: a normal tenant id still works; only the sentinel throws.
- **RT11, executed**: insert a forced failure immediately after the write, run, confirm the case
  fails **and** that the **marker-scoped** outbox count is 0. Then remove the forced failure.
- **Fail loud**: if the id-selecting `SELECT` returns zero rows, the reclaim fails naming the
  marker — "nothing to delete" and "the write never landed" must not be spelled the same.
- **VC2-violation detector, marker-scoped**: in the same `afterEach`, assert
  `SELECT count(*) FROM audit_logs WHERE tenant_id = <sentinel> AND target_id = <marker>` is 0,
  failing the suite naming VC2. This is read-only, marker-scoped, and depends on no FK — round 3
  found that the `audit_deliveries → audit_outbox` FK this clause previously named was **dropped**
  in migration `20260415143000`, so the earlier "23503" boundary was inoperative and a drained row
  would have passed every stated check. **Do not** assert a bare non-zero sentinel count: the
  sentinel legitimately holds retention-GC heartbeat rows, so that clause would fail every run.
  Red-prove the detector by seeding one marker-scoped `audit_logs` row inside `BEGIN … ROLLBACK`
  and confirming the case reddens naming VC2.
- Run under VC2; record the stop/start.

---

### C4 — The retention pin gets a differential, and its two arms are labelled honestly

- **Query arm** — `detection or audit only`. A `ctx.createTenant()` tenant with an explicit
  retention reads that **specific value** back; a second tenant with a *different* retention reads
  back that different value, so a constant projection fails both ways. The retention-GC clamps to
  a configured minimum, so the stored and effective values can differ; the test asserts the stored
  value and says so. Red-proof: a literal `NULL` projection reddens it. This calibrates the
  instrument; it is not a gate.
- **Decision arm** — `blocked-deferred` under SC5. The only mutation that reddens it for the reason
  claimed is writing a retention onto the sentinel row on the shared live database.
- **Fail loud**: a query returning zero rows fails the case.

**Correction to #806, narrowed**: its claim that the red-proof "needs a write to the shared dev
database" is **wrong for the differential** and **right for the decision arm**. Record both halves.

**Signature**: names the file and case at implementation time; recorded in the deviation log.

---

### C5 — Stale test comments corrected

**Primitive — stated as an executable expression** (round 3: a prose label admitted readings
returning 1, 24 and 142 rows). Start from the claim family below over `src/**/*.test.ts?(x)`,
excluding the outbox-worker and webhook-delivery suites **as a class adjudication** — they describe
the worker's own dead-letter mechanism:

```bash
grep -rnE "dead-letter|dead-letters|dead-lettering|dead-lettered|DEAD-LETTER|without enqueuing|returns WITHOUT|resolves no tenant|no row at all|writes no row|writes neither|never enqueu|not enqueu|no audit row|silently drop|skips? the enqueue|returns early without|tenant_not_found" \
  src --include="*.test.ts" --include="*.test.tsx" \
  | grep -vE "workers/audit-outbox-worker\.test|audit-outbox-dead-letter-unchained|webhook-delivery-durable|audit-outbox-state-machine|audit-delivery-stuck-reaper|audit-bypass-coverage"
```

Record the expression verbatim in the deviation log and re-run it byte-identically for the "after"
pass. **Fail loud**: a *before* pass returning 0 rows is a broken pattern, not a clean tree — that
is where a narrow pattern hides.

**Pre-edit validation, mandatory, with the seed carried here** (round 3: this check was made
mandatory while the set it references lived in no artifact — the one place de-specification lost
something load-bearing). The confirmed-stale seed, derived in round 1 and re-confirmed in round 2:

| Seed site | Shape |
|---|---|
| `src/auth.test.ts` ×2 | "tenant-less emit dead-letters"; "dead-lettering (CR-3)" |
| `src/lib/audit/auth-failure.test.ts` | "dead-letters and writes neither an audit_logs nor an audit_outbox row" |
| `src/lib/auth/session/auth-adapter.test.ts` ×2 | "dead-letters without enqueuing"; "a null here is the dead-letter above" |
| `src/lib/tenant/tenant-management.test.ts` | **partially stale** — see the rule below |

Six sites across five files. The derivation must return every one of them on the base tree. If one
is missing, the narrowing removed a member — stop and widen. This is a seed for decidability, not
the member set: the derivation is still authoritative and its residue is still adjudicated.

**Adjudication rules**:
- A comment asserting a tenant-less emit writes **no row** is stale.
- A comment scoped to the **catch arm** is legitimate — that arm is still log-only, which keeps the
  self-suppression security argument true.
- A comment explicitly framed as historical is legitimate.
- A comment describing a **mock-module artefact** (an unmocked helper throwing into the catch arm)
  is legitimate.
- **Partially stale comments are rewritten clause by clause.** The `tenant-management.test.ts` site
  pairs a false first clause with a **still-true** second one ("the denial never reaches
  `tenant-domain unmapped`") — true now for a new reason, since the row lands under the sentinel and
  `unmapped` groups by tenant. Replacing the whole comment erases a live operational consequence.

**Control class**: `detection or audit only`.

**Acceptance criteria**:
- **Diff criterion**: the derivation's row set before and after differs by exactly the members
  adjudicated stale. Both counts printed.
- Every returned site is adjudicated — stale, legitimate, or legitimate-by-class — class rows one
  per file with a reason.
- **Paired grep for the partially-stale site**: the stale phrasing no longer matches **and** the
  surviving clause's phrasing still does. The second grep is what stops the fix from being a
  deletion.
- **Ordering**: C6 lands first. Its subject case's *name* is itself a member of this derivation, so
  removing it changes the row set — the ordering holds whether C6 renames or deletes.
- **Do not** narrow by adding the corrected wording to an exclusion list.

---

### C6 — The duplicate flusher case is resolved by deletion

The case whose name states the opposite of its body is **deleted**; the correctly-named case
fourteen lines below has the identical mock setup and the same three assertions, so the content is
fully subsumed (verified in rounds 1-3). Repointing it at the catch arm was the alternative and
would have produced a near-duplicate of two *other* cases in the same file.

**Acceptance criteria**: the surviving case still asserts the enqueue tenant is the sentinel and
that the dead-letter logger was not called; the file's case count drops by exactly one. **Do not**
delete the correctly-named case.

---

### C7 — The narrative gate's vacuous-scan floors are proven able to fail

**Already true, and not to be re-specified**: the scan-root overrides exist behind a CI
fixture-mode guard with their own self-test; every existing refusal case asserts exit status; and
the whole-run scan floor is reachable only by one construction — a target whose collected files all
sit under a `__fixtures__` segment, since the walker excludes test files and `__tests__`
directories at collection.

**Signature**: no gate change. Self-test additions, **including the harness fixture-root support
they require** — the harness today writes one fixed subject path into a root created once for the
whole file, so neither case is constructible without a per-case root or a fixture-writing option.
That support is in scope and is named here so it is not discovered mid-implementation.

**Ordering: C14 lands before C7.** C14 rewrites the sink-floor message, and C7's per-refusal
predicate is derived from it. Round 3 executed the collision: written against today's message, the
predicate stops matching after C14 and the retained OR reports **false for a real refusal** — a
fail-open in the harness's own channel. Either land C14 first, or anchor the predicate on the
set-agnostic part of the message.

**Acceptance criteria**:
- **Case A — the target-resolution floor.** An existing-but-**created** empty scan target. A
  non-existent path is the already-covered case, and round 3 showed the two produce byte-identical
  stderr modulo the target name, so the two mutations originally listed redden both cases
  identically. The **discriminating** mutation is narrowing the target-resolution helper to an
  existence check: Case A then falls through to the scan floor while the non-existent case is
  unchanged. Name that mutation and the observation — stderr moves between floors while the exit
  code and the OR both stay put. Do **not** claim that ignoring the resolution result reddens the
  status; it falls through and the exit stays non-zero.
- **Case B — the whole-run scan floor.** Point the scan root at the `__fixtures__` directory
  itself, not its parent, so the case is not order-dependent on a leftover subject file. Red-prove
  over **stderr**, asserting the exit stays non-zero — both floors refuse through the same exit
  path, so "different exit path" is not the discriminator.
- **Split the refusal predicate four ways, and keep the OR.** The gate has four refusal sites, not
  three. Add the four per-refusal predicates and retain the disjunction, so every existing
  assertion is literally unchanged. Round 3 verified this holds across all six constructions
  (`OR ≡ today's boolean`, each predicate true for exactly its own construction). Red-prove each by
  pointing its own construction at the other three and observing them false. **After C14, re-run
  all four constructions and assert the OR still equals today's boolean** — that cross-check is what
  catches the collision above.
- **Allow**: all existing self-test cases pass unchanged; the gate still exits 0 on the real tree.
- **Do not delete the whole-run scan floor.** Annotate it by **reachability**, not shadowing:
  reachable only when every collected file is skipped in-loop (the `__fixtures__` case, pinned by
  Case B); shadowed for every other construction — upstream by target resolution, downstream by the
  catch-clause floor. "Shadowed-by-construction" would sit beside a self-test proving it can fire.
- **Do not relax** the target-resolution floor or the in-loop skip. Change the fixture, not the gate.

---

### C8 — `unallocatablePid()`'s boundary claim is scoped

The contract this was going to "correct" is already stated per path, and the refusal it was going to
restate is unreachable from the Linux branch. Prose half **withdrawn**.

**What remains**: one scoping clause. The kernel's max-pid value is root-writable at runtime and is
read once at module load, so the Linux path's guarantee is "unallocatable **given the value read at
module load**", not "cannot be allocated by the kernel".

**Control class**: `enforceable boundary` scoped to the observed value (Linux); `best-effort
tripwire` (probe path).

**Probe-path coverage**: `blocked-deferred` under SC9, with a grep-able TODO at the function.

**Acceptance criteria**: the existing docblock is byte-identical except for the scoping clause; the
refusal throw is not softened.

---

### C9 — backup-db red-proof count: closed, resolved (no change)

Refuted. `npx vitest run scripts/__tests__/backup-db.test.mjs` → **237 passed**, exactly the figure
`e3f50de5e` claims. The static/runtime gap is `describe`-level `for` loops calling `it()` per
iteration, which a `grep -c` cannot see. Publishing a "correction" to a correct figure would be worse
than the uncorrected state.

---

### C10 — Stale production prose corrected

**Class**: Requirement 2's scope — production code, `docs/operations`, `docs/security`, `infra`,
`scripts`, `prisma`, `docker-compose.yml`. `docs/archive/review/**` is out of class.

**Primitive — stated as an executable expression**, same discipline as C5: the claim family over
those roots, `--include`-filtered for `*.ts,*.tsx,*.mjs,*.conf,*.yml,*.md,*.sql`, excluding
`*.test.*`. Recorded verbatim and re-run byte-identically for the "after" pass.

**Pre-edit validation, mandatory** — C10 lacked this while C5 had it, an asymmetry with no stated
reason. Seed: the derivation must return, on the base tree, the sites in the stale table below. A
*before* pass returning 0 rows is a broken pattern, not a clean tree.

**Stale, by shape** (the sites are derived; these are the shapes, and the seed is the set of files
they were found in across rounds 1-3):
- A comment or config note asserting the emit **dead-letters and writes no row**, or that stdout is
  the only copy — `src/auth.ts` (three sites), `docker-compose.yml`.
- A comment saying binding a tenant is what makes the emit *enqueue* — it now changes attribution,
  not existence — `src/lib/auth/session/auth-adapter.ts`.
- The audit helper's Bucket C reason clause, which still says `/api/mcp/register` relies on tenant
  resolution. The route stays a Bucket C site; only the reason is stale.
- A pointer to a "known-gap note" that no longer exists under that name —
  `infra/fluent-bit/fluent-bit.conf`.
- The `docker-compose.yml` note additionally cites a `file:line` that no longer names what it claims.

**Legitimate — do not rewrite**: the three self-suppression security arguments (they turn on the
catch arm still being log-only, re-verified in all three rounds); the outbox worker's sites; the
webhook-delivery constant; the `docs/security` outbox descriptions.

**Bucket C path citations.** The list contains `src/…` paths that no longer resolve after the
auth-module reorganisation. Derive them: extract every `src/…` token from the Bucket C block and
`test -f` each. Rounds 1-3 all reproduced **seven** misses. **Tie-break rule**: preserve the cited
directory prefix; where the prefix itself moved, disambiguate by which candidate calls an audit
emitter. Round 3 found **two** misses with multiple basename candidates, not one — the prefix rule
resolves the second, the emitter rule resolves the first, and neither alone resolves both. Never
take the first `find` hit. Line numbers are deliberately not frozen here — revision 2 pre-baked them
and got five of seven off by one, twice running; the `test -f` derivation does not need them.

**Control class**: `detection or audit only`.

**Forbidden patterns**: the corrected stale phrasings, plus each non-resolving `src/…` path. Each is
run against its own corrected file before adoption and must not match.

**Acceptance criteria**:
- **Diff criterion**: the row set before and after differs by exactly the members adjudicated stale,
  with both counts printed.
- The protected security sites and the worker sites **still match** afterwards. A derivation
  returning zero means the wrong thing was rewritten.
- Path existence check reports 0 misses; then re-introduce one wrong path and confirm it reports
  exactly 1. A token extraction yielding 0 tokens fails rather than reporting clean.
- Every `file:line` cited in a rewritten comment is opened and confirmed.

---

### C11 — Review-artifact `Open` sections reconciled, in two bounded tiers

**Tier 1 (item-level)**: the files matched by
`grep -lE "^## (Open Decisions|Open questions|Carried-Forward)" docs/archive/review/*.md` (ten at the
base, reproduced in all three rounds), **plus** `audit-dead-letter-durability-review.md`'s
`## Open, with the reason each is open`, which the narrow regex misses and which this chain owns.
**Minus this branch's own two artifacts** (Requirement 3) — they live in the same glob, and a
`## Carried-Forward Plan Findings` heading would self-select into the derivation it defines.

**Tier 2 (heading-level)**: run the widened regex
(`^#{2,3} .*(Open|Unresolved|Deferred|Carried|Follow-?up|Not fixed)`), record the counts, and
disposition the **headings** the narrow regex missed as `in Tier 1` / `deferred with reason`.
Rounds 2 and 3 both measured the delta at **78 headings across 71 files**.

**Budget**: up to **15** delta headings dispositioned in-branch; above that the remainder is
escalated to the user as separate work with the count recorded. Given 78, escalation is the
expected outcome and has its own Go/No-Go row.

**Invariants**: do not trust the heading. Closing an item means **annotating** it with the closing
commit, never deleting it.

**Control class**: `detection or audit only`.

**Acceptance criteria**:
- **Deny**: name one concrete heading only the widened regex finds.
- **Allow**: every narrow-derivation file appears in the widened run.
- **Allow (no deletion)**: diff the dispositioned files; no line removed.
- **Fail loud**: a file with a heading and zero disposition rows means extraction failed.

---

### C12 — `tenant_members` cannot name the sentinel tenant

**Member set** — derived at implementation time from three primitives (Prisma
create/upsert/update calls; raw `INSERT INTO tenant_members`; nested relation writes) and recorded
with counts. Three things the derivation must get right:

- **Use the schema's actual relation field names** for the nested-write pass. Revision 2's spelling
  matched no relation, so its "null result" was a typo, not an absence.
- **Do not double-count the trigger.** Two of the raw inserts are the body of the
  membership-provisioning trigger function and its redefinition, which is already its own member. A
  function body does not execute at migration time, so "historical one-shot, replay is safe" is the
  wrong frame for it.
- **Do not stop at `src/` and `scripts/`.** Round 3's derivation reached
  `e2e/helpers/db.ts` — two raw inserts that neither frozen list in rounds 1-2 contained. Both write
  an E2E tenant id and adjudicate out, but the fact that a derivation found what two curated lists
  missed is the reason Requirement 7 exists.

**The installed trigger is a live writer**, fired `AFTER INSERT ON "users" FOR EACH ROW`.
Adjudication: it cannot target the sentinel — its predicate requires a digest equal to a fixed UUID
— and the constraint covers it regardless. **Its blast radius differs from every other writer**: a
`23514` raised inside an `AFTER INSERT` trigger aborts the parent `users` INSERT, so the symptom is
a failed account creation with no visible link to `tenant_members`.

**Signature**:
```
migration: prisma/migrations/<ts>_forbid_system_tenant_membership/migration.sql
  ALTER TABLE "tenant_members"
    ADD CONSTRAINT "tenant_members_not_system_tenant"
    CHECK ("tenant_id" <> '<SYSTEM_TENANT_ID literal>'::uuid);

scripts/checks/check-sentinel-tenant-literal-parity.mjs        (new)
scripts/__tests__/check-sentinel-tenant-literal-parity.test.mjs (new)
scripts/pre-pr.sh: one queue_step line for the new gate

scripts/tenant-domain.ts: cmdAdd refuses the sentinel AFTER resolution, keyed on the
  resolved tenant.id — NOT inside the shared resolver, and NOT in cmdRemove.
```

**Refusal placement — `cmdAdd` only.** The shared resolver serves two read-only commands, and
refusing there would deny the diagnosis path this contract exists to enable. `cmdRemove` is also
excluded, for a stronger reason: it performs a *soft* revoke and records an audited claim event, and
its own comment names that lifetime as what incident response needs. `cmdAdd` is the only creator of
a sentinel claim — the sign-in JIT path creates its claim as a nested write inside a `tenant.create`
and so always targets a new tenant, and the backfill filters on a column the sentinel row does not
have (both verified in round 3). So refusing `cmdRemove` blocks no creation path and removes the only
audited undo. Refusal messages route operator-supplied text through the existing display-escaping
helper, as the neighbouring refusals do.

**Parity gate — obligation, with the discovery predicate left to implementation.** It reads
`SYSTEM_TENANT_ID` from `src/lib/constants/app.ts` **by AST** (the initializer is an `as const`
assertion, so the read must unwrap it) and asserts it equals the sentinel literal at every site the
gate is responsible for. **Two properties the implementation must satisfy, and which a naive
value-anchored grep does not** (round 3 constructed both failures):

- **A mutated site must be detected, not merely absent.** Grepping `prisma/` for the AST-read
  constant makes a changed literal *drop out of the match set*, so the gate sees fewer occurrences
  and exits 0 — which makes two of the three red-proof clauses unsatisfiable. The gate therefore
  needs an **expected-site set**, not a value search. The house precedent is a manifest naming
  file + anchor per site (`scripts/checks/` already has two manifest-driven gates); a structural SQL
  identification is the alternative, and this tree's recorded rule is that a SQL gate needs a lexer,
  not a regex. Pick one at implementation time and record why.
- **A shape-anchored scan over all UUID literals fails the allow arm** — another sentinel actor id
  appears twice under `prisma/` and would mismatch on the unmodified tree.

**Scan set**: `prisma/` **and** `docs/operations/`. Round 3 established both halves. The `prisma/`
side must include the `tenants`-row INSERT that is the FK target of `audit_logs`/`audit_outbox`, not
only the new `CHECK` — a gate scoped to the `CHECK` alone goes green on a change that leaves no
`tenants` row for the new UUID, at which point every unattributable emit FK-fails into the log-only
catch arm and #806's gap reopens silently. The `docs/operations` side is required because the
operator diagnostic query embeds the literal; drift there returns 0 rows and reads as "no
unattributable events". `docs/archive/review/**` is out of scan set under Requirement 2.

**Adjudicate occurrences by role, not by spelling.** The literal is a low-entropy UUID this tree
reuses: round 3 found five occurrences that are unrelated ids (a team-key entry id and its generated
iOS fixture, two test tenant ids, a test user id). An occurrence is in the gate's scan set only where
the literal denotes the sentinel **tenant**; the rest are recorded as adjudicated-out with the role
each plays. A spelling-keyed derivation would red on all five, and Requirement 8's pressure would
then land on the wrong side.

**Direction of repair**: applied migrations are checksummed, so editing one makes `prisma migrate`
report a modified-after-applied migration on every deployed database. The SQL occurrences are
immutable; **the constant is what must match them**. State this in the gate's refusal message and in
C12's invariants, so the first person to hit a red does not edit an applied migration.

**Wiring.** The gate is added to `scripts/pre-pr.sh` and that line is pinned by an anchored regex in
its own self-test, mirroring the sibling gate whose self-test comments the assertion "the gate's only
execution path". The anchor must reject a commented-out `queue_step`.

**Invariants**:
- **schema-enforced**: no `tenant_members` row may name the sentinel.
- **app-enforced (usability layer, not a second adjudicator)**: `tenant-domain add` refuses.
- **gate-enforced**: the constant equals every in-scan-set occurrence, and the SQL side is immutable.
- The constraint validates against existing rows at `ALTER TABLE`; a failure is the correct outcome.
- **R31**: the migration deletes nothing. A pre-existing sentinel member row stops this contract.

**Control class**: `enforceable boundary` (the CHECK). The `tenant-domain` refusal and the parity
gate are `fail-closed verification gates` above it. There is no third mechanism: a static pattern
cannot see the sentinel reaching a writer, because at every writer it arrives as a variable.

**Forbidden pattern**: `DROP CONSTRAINT "tenant_members_not_system_tenant"`.

**Pre-flight — two statements**:
```sql
SELECT id, user_id, role, created_at FROM tenant_members WHERE tenant_id = <sentinel>;
SELECT claim, created_by, created_at FROM tenant_claims
  WHERE tenant_id = <sentinel> AND revoked_at IS NULL;
```
A claim exists before any member does. A deployment reading 0 members but holding a claim applies the
migration and inherits a permanent sign-in denial for that domain. Non-zero on **either** stops the
contract. Rounds 1 and 3 both measured 0/0 on the dev database; re-run at implementation time.

**Acceptance criteria**:
- **Deny (constraint)**: a direct insert naming the sentinel is rejected with SQLSTATE `23514`.
  PostgreSQL reports the CHECK violation even when an FK on the same row is also violated (verified),
  so no `users` fixture is needed to avoid a `23503` false pass.
- **Allow (constraint)**: the same insert naming a `ctx.createTenant()` tenant succeeds.
- **Allow (highest-traffic writer)**: a case creating a `users` row **and** a `tenant_members` row in
  one transaction under an isolated tenant still completes with both rows present — covering the
  trigger's blast radius and the sign-in upsert sites.
- **Deny/allow (operator tool)**: `add` refuses the sentinel by UUID **and** by slug; `add` with a
  normal UUID succeeds. **Allow, red-proved**: `remove` against a sentinel claim **succeeds** and
  writes its revoke event; reinstating a refusal in `cmdRemove` must redden that case. **Placement
  proof**: reinstating the refusal inside the shared resolver must redden the two read-command cases.
- **Allow (read commands)**: `list` and `history` against the sentinel succeed.
- **Parity gate, three clauses red-proved separately**: change the TS constant; change the `CHECK`
  literal; change the `tenants`-INSERT literal. Each exits non-zero naming both values and every
  mismatching site — which is what the expected-site set above is for. **Allow**: exit 0 on the
  unmodified tree, with the other sentinel-actor literal present and unflagged.
- **Parity gate, fail loud**: a distinct non-zero refusal when the AST yields no declaration, or when
  an expected site is missing from the tree. Assert the **exit code**, not only stderr.
- **Wiring**: the anchored self-test rejects a commented-out `queue_step`; the allow arm is judged by
  `bash scripts/pre-pr.sh`'s exit code.
- **Runtime tie**: the integration arms import `SYSTEM_TENANT_ID` and never spell the literal.
- `npm run db:migrate` applies cleanly; `node scripts/audit-db-grants.mjs` shows no drift.

---

### C13 — `docs/operations` runbook for the C12 pre-flight

**Why**: C12's constraint validates at `ALTER TABLE` on every database it reaches. For any deployment
other than dev, a failure is a migration that fails during rollout with no sanctioned action and no
runbook entry.

**Content — an ordered response**:
1. **Capture**: both pre-flight queries, including the claim row and the member's `role`.
2. **Interpret, per role.** A claim-driven membership is created as MEMBER, tenant audit-log read
   requires OWNER/ADMIN, and no path can promote anyone inside the sentinel — it has no admin to do
   the promoting (verified in round 3). So ADMIN/OWNER means tenant-wide audit read; MEMBER means RLS
   scope on the sentinel plus a misrouted sign-in. A role-independent phrasing over-claims, and the
   operator's severity call depends on it.
3. **Contain**: set the membership's `deactivated_at`. Both membership resolvers filter on it, so
   this removes the read path immediately and destroys no evidence.
4. **State that containment does not unblock the rollout.** The CHECK adjudicates `tenant_id`
   regardless of `deactivated_at`.
5. **No `DELETE` without sign-off**; revoke the claim through `tenant-domain remove`, which C12
   deliberately leaves working.

**Control class**: `detection or audit only`.

**The literal's occurrence set is derived as part of this contract**, and every occurrence is
dispositioned by role (see C12's scan-set and role-adjudication rules) — including the non-doc copies
(test fixtures, the generated iOS fixture) whose class must be stated rather than left as residue.
The `docs/operations` copy is **in** the parity gate's scan set; the earlier "or state it untied" branch
is dropped, because nothing in `scripts/checks/` catches its drift, so that branch had no
instantiation.

**Acceptance criteria**:
- **Both endpoints of the cross-reference are verified by explicit `test -f`.** The docs-path gate
  skips `docs/operations/**` in its source pass and never opens migration SQL (verified), so citing it
  would be a criterion that cannot fail. Red-prove: point one reference at a wrong path, confirm the
  `test -f` check fails **and** that the docs-path gate stays green under the same break.
- **Allow (containment)**: after step 3 the membership resolver returns null for that user **and** the
  row still exists. The second assertion proves the evidence survived.
- **Fail loud**: a *connection* failure of either pre-flight query means **unknown**, not zero.
- **Do not** add `NOT VALID`. Use an RFC 2606 reserved domain in examples.

---

### C14 — The narrative gate's sink set covers the whole class

**Why in-branch**: widening the sink is a constant and a handful of comparisons, it produces zero
violations on the current tree, and the existing fixtures use `metadata`, which stays in the set.
Anti-Deferral rule 7 applies — these are uncovered members of the class #805/#806 closed for
`metadata`.

**The class is derived, not listed.** Rule: a field is **in class** when a caller-supplied narrative
placed in it can reach `audit_logs` **by any path**. Round 3 established that the second half of that
rule matters more than the first — three of revision 3's frozen out-of-class adjudications named a
mechanism that does not hold:

- **`teamId` and `serviceAccountId` are IN class.** The out-of-class reason was "a narrative raises
  `22P02` in the worker insert, so no row reaches `audit_logs`". The first clause is true; the second
  is false. PostgreSQL's `22P02` message **embeds the offending text verbatim**; the worker catches it,
  and once attempts are exhausted its error recorder writes an `audit_logs` row under the same tenant
  whose `metadata.lastError` carries the truncated message. The error sanitizer strips URL params and
  credential patterns, not narratives — the recorder's own docblock says these rows feed the audit log.
  So the narrative lands in the same tenant-readable sink, 8 attempts later. Round 3 executed each link.
- **`userId`'s protection is not what was written.** "A non-UUID actor is dead-lettered before the
  outbox" holds for the two async entry points but **not** for `logAuditInTx`, which enqueues without
  the actor guard. The conclusion survives for a different reason: the worker's own guards reject it and
  hand the error recorder a **constructed constant** message, so no narrative propagates.
- **`tenantId` fails at the app-side enqueue**, not in the worker insert — inside `logAuditAsync`'s
  try (log-only catch, no outbox row) or by aborting the caller's business transaction.
- **`ip` is in class below its column width and not above.** The column is `VarChar(45)` and the payload
  builder passes `ip` through **unsliced** while it slices `userAgent` to its column width. A short
  narrative lands verbatim in a tenant-readable column — real exposure. A long one raises `22001`, which
  (unlike `22P02`) does **not** embed the value, and the original audit event is lost through the
  attempt cycle — a silent loss of the security record. Both regimes are stated, and the asymmetry is
  repaired: **slice `ip` to its column width in the payload builder**, mirroring `userAgent`.

**Currently-derived membership (seed, not truth)**: `metadata`, `targetType`, `targetId`, `userAgent`,
`ip`, `teamId`, `serviceAccountId` — seven. Out: `scope`, `action`, `actorType` (enum-typed both sides),
`userId`, `tenantId`. Re-derive at implementation time against the payload builder and the schema, and
record the adjudication for every field with the mechanism that actually holds.

**Signature**: the sink constant becomes a set, and **every occurrence of the sink name in user-facing
output** follows — the comparisons, the counters, the zero-floor message, the OK summary, the violation
header, **and the remediation guidance block**. That last one is a hard-coded string literal, not a
dereference, so a `grep` for the constant cannot surface it (round 3 found it that way) — and its text
is wrong for every non-`metadata` sink, since neither sanitizer touches them and two of them are
unbounded `text` columns.

**Carry the report channel with the sink.** Each violation record gains the property that matched, the
header names it, and the self-test's detection predicate becomes per-sink. Otherwise a `targetId`
violation is reported as a `metadata` violation, or the harness predicate is loosened to a substring
that cannot tell the sinks apart — the same lossy-channel defect C7 exists to split.

**Per-sink counters and a per-sink floor.** A single aggregate counter cannot satisfy the fail-loud
clause: round 3 red-proved that renaming one sink leaves the aggregate non-zero, so the floor does not
fire and the gate prints OK with the sink silently narrowed. The OK line prints the breakdown so the
allow arm compares per-sink figures. Keep the aggregate total in the summary as well — it is what makes
"the gate is not seeing its sink" legible.

**The shared self-test fixture must carry every sink property.** Round 3 red-proved that a per-sink
floor against today's `metadata`-only anchor refuses on ~17 existing cases, and that the available wrong
fix — a floor over the *sum* — restores them all while voiding the fail-loud clause. Widening the anchor
is required work, is named here, and was verified to work: with an all-sink anchor the gate exits 0 on a
clean fixture and still catches a per-sink violation.

**Add the positional-`metadata`-argument shape to the gate's MISSED list**, naming the worker's error
recorder as the live instance. The object is assembled inside the recorder and passed as a positional
argument the callee names `metadata`, so neither the sink-property anchor nor the catch-bounded taint
walk sees it. The docblock is being updated anyway.

**Control class**: `fail-closed verification gate`, bounded scope. Widening the sink does not widen the
taint walk, and the MISSED list stays.

**Acceptance criteria**:
- **Deny**: one self-test fixture per newly covered field, each red-proved separately and asserted
  CAUGHT with a non-zero exit. One case covering all of them proves none.
- **Deny (report channel)**: a `targetId` fixture reddens the per-sink predicate for `targetId` and
  stays green for `metadata`.
- **Deny (per-sink floor)**: rename each sink in the fixture in turn → a refusal **naming that sink**.
- **Allow**: all sinks present → exit 0; the gate exits 0 on the real tree with the widened per-sink
  breakdown printed, and the figures are recorded as the branch's parity baseline.
- **Allow (existing cases)**: they pass **after the anchor is widened** — that widening is required
  work, not a test weakened to pass, and is listed here so it is not mistaken for one.
- **Fail loud**: the per-sink floor refuses when any one sink is unseen.
- The CAUGHT/PASSES/MISSED docblock is **updated, not trimmed**.
- **Not in scope**: moving the synchronous emit past tenant resolution — SC3.

---

## Scope contract

| ID | Deferred | Worst case | Likelihood | Cost to fix |
|---|---|---|---|---|
| SC1 | **S3** — sentinel rows never purged AND a global-FIFO claim batch | Unbounded sentinel growth degrading audit delivery tenant-wide. **The bound**: every emitter reaching the sentinel is IP-metered and none emits on its refusal arm. Derive the emitter set over `resolveTenantId`'s fallback arms, **not** over any one wrapper — round 2 enumerated one wrapper and missed a second whose own docblock says volume matters. Round 3 measured live sentinel rows on the dev DB, so growth is observable now | Low today given the bound; rises if a future emitter lands outside a metered route (SC6) | The retention half is entangled with an undecided question: the audit-log purge does not renumber the chain sequence, so a default full-range verify reports a false TAMPER |
| SC2 | **S6** — fleet-wide chain verification pushes the sentinel's chain past the per-tenant row cap | A permanently red integrity signal | Reachable only by a configuration change nobody has made | Same root as SC1; fixing SC1 subsumes it |
| SC3 | **S7's a1 half only** — the synchronous audit line emits the *supplied* tenant, the row carries the *resolved* one | A SIEM correlating stdout against `audit_logs` sees two tenants for one event | Every unattributable emit | Changes `logAuditAsync`'s documented "synchronous, before outbox write" ordering — a contract change with its own review |
| SC4 | **§4** — unidentified intermittent test failure | A real defect masked by flake in a suite whose green is the merge gate | 1/3 then 0/4 across seven observed full runs | Bounded. **Obligation**: add a JSON reporter to the Test step **alongside** the default one — a bare `--reporter=json` *replaces* the default, and `pre-pr.sh` extracts its failure count, seed line and context window from the default output, so it would blind all three on exactly the step where the flake surfaces. The two-reporter form with the keyed output-file flag was verified working. Red-prove: a deliberate failing test produces a JSON file naming it **and** leaves the default summary in the retained log. On recurrence, re-run with the logged seed plus `--no-file-parallelism`. **Do not** add retries. **Not to be written up as "resolved" unless reproduced and fixed.** |
| SC5 | Any mutation of the sentinel `tenants` row itself | C4's decision arm cannot be shown able to fail here | Only by deliberate action | Requires a disposable database (VC1) |
| SC6 | Making SC1's bound durable via the existing IP-limiter manifest gate | A future unmetered emitter silently falsifies SC1's deferral | Low near-term | A new class in an existing gate plus fixtures for every current emitter — a set SC1 must re-derive first |
| SC7 | Whether all three `logAuditAsync` twins should exist, and the same for the other duplicated modules | Mock-shape drift across suites asserting overlapping behaviour | Ongoing and already realised — it produced C2 | A tree-wide test-architecture decision |
| SC8 | Mutation-proving the anchor-publisher and retention-GC sentinel sites | The field can be deleted with the suite green. Impact today is nil — those actors have no `users` row, so the fallback returns the sentinel anyway | Low; neither file changed in `e3f50de5e` | One mutation proof per site, against a defect with no live impact |
| SC9 | Exercising `unallocatablePid()`'s probe path | A regression surfaces only on a macOS contributor's machine | Every macOS run of that suite, no Linux run (VC3) | Extracting the function with an injected reader — a signature change C8 declines — plus two red-proofs. Exceeds the 30-minute threshold |

---

## Carried-Forward Plan Findings

Phase 1 exited at round 3 by user decision after the finding character changed: round 3's three
Criticals were all about gate *implementation mechanics*, none invalidated a design decision, and each
arrived with an expert-executed remedy. The items below are the residue — every one is a Phase 2
implementation question that real code settles faster than another plan round. Phase 2 Step 2-1 reads
this section.

- **CF1 — C12's parity-gate discovery predicate (R3 Func F1, Critical).** The contract now states the
  two properties any implementation must satisfy and names two viable mechanisms (manifest / structural
  SQL identification). Which one is chosen is settled by writing it. *Anti-Deferral: acceptable risk.
  Worst case — the gate is written value-anchored and two red-proof clauses cannot be constructed, which
  the C12 acceptance criteria catch at implementation time. Likelihood — low, the failure is now written
  into the contract. Cost — the choice is ~30 minutes of gate code either way.* **What would settle it**:
  writing the gate and constructing the three red-proofs.
- **CF2 — C14's exact per-sink message and counter rendering (R3 Testing F1/F3, Func F3).** The contract
  states every surface that must follow the sink set, including the literal-only remediation block, and
  requires the shared fixture anchor to carry every sink. The exact strings are Phase 2's. *Anti-Deferral:
  acceptable risk. Worst case — a rendering bug prints a set object into an operator-facing message;
  caught by the allow arm, which asserts the printed breakdown. Likelihood — medium, which is why the
  allow arm asserts the rendering rather than only the exit code. Cost — minutes.*
- **CF3 — C7/C14 ordering and the post-C14 OR cross-check (R3 Testing F2).** Stated in C7. *Anti-Deferral:
  acceptable risk. Worst case — the four-way split is written against the pre-C14 message and the OR goes
  false for a real refusal; the cross-check clause is what catches it. Likelihood — high if the ordering
  is ignored, which is why it is stated as an ordering rather than a note. Cost — re-run four
  constructions.*
- **CF4 — `ip`'s slice in the payload builder (R3 Sec F5, Testing F8).** A one-line change with its own
  case, plus the open question round 3 could not ground: whether the client-IP extractor's selected header
  element is attacker-controlled depends on the deployment's proxy contract. *Anti-Deferral: acceptable
  risk pending measurement. Worst case — an over-long attacker-controlled `ip` jams outbox rows through
  their attempt cycle, losing the audit events behind them. Likelihood — unknown until the proxy contract
  is named. Cost — the slice is one line; the proxy question is a separate investigation.* **What would
  settle it**: name the deployment's proxy header handling, or bound at the ingest boundary regardless —
  the latter is the safe default and is what C14 adopts.
- **CF5 — Whether C10's and C5's derivation expressions, as written here, return their seeds on the base
  tree.** Both contracts make this a mandatory pre-edit validation with a fail-loud arm; it is executed at
  implementation time, not now. *Anti-Deferral: acceptable risk. Worst case — a pattern misses a stale site
  and the diff criterion reports clean; the seed check is the guard and it stops the contract. Likelihood —
  moderate for C10, whose scope is the wider one. Cost — running two greps.*
- **CF6 — SC1's emitter set re-derivation over the resolution fallback.** SC1 states the obligation and
  names the failure of deriving over a single wrapper. It is not this branch's work, but the *bound* SC1
  rests on is only as good as that derivation. *Anti-Deferral: out of scope, tracked — SC1/SC6 own it, and
  the TODO marker is `TODO(audit-dead-letter-durability)`.*

---

## Testing strategy

- **Unit**: C1, C2, C5, C6, C7, C8, C12's operator-tool and parity arms, C14.
- **Integration** (under VC2): C3, C4, C12's constraint arms.
- **Gate self-tests**: C7's two cases and the four-way split; C12's parity gate and its wiring assertion;
  C14's per-sink fixtures and predicate. Each run via its own harness AND via `scripts/pre-pr.sh`, judged
  by exit code.
- **Red-proof discipline**: one mutation per clause, each run and **observed**; the failing test **name**
  recorded. Mutations on a scratchpad copy or a committed tree. Where a clause claims a specific failure
  *channel* — exit code vs. stderr vs. a named assertion — the observation must confirm that channel;
  rounds 2 and 3 each found clauses naming the exit code where only stderr moved.
- **Full gate before PR**: `npx vitest run`, `npx next build`, `npm run lint`, `bash scripts/pre-pr.sh`
  — by exit code, never by tailing output.
- **Residue sweep** after any sub-agent run.

## Considerations & constraints

- **The sentinel return value held a second invariant once already** — `resolveTenantId`'s `null` also
  satisfied the outbox worker's UUID check as a side effect, and narrowing the type deleted that guard
  silently while 15,000 tests passed. Before removing or narrowing any value, look for what else it was
  doing.
- **Commit before mutating.**
- **Do not take a finding at face value — including this plan's own.** Across three rounds, execution
  refuted eight of its premises: C7's gap, C8's contradiction, C9's count, SC3's cost, the flat `Pick<>`,
  C3's FK boundary, C14's three out-of-class mechanisms, and C12's parity scan predicate. Every one was
  found by running something.
- **Do not revive the discarded design.** A tenant-less dead-letter table was discarded after two Phase 1
  rounds when round 2's Criticals all landed inside round 1's fixes. It collides with RLS, grants,
  retention and the parity gates — and RLS alone never protected these rows, since the bypass context is
  honoured by both policies. C12 prevents the membership instead.
- **Unclaimed strengths**: the `audit_logs` tenant FK is `ON DELETE RESTRICT`, so the sentinel row cannot
  be deleted out from under its audit rows; and its `ON UPDATE CASCADE` would let an ad-hoc tenant-id
  update cascade a real tenant's rows into the sentinel — which C12's CHECK also blocks.
- **Pre-existing, untouched**: the two membership resolvers differ on the multi-membership case. C12 makes
  the sentinel instance unreachable.
- **zsh**: `--include=*.ts` needs quoting. **Permissions**: `git branch -D` and `rm -rf /tmp/...` are
  denied at the permission layer.

## User operation scenarios

1. **Operator registers an IdP domain against the sentinel by accident.** Before C12 the claim is created,
   the next SSO sign-in upserts a member row into the sentinel, and that user can read every unattributable
   audit row. After C12 the `add` refuses; and if it did not, the member upsert is rejected cleanly. They
   can still `list`, `history` and `remove`, and C13 tells them what a non-zero pre-flight means and in what
   order to act.
2. **Operator investigates a spike of unattributable events.** C10 matters: a reader who follows a stale
   citation lands on unrelated code and concludes the stdout line is the only record.
3. **A future contributor reads the claim-refusal comment before editing it**, is told the emit
   dead-letters, and reasons that a new refusal arm needs no audit consideration. C10 stops that.
4. **A developer adds a new membership write**, unaware of the sentinel. C12 makes their code correct by
   construction.
5. **A developer writes `catch (err) { … targetId: \`FAILED:${err.message}\` }`** — or the same into a short
   `ip`, or into `teamId`. Before C14 the gate is green and the text reaches a tenant-readable row (directly
   for the first two; via the worker's dead-letter record for the third). After C14 it refuses, naming which
   sink fired.

## Go/No-Go Gate

| ID  | Subject | Verification | Status |
|-----|---------|--------------|--------|
| C1  | The two `e3f50de5e` sentinel emits mutation-proved | verifiable-local | pending |
| C2  | `audit.mocked.test.ts` stops misleading | verifiable-local | pending |
| C3  | Integration file writes, reclaims by marker, detects a VC2 violation | verifiable-local (VC2) | pending |
| C4  | Retention differential; arms labelled | verifiable-local / blocked-deferred (decision arm, SC5) | pending |
| C5  | Stale test comments corrected | verifiable-local | pending |
| C6  | Duplicate flusher case deleted | verifiable-local | pending |
| C7  | Both scan floors proven able to fail; four-way split | verifiable-local + CI | pending |
| C8  | `unallocatablePid()` boundary claim scoped | verifiable-local / blocked-deferred (probe path, SC9) | pending |
| C9  | backup-db count | **closed, resolved — no change** | closed |
| C10 | Stale production prose + Bucket C paths corrected | verifiable-local | pending |
| C11 | `Open` sections reconciled, two tiers | verifiable-local | pending |
| C12 | `tenant_members` cannot name the sentinel | verifiable-local + CI (VC2 for constraint arms) | pending |
| C13 | `docs/operations` runbook | verifiable-local | pending |
| C14 | Sink set derived and covered; report channel carried | verifiable-local + CI | pending |

**Decision points — a blank at PR time is a No-Go, not an implicit Go:**

| Decision | Expected | Status |
|---|---|---|
| C12 pre-flight: sentinel `tenant_members` **and** `tenant_claims` | 0 rows on both | pending |
| C12 parity gate: which discovery mechanism (CF1) | chosen, with the reason recorded | pending |
| C11 Tier-2 delta vs. the 15-heading budget | within budget, or escalated with the count recorded | pending |
| C2 RT9: what each of the three twins exists for | recorded, or the redundant suite deleted | pending |
| C14: the sink class re-derived at implementation time | membership recorded with a mechanism per field | pending |
| CF4: the client-IP proxy contract | named, or bounded at the ingest boundary regardless | pending |
| `npx vitest run` | exit 0 | pending |
| `npx next build` | exit 0 | pending |
| `npm run lint` | exit 0 | pending |
| `bash scripts/pre-pr.sh` | exit 0 | pending |
| `npm run db:migrate` (dev DB) | applies cleanly | pending |
| `node scripts/audit-db-grants.mjs` | no manifest drift | pending |
| Narrative-gate parity after C14 | per-sink breakdown recorded, exit 0, asserted **after all branch edits and with no probe fixtures in the tree** (C1's allow arm adds one temporarily) | pending |

---

## Implementation Checklist

Authored by Phase 2 Step 2-1 from its own impact analysis. Distinct from
`## Carried-Forward Plan Findings` above. Phase 3 reads this as the set of files that must
appear in the diff.

### Derivations re-run at implementation time (all reproduce)

| Derivation | Result |
|---|---|
| C1 intersection | grep → 7 sites; `git show --stat e3f50de5e` touches `extension/token/route.ts` + `mcp/register/route.ts`, **not** `audit-anchor-publisher.ts` → **2** |
| C12 Prisma writers | **14** (6 create/upsert + 8 update) |
| C12 raw SQL | **9** — `helpers.ts`, `admin-vault-reset-cross-tenant-sessions.integration.test.ts`, `rls-cross-tenant-seed.sql`, 4 migrations, **`e2e/helpers/db.ts` ×2** (reached by derivation; absent from both curated lists) |
| C12 nested relation writes | **0 to `tenant_members`** — `teams/route.ts:116` is `members:` on `TeamMember`; `members/search/route.ts:79` is a read filter. Both adjudicated out |
| Sentinel literal, non-archive | **8** — in class (denotes the sentinel tenant): `src/lib/constants/app.ts:71`, `prisma/migrations/20260428170853_…/migration.sql:42`, `docs/operations/alerts.md:133`. Out of class by **role**: `validate-token-dpop.test.ts:48` / `mobile-token.test.ts:119` (arbitrary test tenant), `audit-outbox-worker.test.ts:185` (a user id), `generate-team-key-fixture.ts:141` + `ios/PasswdSSOTests/fixtures/team-key-fixture.json:34` (`entryIdV1`) |

### Files to modify

**C1** — `src/app/api/extension/token/route.test.ts`, `src/app/api/mcp/register/route.test.ts`
**C2** — `src/__tests__/audit.mocked.test.ts`
**C3** — `src/__tests__/db-integration/audit-unattributable-tenant.integration.test.ts`, `src/__tests__/db-integration/helpers.ts` (`trackTenant` sentinel guard)
**C4** — same integration file
**C5** — `src/auth.test.ts`, `src/lib/audit/auth-failure.test.ts`, `src/lib/auth/session/auth-adapter.test.ts`, `src/lib/tenant/tenant-management.test.ts` (+ whatever the derivation returns)
**C6** — `src/__tests__/audit-fifo-flusher.test.ts`
**C7** — `scripts/__tests__/check-audit-metadata-narrative.test.mjs`, `scripts/checks/check-audit-metadata-narrative.mjs` (annotation only)
**C8** — `scripts/__tests__/backup-db.test.mjs` (docblock scoping clause + TODO)
**C10** — `src/auth.ts`, `src/lib/auth/session/auth-adapter.ts`, `src/lib/audit/audit.ts` (Bucket C), `docker-compose.yml`, `infra/fluent-bit/fluent-bit.conf` (+ derivation)
**C11** — 11 files under `docs/archive/review/` (Tier 1), this branch's own two excluded
**C12** — new migration; `scripts/checks/check-sentinel-tenant-literal-parity.mjs` (new); `scripts/__tests__/check-sentinel-tenant-literal-parity.test.mjs` (new); `scripts/pre-pr.sh`; `scripts/tenant-domain.ts`; a new integration test
**C13** — `docs/operations/` (new section), the migration's header comment
**C14** — `scripts/checks/check-audit-metadata-narrative.mjs`, `scripts/__tests__/check-audit-metadata-narrative.test.mjs`, `src/lib/audit/audit.ts` (slice `ip`)

### Ordering (contract-stated, not preference)

`C6 → C5` (a deleted test name is a member of C5's derivation) · `C14 → C7` (C14 rewrites the
message C7's per-refusal predicate anchors on; then re-run C7's four constructions and assert the
OR still equals today's boolean).

### Shared utilities that MUST be reused (no reimplementation)

`SYSTEM_TENANT_ID` / `UUID_RE` (`src/lib/constants/app.ts`) · `escapeUnsafeDisplayChars`
(`src/lib/security/unsafe-display-chars.ts`) — for the new `tenant-domain` refusal messages, as
the neighbouring refusals already do · `createTenant` / `trackTenant` / `cleanup`
(`src/__tests__/db-integration/helpers.ts`) · the existing AST helpers under
`scripts/checks/lib/` for the parity gate · `errorLogFields` / `pgErrorCode` · the sibling gate
`scripts/__tests__/check-audit-metadata-narrative.test.mjs:321-327` as the template for the parity
gate's anchored wiring assertion · `USER_AGENT_MAX_LENGTH` (`src/lib/validations/common.server.ts`)
as the precedent for the `ip` slice.

### CI gate parity (Step 2-1 item 7)

15 CI gates extracted. Four are absent from `scripts/pre-pr.sh`; the rest are present under a
different invocation (script path rather than npm-script name) or via `tsc`.

| Gate | Disposition |
|---|---|
| `bash scripts/check-state-mutation-centralization.sh` | **Deferred parity gap** — pre-existing, unrelated to this branch's subject; wiring it is a separate decision about pre-pr's runtime budget. Run locally in Step 2-4 regardless. *Anti-Deferral: worst case — a state-mutation-centralization violation reaches CI and costs one push round; likelihood — low, this branch adds no state-transition code; cost to fix — one `queue_step` line plus whatever runtime it adds, which is a judgement about pre-pr's budget, not about this branch.* |
| `npm run licenses:check:strict` / `:cli:strict` / `:ext:strict` | **Deferred parity gap** — same reasoning, and they cannot fire here: this branch adds no dependency. Run locally in Step 2-4. *Anti-Deferral: worst case — a licence violation reaches CI; likelihood — nil for this diff (no `package.json` dependency change); cost to fix — three `queue_step` lines plus a network-dependent runtime in a script that is otherwise offline.* |

Both entries are copied to the deviation log so Phase 3 reads them.

---

## Phase 2 Implementation Status (as of `ba69628e6`)

Recorded from the tree and the commit log, not from this plan's contract list —
the previous handoff in this chain was written from a Phase 3 list and dropped
members, and that is the failure this section exists to avoid.

| Contract | Status | Commit |
|---|---|---|
| C1 | done | `565b75991` |
| C2 | done | `565b75991` |
| C3 | **NOT DONE** | — |
| C4 | **NOT DONE** | — |
| C5 | done | `fae306d71` |
| C6 | done (deleted, per the revision-3 decision) | `565b75991` |
| C7 | done | `7b7f24ee1` |
| C8 | done (scoping clause + SC9 TODO) | `565b75991` |
| C9 | closed in Phase 1, no code change | — |
| C10 | done | `fae306d71` |
| C11 | done | `1db849558` |
| C12 | **partial** — migration, parity gate, self-test, pre-pr wiring and the `tenant-domain add` refusal all landed; the **integration test arms did not** | `96c071600` |
| C13 | done, and the parity gate extended over `docs/operations` | `ba69628e6` |
| C14 | done, including the `ip` slice (CF4) | `153fba2aa`, `8e8d265b4` |

### What the implementation changed about the plan

Two contracts were larger than their Phase 1 form, both found by running a
derivation rather than by reading:

- **C14's sink class is seven fields, not five.** `teamId` and
  `serviceAccountId` were adjudicated out across two review rounds on the
  reasoning "a narrative raises 22P02, so no row reaches `audit_logs`". The
  first clause is true and the second is false: Postgres embeds the offending
  text in the 22P02 message, the worker catches it, and at max attempts
  `recordError` writes it to `audit_logs.metadata.lastError`. Real-tree figures
  after the widening: 1040 files, 315 catch clauses, 957 sink properties
  (metadata 244, targetType 158, targetId 154, userAgent 54, ip 71, teamId 230,
  serviceAccountId 46), zero violations, exit 0.
- **C10's stale-path half is its own class**, and C10's own primitive cannot
  find it: a citation goes stale when a file moves, whether or not the sentence
  around it says "dead-letter". Deriving over "a `src/…` citation that does not
  resolve" surfaced nine more in `docs/operations` and `docs/security`, both
  already inside C10's declared scope. Four apparent misses are correct as
  written — they are relative to the extension and CLI package roots, and the
  rule is to adjudicate by ROLE, not by spelling.

### Verification already on record

- Every commit: `npx tsc --noEmit` clean, and the test files it touches green.
- C1's deny arm re-proved by the orchestrator independently of the sub-agent:
  deleting the field reddens `POST /api/extension/token > emits
  ANONYMOUS_ACTOR_ID audit row with EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED +
  ip/userAgent`.
- C14's per-sink floor red-proved: renaming `ip` leaves 886 of 957 properties,
  so the old summed floor stayed green while the gate had stopped watching a
  sink; the per-sink floor refuses and names it.
- C7's scan-zero floor red-proved: `if (scanned === 0)` → `if (false)` reddens
  exactly one case, the new one — which is what shows the two new cases are
  anchored on different floors.
- C12's parity gate red-proved on all three clauses separately, **exit codes read
  unpiped** (an earlier reading through `head -6` reported the pipe tail's status,
  which is the R44 trap this branch also fixes elsewhere).
- C12's constraint proved on the live dev database inside `BEGIN … ROLLBACK`:
  the sentinel insert raises `23514 tenant_members_not_system_tenant`, an insert
  under a normal tenant succeeds. Nothing persisted.
- C12 pre-flight on the dev database: **0 rows** for both sentinel
  `tenant_members` and unrevoked `tenant_claims`.
- Migration applied to the dev database (`prisma migrate` timed out at its
  post-apply prompt; the DDL landed and `_prisma_migrations` records it).

## Carried-Forward Plan Findings — Phase 2 residue

CF1-CF6 from Phase 1 are superseded by the implementation except where noted.
CF1 (parity-gate discovery predicate) is **settled**: the gate uses a named
expected-site manifest, for the reason CF1 anticipated — a value-anchored grep
makes a mutated literal drop out of the match set, so the gate exits 0 on the
drift it exists to catch. CF2, CF3 and CF4 are all implemented. CF5's pre-edit
validations both ran and passed. CF6 is unchanged and still belongs to SC1/SC6.

New residue, for the session that picks this up:

- **CF7 — C3 and C4 are not implemented.** These are the contracts that make the
  integration file prove what its docblock claims. *Anti-Deferral: acceptable
  risk, quantified. Worst case — the file still contains three read-only SELECTs
  asserting a docblock that says it proves FK acceptance by writing, which is the
  original defect #806's Phase 3 filed, unfixed. Likelihood — certain, it is
  simply not done. Cost to fix — one integration file plus a `trackTenant`
  sentinel guard in the helpers, under VC2.* **What would settle it**: writing
  them and running `npm run test:integration` with the compose workers stopped.
- **CF8 — C12's integration arms are not implemented.** The constraint is proved
  by a live psql probe (recorded above) but not by a committed test, so nothing
  re-proves it on the next change. *Anti-Deferral: acceptable risk. Worst case —
  the CHECK is dropped or the migration edited and no test reds; the parity gate
  covers the literal's drift but not the constraint's existence. Likelihood — low
  near-term. Cost — one integration case per arm, plus the allow arm for the
  highest-traffic writer (a `users` row and a `tenant_members` row created in one
  transaction under an isolated tenant).*
- **CF9 — Step 2-4 and Step 2-5 have not run.** No full `npx vitest run`, no
  `npx next build`, no `npm run lint`, no `bash scripts/pre-pr.sh`, and no
  self-R-check sub-agent pass. Each commit ran a targeted subset only.
  *Anti-Deferral: this is not a deferral, it is unfinished work — the branch is
  not merge-ready until all four pass.*
- **CF10 — the CI parity gaps are recorded but unwired.** Four CI gates are
  absent from `scripts/pre-pr.sh`
  (`check-state-mutation-centralization.sh`, three `licenses:check:*:strict`).
  Neither can fire on this diff — it adds no state-transition code and no
  dependency — but both must be run locally in Step 2-4. *Anti-Deferral entry as
  recorded in the Implementation Checklist above.*
