# Plan Review: audit-sentinel-verification-gaps

Date: 2026-08-31
Review rounds: 3 (Phase 1 closed at round 3 by user decision — see "Phase 1 exit")

Rounds 2 and 3 are recorded at the end of this file. Round 1 follows immediately.

---

# Round 1

## Changes from Previous Round

Initial review. Plan written from a re-derivation of the #806 handoff's classes
rather than from its lists; three expert agents (Functionality, Security, Testing)
reviewed it in parallel, each verifying claims by execution against the tree at
`e3f50de5e`.

Local LLM pre-screening (`pre-review.sh plan`, gpt-oss:120b): **No issues found.**

## What the round established, before the findings

Three results reframe the branch and are recorded first because they change what
the rest means.

1. **Requirement 1 is already satisfied for the #806 sentinel branch.** Testing
   re-derived the `logAuditAsync` suite set with
   `grep -rln 'describe("logAuditAsync"' src --include="*.test.ts"` and found
   **three** suites, not two. `src/lib/audit/audit.test.ts:350,366,382,532` and
   `src/__tests__/audit-fifo-flusher.test.ts:188-199` both already assert the
   sentinel resolution on both arms — `:188-199` is verbatim C2's proposed
   acceptance criterion. C2 is therefore not closing a verification gap; it is
   repairing a third, misleading suite.
2. **C12 is aimed at the right object.** Security re-derived the read side
   independently rather than accepting the plan's premise: 13 files read
   `audit_logs`, and all reach their tenant through one of three resolvers, every
   one keyed on `tenant_members` (`src/lib/auth/access/tenant-auth.ts:76-83`,
   `src/lib/tenant-context.ts:8-19`, and the team resolver). The RLS policies gate
   on `current_setting('app.tenant_id')`, set only from those resolvers
   (`src/lib/tenant-rls.ts:52-55`). Membership genuinely is the only gate. The fail
   direction is also correct and is not a sign-in DoS:
   `src/lib/auth/session/auth-adapter.ts:329-352` creates the `users` row and the
   `tenant_members` row in one `withBypassRls` transaction, so a `23514` rolls both
   back and cannot leave an orphan `users.tenant_id = <sentinel>`.
3. **C10's three "legitimate — do not rewrite" adjudications are correct**, verified
   by two experts independently: `logAuditAsync`'s catch arm
   (`src/lib/audit/audit.ts:343-348`) and `logAuditBulkAsync`'s (`:420-427`) are
   still `deadLetterLogger.warn`-only, so a `jsonb` 22P02 raised inside
   `enqueueAudit` still yields no durable row and the self-suppression argument at
   `unsafe-display-chars.ts:81`, `tenant-claim.ts:163` and `auth-failure.ts:173`
   stands.

## Findings

Merged across the three experts. Where more than one expert filed the same root
cause, the severity floor is raised per "Perspective Convergence as a Severity
Signal" and every perspective is named.

### R1-01 — Critical — C7 specifies unbuildable work over an existing mechanism, and its acceptance criterion cannot redden

Filed by **Functionality (F2, F3)**, **Security (F2)**, **Testing (F1)** — three-way
convergence, and the only Critical of the round.

Two independent defects at one site.

*(a) The signature change C7 specifies already exists.*
`scripts/checks/check-audit-metadata-narrative.mjs:81-83` reads
`AUDIT_METADATA_NARRATIVE_ROOT`, `:107-112` reads `AUDIT_METADATA_NARRATIVE_DIRS`,
and `:89-103` gates both behind a CI env-pollution refusal requiring
`AUDIT_METADATA_NARRATIVE_FIXTURE_MODE=1` — with its own self-test at
`scripts/__tests__/check-audit-metadata-narrative.test.mjs:305-319`. The self-test
harness already sets all three (`:73-79`). An implementer following C7 literally
adds a *second* override path that does not pass through the `HAS_OVERRIDE` guard —
which is exactly what that guard exists to prevent, and a violation of the plan's
own Requirement 7.

*(b) "point `SEARCH_DIRS` at an empty directory" cannot reach `scanned === 0`.*
`unresolvedTargets(SEARCH_DIRS, REPO_ROOT)` runs at gate `:315-323`, before the
loop, and `scripts/checks/lib/ast-project.mjs:187-189` treats any target
contributing zero source files as unresolved. Security executed all three
candidate constructions:

| construction | result |
|---|---|
| `DIRS=src`, `src/` empty | `scan target(s) resolved to no source file: src`, exit 1 |
| `DIRS=src`, `src/` holds only `only.test.ts` | same refusal, exit 1 |
| `DIRS=src`, `src/` holds only `__fixtures__/a.ts` | `scanned 0 source files under src`, exit 1 |

Only the third reaches the floor: `walkSourceFiles` already excludes `*.test.*` and
`__tests__/` at collection time (`ast-project.mjs:55-59`, `:114-116`), so the gate's
in-loop skip (`:333-339`) can only skip `__fixtures__` files. C7's acceptance
criterion — "reddens when `if (scanned === 0)` is changed to `if (false)`" — is
unsatisfiable for the construction C7 prescribes.

The harness makes the wrong arm look right: `test.mjs:89` computes
`refused: /recognised 0|scanned 0|resolved to no source file/.test(stderr)` — three
distinct refusals ORed into one boolean. A case written against an empty directory
passes today **and stays green** under the `if (false)` mutation, satisfied by the
neighbouring `unresolvedTargets` arm. That is R44's lossy channel one rung above
the exit code.

*(c) C7's R44 premise is already-satisfied state.* Testing enumerated the self-test's
refusal cases: `:179`, `:279`, `:292`, `:299`, `:317` all assert `status`, and `:275`
carries the comment "The exit status is the ONLY channel queue_step reads." Zero
cases read stderr alone. The three stderr-only cases #806 found were in a different
gate's self-test.

*(d) C7's forbidden pattern matches correct code and its own fix.* The literal
`refused: /recognised 0|scanned 0` exists at `test.mjs:89` in a helper that also
returns `status` and whose every consumer asserts it. The pattern cannot express
"without an accompanying exit-code assertion" and would flag the helper the new case
must itself use — `feedback_forbidden_pattern_must_not_match_its_fix`.

**Impact.** The plan's highest-value new-gate contract, in a branch whose whole
subject is verification gaps, specifies a test that provably cannot fail for the
reason it names — the exact shape #806 existed to remove, reintroduced by its remedy.

**Disposition: fixed in the plan.** C7 rewritten — see the revised contract.

---

### R1-02 — Major — C1's member set is 2 of 7, its diagnosis is wrong, and its forbidden pattern bans the correct fix

Filed by **Functionality (F1)**, **Testing (F2, F11)**, **Security (A1)**.

*Member set.* C1's own stated primitive,
`grep -rn "tenantId: SYSTEM_TENANT_ID" src --include="*.ts" --include="*.tsx" | grep -v "\.test\."`,
returns **seven** sites: the two pre-auth routes plus
`src/workers/audit-anchor-publisher.ts:118, :197, :232, :360, :449`. The five are
excluded only by the plan's *second* command's hand-written `grep -vE ".../workers/"`
— an enumeration-by-exclusion the plan's own Technical Approach argues against, and
which the C7 gate's docblock (`:118-127`) explicitly rejects. The recorded "null
delta" is an artifact of that filter. `src/workers/retention-gc-worker/sweep.ts:752`
passes the sentinel *positionally* (`emitFn(tx, SYSTEM_TENANT_ID, {...})`) and the
symbol grep misses it entirely. `src/workers/audit-anchor-publisher.test.ts` contains
no `SYSTEM_TENANT_ID` reference, so those five are in the same vacuity state.

*Diagnosis.* C1 blames `expect.objectContaining`. Testing proved by execution that
the matcher is not the cause: `objectContaining` ignores *extra* keys but **requires**
every key it lists. The vacuity is that `tenantId` is not listed.

| probe case | result |
|---|---|
| `objectContaining` **listing** `tenantId`, field deleted | **reddens** |
| `objectContaining` **listing** `tenantId`, field present | passes |
| `objectContaining` **not** listing it, field deleted | passes — the actual vacuity |
| exact-shape `toHaveBeenCalledWith({...})`, one unrelated field added | throws — **brittle** |

C1's forbidden pattern `expect\.objectContaining\([^)]*SYSTEM_TENANT_ID` therefore
matches the minimal correct fix, and the contract then mandates the brittle
alternative. (Security adds that `[^)]*` also cannot match a nested-call form, so the
pattern is wrong in both directions.)

**Disposition: fixed in the plan.** C1's class restated as the *intersection* with
`e3f50de5e`'s diff, the five worker sites adjudicated explicitly rather than filtered
out and carried forward as C13, the forbidden pattern retargeted at the vacuous
shape, and an allow arm added.

---

### R1-03 — Major — C2 names the wrong blocker and the wrong missing mock member

Filed by **Testing (F3, F4, F5)**, corroborated by **Functionality (R16)** and
**Security (R19)**.

*Wrong blocker.* C2 claims "`withBypassRls` therefore throws a `TypeError` inside
`resolveTenantId`, and **every** no-`tenantId` case lands in the catch arm."
`assertEnqueueableUserId` runs first (`src/lib/audit/audit.ts:333-341`). Testing
enumerated all nine `logAuditAsync` calls in `src/__tests__/audit.mocked.test.ts`:
seven short-circuit at `assertEnqueueableUserId` on `userId: "user-1"`, two supply an
explicit `tenantId` and early-return. `withBypassRls` is reached **zero** times; the
missing-`$transaction` `TypeError` is real but currently unobservable.

*Wrong missing member.* C2's signature adds `$transaction`. Testing executed exactly
that signature and the case still landed in the catch arm with
`{ reason: "logAuditAsync_failed", error: { name: "TypeError" } }`, because
`src/lib/tenant-rls.ts:75-81` calls `tx.$executeRaw` three times. Adding
`$executeRaw: vi.fn().mockResolvedValue(0)` made it pass. The member set the code
calls on the mocked client is `$transaction`, `$executeRaw`, `user.findUnique`,
`team.findUnique`.

*Third twin.* See "What the round established" item 1. C2's acceptance criterion is
already met verbatim at `audit-fifo-flusher.test.ts:188-199`, so C2 as written adds a
third copy of an assertion that already passes twice.

*Secondary.* `audit.mocked.test.ts:194` is named "calls enqueueAudit for normal UUID
userId flow" but supplies an explicit `tenantId`, so it never exercises the resolution
flow its name claims — the same name/body defect C6 raises, inside the file C2 rewrites.

*RT1 has no mechanism.* `vi.mock`'s factory return type is not parameterised by the
mocked module (`vitest/dist/index.d.ts:429`), so nothing checks the mock against
`PrismaClient`. Annotating the 4-key mock as `PrismaClient` fails on ~60 missing model
delegates; a `Pick<>` annotation works but catches only signature drift on those four,
not a newly called fifth member — which is the failure that actually occurred.

**Disposition: fixed in the plan.** C2 re-scoped from "close a verification gap" to
"repair or retire a misleading third twin", member set stated, RT1 replaced with the
`Pick<>` construct plus an explicit statement of its residual gap.

---

### R1-04 — Major — C3's cleanup cannot reclaim what it writes, and the stated alternative is destructive

Filed by **Functionality (F6)**, **Testing (F7)** — and both routed it [Adjacent] to
Security as a shared-database integrity risk.

`ctx.cleanup()` sweeps only tenants `createTenant()`/`trackTenant()` handed out
(`src/__tests__/db-integration/helpers.ts:391`, `:428`, `:627-629`), and
`deleteTestData` is tenant-scoped (`WHERE tenant_id = $1::uuid`). `SYSTEM_TENANT_ID`
is in neither set, so cleanup is a no-op for the row C3 writes — on the success path
and the failure path alike.

Registering it is worse: `trackTenant(SYSTEM_TENANT_ID)` would make `deleteTestData`
run its terminal `DELETE FROM tenants WHERE id = $1::uuid` against the sentinel row on
the shared live dev database, destroying the row every unattributable audit write in
the deployment depends on.

"Deleted in the same test" fails RT11 by construction — a trailing statement does not
run when an assertion above it throws — and is not a one-liner:
`prisma/migrations/20260412100000_add_audit_outbox/migration.sql:61-71` installs
`audit_outbox_before_delete_guard()`, which blocks deleting `PENDING`/`PROCESSING`
rows. `helpers.ts:466-476` documents the required UPDATE-to-`FAILED`-then-DELETE dance.

The leak is not recoverable: a leaked `PENDING` row under the sentinel is drained into
`audit_logs` the moment `docker compose start audit-outbox-worker` runs at the end of
VC2 — seeding the SC1 growth problem the plan defers.

**Disposition: fixed in the plan.** C3 gains an `afterEach` reclaim scoped by recorded
row id, an allow arm, an executed RT11 proof, and a `trackTenant` sentinel guard.

---

### R1-05 — Major — C10's and C5's acceptance criteria are unsatisfiable against their own derivations

Filed by **Functionality (F7)**, **Testing (F8)**.

C10's derivation run verbatim returns **246 matches across ~90 files** (177 in
`docs/archive/`, 23 `src/lib/`, 17 `src/workers/`, 8 `docs/operations/`, 6
`docs/security/`, 4 `scripts/`, 4 `docker-compose.yml`, 3 `src/auth.ts`, 2
`infra/fluent-bit/`, 1 each `src/app/` and a migration). The adjudication table covers
~25. Requirement 2 is stated over the whole tree; the contract covers a tenth of it.
At least one unadjudicated member is squarely in the stale class:
`docs/archive/review/container-log-rotation-caps-code-review.md:54-55` —
"`logAuditBulkAsync` return without enqueuing when the tenant cannot be resolved, so
the stdout `audit-dead-letter` line is the sole record."

C5 has the same shape at a smaller scale: the grep returns **52 rows** against a table
of 11. The other 41 are outbox-worker and webhook-delivery dead-letter comments —
almost certainly all legitimate, but "almost certainly" is not the criterion.
Inconsistently, C10 *does* adjudicate `src/workers/audit-outbox-worker.ts` as a class
and C5 does not.

Testing re-derived C5 with a wider claim family
(`never enqueu|not enqueu|no audit row|silently drop|is dropped|skips? the enqueue|returns early without|tenant_not_found`)
and confirmed the plan's table **misses no stale member** — the three additional
candidates all adjudicate legitimate. So C5's enumeration is right and its criterion
is not.

**Disposition: fixed in the plan.** Requirement 2 scoped to prose a reader acts on
(production code, operational docs, infra config), `docs/archive/review/**` moved out
of class with the reason C11 already states, and both criteria restated as
element-wise list comparisons over a narrowed derivation that is validated
*before* editing.

---

### R1-06 — Major — C11's criterion is unbounded: 71 files against a scope of 10

Filed by **Functionality (F11)**, **Testing (F10)**.

Both experts reproduced the narrow derivation's ten files byte-for-byte. The widened
regex returns **71 files**, and the criterion reads "All ten files (plus any surfaced
by the widened regex)". That is 71 artifacts, each with multiple items, each requiring
a code check, in a branch whose subject is test quality — with no triage rule and no
bound. The gate will be marked from the ten-file reading either way, so the criterion
silently degrades and the widened form is carried as unearned rigour.

The widening is genuinely valuable — the narrow regex is `^## ` only, so a
`### Open questions` subsection is invisible to it — and it surfaces the plan's own
primary source, `docs/archive/review/audit-dead-letter-durability-review.md:479`
(`## Open, with the reason each is open`), which the narrow regex misses and the
known-answer seed does not cover.

**Disposition: fixed in the plan.** Two tiers: item-level disposition for the ten
narrow-derivation files plus that one, and heading-level disposition of the widened
delta, with an escalation rule if the delta exceeds budget.

---

### R1-07 — Major — SC3's cost justification for the S7 half is refuted by execution

Filed by **Security (F3)**, routed [Adjacent] by **Testing**.

SC3 deferred widening the narrative gate's sink set on the stated cost: "rewriting
`check-audit-metadata-narrative.mjs`'s CAUGHT/PASSES/MISSED declaration and its 22
self-tests … design changes, not repairs." Security measured it. On a throwaway copy
with only `SINK_PROPERTY` replaced by a four-member set:

```
baseline:  scanned 1040 files, 315 catch clauses, 244 metadata properties — OK, exit 0
widened:   scanned 1040 files, 315 catch clauses, 610 widened properties  — OK, exit 0
```

So: the rule change is a constant and two comparisons, not a rewrite; the widened sink
set produces **zero** violations on the current tree; and the 22 self-tests all use
`metadata` fixtures, which stays in the set, so none needs rewriting. The CSV export
path — the one place `userAgent` leaves the app as a file — already formula-guards
through `escapeCsvValue` (`src/lib/audit/audit-csv.ts:13`), so the injection axis is
closed too.

Anti-Deferral rule 7 defaults an uncovered member of a security-boundary class to a
same-branch fix. The plan overrode that default with a cost claim that does not survive
execution — `feedback_no_false_technical_justification`.

Security is explicit that the **a1 half** (moving the synchronous emit past
`resolveTenantId`) is a genuine contract change to `logAuditAsync`'s documented
"synchronous, before outbox write" ordering, and its deferral is sound.

**Disposition: fixed in the plan, with user decision.** SC3 split. The S7 half becomes
C14 and lands in this branch (user decision, 2026-08-31, taken after being shown the
measurement). The a1 half stays deferred as SC3, with the measured numbers recorded.

---

### R1-08 — Major — C12's CHECK binds a literal while the invariant is stated over a symbol, with nothing tying them

Filed by **Security (F1)**, **Functionality (F16)**, **Testing (Adjacent)** — three-way
convergence lifts this above Functionality's original Minor.

Requirement 4 and C12's invariant are stated over `SYSTEM_TENANT_ID`
(`src/lib/constants/app.ts:71`); the constraint names a literal. Security grepped the
literal across the tree: it appears in the constant, in
`prisma/migrations/20260428170853_.../migration.sql:35`, in
`scripts/generate-team-key-fixture.ts`, three test files and four docs — and in **zero**
files under `scripts/checks/`. No gate compares the TS constant to any SQL occurrence.
R51: the decision is bound to a value copied at authoring time, not to the object the
application uses.

This is not hypothetical drift in this branch. C3's own red-proof instructs the
implementer to change `SYSTEM_TENANT_ID` in `src/lib/constants/app.ts`. C12's forbidden
patterns guard the loud removal (`DROP CONSTRAINT`) and nothing guards the silent one.
The tree already grows sentinels (`SENTINEL_ACTOR_IDS`, `constants/app.ts:74-77`).

Failure direction is fail-open: the constraint keeps protecting a value nothing writes
while every reviewer and every doc believes it is enforced, and a re-run of C12's own
acceptance criteria — all of which test the literal — reports clean.

**Disposition: fixed in the plan.** C12 gains a parity gate,
`scripts/checks/check-sentinel-tenant-literal-parity.mjs`, reading the constant by AST
(R46, not regex) with both arms red-proved separately and a refusal when it can examine
nothing.

---

### R1-09 — Major — C12's operator-tool refusal is placed in a helper four commands share, two of them read-only

Filed by **Functionality (F5)**.

C12's Invariant scopes the refusal to `tenant-domain add|remove`; its Signature places
it in `resolveTenantRef` (`scripts/tenant-domain.ts:192`), which has four call sites:
`cmdList` (`:264`, read-only), `cmdAdd` (`:894`), `cmdRemove` (`:1209`), `cmdHistory`
(`:1414`, read-only). Refusing inside the helper denies
`tenant-domain list --tenant <sentinel>` and `history --tenant <sentinel>`, with no
allow side named.

That is the diagnosis path the plan's own User operation scenario 1 describes — an
operator who has accidentally registered a claim against the sentinel — and the
helper's docblock (`:188-191`) already records read-side resolution of an unusable ref
as a deliberate operator need. The remedy would remove the diagnosis it exists to
enable.

**Disposition: fixed in the plan.** Refusal moved into `cmdAdd`/`cmdRemove` at their
post-resolution point, adjudicating on the resolved `tenant.id` rather than the ref
string (R51), with the two read commands named as the allow arm and a third red-proof
clause that proves the *placement*, not just the behaviour.

---

### R1-10 — Major — C9's premise is false; the count reconciles and #806's figure is correct

Filed by **Testing (F6)**, independently confirmed by **Functionality**.

```
$ npx vitest run scripts/__tests__/backup-db.test.mjs
 Test Files  1 passed (1)
      Tests  237 passed (237)
```

Exactly #806's figure (3 red + 234 green). The 218/237 gap is dynamic generation:
`grep -cE '^\s*it\('` → 218, `grep -c '\.each'` → 0, and the extra 19 come from
`describe`-level `for` loops calling `it()` per iteration —
`scripts/__tests__/backup-db.test.mjs:1022` (`for (const {re, why, control} of forbidden)`)
and `:1288` (`for (const rel of DOCS)`). The plan reached for a grep where a 52-second
run was the instrument, then wrote an R29 finding against a correct commit message.

As written, C9 would publish a wrong correction into a review artifact
cross-referenced to `e3f50de5e` — worse than the uncorrected state, because it would
then be recorded as verified.

**Disposition: closed, resolved — no change** (user decision, 2026-08-31). Recorded
below under Resolution Status with the reproducing command and the reason 218 ≠ 237,
so a future static count does not re-open it.

---

### R1-11 — Major — C8's premise is refuted by the lines directly above its cited subject, and its surviving criterion is not constructible

Filed by **Functionality (F9, F10)**, **Testing (F9)**.

*Premise.* The contract C8 calls wrong is already stated per path.
`scripts/__tests__/backup-db.test.mjs:61-67`: "Linux gives a value that is
unallocatable **BY CONSTRUCTION**: anything above `pid_max`. Where that file is
unreadable (macOS…), probe downward … and take the first pid that reports ESRCH."
The "no pid could be shown to be absent" throw at `:82-85` is reachable only from the
probe path — the Linux branch returns at `:71`. C8 cites `:68-86`, a range starting one
line below the docblock that resolves the alleged contradiction. C8's proposed
restatement is strictly weaker than what is there.

*Criterion.* `unallocatablePid` is module-private (the file has no `export`) and runs at
module evaluation, `:88`, before any `it()`. Forcing the fall-through requires
intercepting `node:fs` at hoist time in a file with ~30-50 real `readFileSync` calls —
mocking the filesystem for a suite whose subject *is* filesystem behaviour. That is a
restructuring, not the "no signature change" C8 declares.

*Verified sound.* Both experts confirmed `pid_max` = 4194304 on this host and
`process.kill(4194305, 0)` → `ESRCH`; the kernel allocates in `[1, pid_max-1]`. Testing
adds one nuance C8's `enforceable boundary` label overstates: `pid_max` is root-writable
at runtime (`sysctl kernel.pid_max`) and `GONE_PID` is computed once at `:88` and reused
across a 52-second run, so the guarantee is "unallocatable given the `pid_max` read at
module load", not "cannot be allocated by the kernel".

**Disposition: prose half withdrawn, test half re-scoped** (user decision, 2026-08-31).
C8 keeps only the scoping correction to the `enforceable boundary` claim; the probe path
is recorded `blocked-deferred` with its cost.

---

### R1-12 — Major — SC4 and SC5 carry no Anti-Deferral triple, and SC1-SC3 each omit an axis

Filed by **Functionality (F12)**, with the SC4 remedy sharpened by **Testing (F13)**.

SC5 states only an environmental fact and is a constraint restated as a scope row —
which hides that nothing is being traded away. SC4 states "costs nothing", the
prohibited bare-negligible shape: no worst case (an intermittent failure in a
15,043-test suite is by construction a test that can be green when the code is wrong),
no likelihood (1 of 3 then 0 of 4 *is* a likelihood figure), no cost to fix. SC1 and
SC3 state worst case and cost but no likelihood; SC2 states likelihood but no cost.

Testing adds that SC4's obligation is weaker than tooling that already exists:
`scripts/pre-pr.sh:150` retains failed-step logs (landed in `d7a8e6bbe`), `:145` already
greps for `Running tests with seed|--sequence\.seed`, and `:127`/`:162` anchor on
vitest's `Failed Tests N` summary. The previous session's failure to identify the flake
was a process gap, not a tooling one — so the obligation can be made automatic rather
than attention-dependent.

**Disposition: fixed in the plan.** All five rows carry the triple; SC4's obligation
becomes a JSON reporter on the Test step, red-proved on a deliberately failing run.

---

### R1-13 — Minor — the `tenant_members` writer set omits an installed database trigger

Filed by **Security (F4)**.

`ensure_tenant_owner_membership_after_user_insert()` is a `plpgsql` function that
`INSERT`s into `tenant_members`, installed as
`trg_after_insert_users_tenant_owner_membership` — `AFTER INSERT ON "users" FOR EACH ROW`
(`prisma/migrations/20260227050000_tenant_id_trigger_defaults_phase8/migration.sql:196-229`,
redefined at `20260321110000_convert_id_columns_to_uuid_type/migration.sql:719-737`). It
is a live writer on every `users` insert and is absent from C12's enumeration, which
classifies the raw-SQL hits as historical one-shots.

Security checked rather than assumed: the trigger's predicate is
`NEW.tenant_id = md5(NEW.id::text)::uuid`, so reaching it with the sentinel requires an
md5 digest equal to a fixed UUID — structurally unreachable, and the constraint would
adjudicate it regardless. What is missed is the *failure mode*: a `23514` raised inside
an `AFTER INSERT` trigger aborts the **parent `users` INSERT**, so the observable symptom
would be a failed account creation with no obvious connection to `tenant_members`. R52
asks that every derived writer be checked before the control's reach is extended; this
one was not enumerated, so it was not checked.

**Disposition: fixed in the plan.** Added to C12's derivation table with its
adjudication and blast radius.

---

### R1-14 — Minor — SC1's bounding claim names 2 of at least 10 emitters

Filed by **Security (F8)**.

SC1 states the bound as "the two pre-auth routes' per-IP limiters". Security re-derived
the emitter set over the *defining primitive* — any `logAuditAsync` call reaching
`resolveTenantId`'s `?? SYSTEM_TENANT_ID` arms (`src/lib/audit/audit.ts:210,220,228`) —
rather than over the two sites that state the sentinel literally.
`emitAuthLoginFailure` (`src/lib/audit/auth-failure.ts:190-214`) resolves no tenant
whenever `args.tenantId` is absent and `userId` falls back to `SYSTEM_ACTOR_ID`, and it
has eight call sites: `src/auth.ts:551,576,595,647,678,697,716` and
`src/lib/auth/session/auth-adapter.ts:374`.

The conclusion survives and improves: all eight are metered.
`src/app/api/auth/[...nextauth]/route.ts:77-105` applies `callbackRateLimiter` per client
IP with `boundUnknownIp: true` to `/api/auth/callback/*`, and `:128-155` applies
`magicLinkIpLimiter` to `/api/auth/signin/{nodemailer,email}`. Both pre-auth routes are
metered too, and neither emits on its refusal arm. So sentinel growth is IP-bounded
across the whole set. The defect is that the stated basis covers 2 of 10, so a reader
cannot check it and a future emitter outside a limited route would silently falsify the
deferral with nothing to catch it.

**Disposition: fixed in the plan.** SC1 carries the derived set and its bound; making it
durable via `check-bound-unknown-ip.mjs` is recorded as SC6 rather than absorbed
(`project_bound_unknown_ip_class`).

---

### R1-15 — Minor — C12's second forbidden pattern cannot match the reachable shape

Filed by **Security (F7)**.

"`SYSTEM_TENANT_ID` appearing in a `tenantMember` write argument" names no detection
mechanism, and a grep for that spelling returns nothing today and would return nothing
in the defect case either: at every one of the six writers the tenant id arrives as a
variable — `target.id` (`src/auth.ts:323`), `lookup.id` (`:333`), `target.id` (`:493`),
`tenant.id` (`auth-adapter.ts:347-349`), the SCIM token's tenant, the sync config's
tenant. R49: an unenforceable pattern in a `Forbidden patterns` block reads as a second
layer during review.

**Disposition: fixed in the plan.** Pattern deleted, and C12's control-class paragraph
states that the constraint is the only mechanism for this shape because the sentinel
reaches every writer as a variable.

---

### R1-16 — Minor — R29: five citations in the plan do not resolve to what they name

Filed by **Security (F5)**, **Testing (F15)**, **Functionality (F15)**.

| plan cite | actual |
|---|---|
| `src/lib/account-lockout.ts:455` (C11 seed) | `src/lib/auth/policy/account-lockout.ts:455` |
| `scripts/audit-chain-verify-worker.ts:255` (SC2) | `MAX_ROWS_PER_TENANT` at `:61-63`; `CHAIN_VERIFY_FAILED` at `:7,262,286,350`; `:255` is `prisma.tenant.findMany` |
| `infra/fluent-bit/fluent-bit.conf:44` (C10) | the pointer sentence is at `:47`; the prior artifact had `:47` correct — the plan regressed it |
| `src/lib/audit/audit.ts:46-50` (C10) | the two stale paths are at `:36` and `:44`; `:46-50` is the `/api/mcp/register` half only |
| C10 Bucket C: 2 stale paths named | **7** do not resolve — `auth-adapter.ts`, `access-restriction.ts`, `account-lockout.ts`, `delegation.ts`, `team-policy.ts`, `extension-token.ts`, `constants/audit.ts` |

The first is notable: C10 lists `src/lib/auth-adapter.ts` as a forbidden pattern
precisely for not existing since the auth module was reorganised, and C11 then commits
the same defect against the same reorganisation. `src/lib/extension-token.ts` is
genuinely ambiguous — three files share the basename — so it needs reading, not a
mechanical substitution.

**Disposition: fixed in the plan.** All five corrected; C10 gains a derivation step that
extracts every `src/…` token from `audit.ts:32-49` and `test -f` each, with all seven
corrections added to Forbidden patterns.

---

### R1-17 — Minor — C6's rename produces a near-duplicate of the case 14 lines below it

Filed by **Functionality (F14)**.

`src/__tests__/audit-fifo-flusher.test.ts:188` and `:202` share the identical mock setup,
actor UUIDs differing only in the last four hex digits, and the same three assertions.
`:202` is already correctly named. Renaming `:188` to state what its body asserts makes
it a near-verbatim duplicate — coverage appearance in a different form.

**Disposition: fixed in the plan.** C6 adjudicates the pair rather than renaming blind;
`:202` is protected as the correctly-named one.

---

### R1-18 — Minor — C4's red-proof mutates the test's own query, not its subject

Filed by **Testing (F12)**, with **Security (A3)** adding the retention clamp.

C4's differential is sound, but both stated mutations act on the test's `$queryRaw`
template. What C4's first arm pins is a *data decision* — that the sentinel's
`audit_log_retention_days IS NULL` — and the only mutation that reddens it for the
reason claimed is setting a retention on the sentinel row, which SC5 forbids. So the
plan's correction of #806's claim is right for the differential and **wrong for the
decision arm**: #806's original statement was accurate about the arm it was made
against. Correcting it as written would repeat C9's error.

Security adds that `src/workers/retention-gc-worker/registry.ts:485-494` clamps to
`max(retention, AUDIT_LOG_RETENTION_MIN)`, so the second arm's asserted and effective
values can differ; the assertion must name the specific value it set, not
`not.toBeNull()`.

**Disposition: fixed in the plan.** The two arms separated and labelled; the decision arm
recorded `blocked-deferred` with its cost; the correction of #806 narrowed to the half
that is actually wrong.

---

### R1-19 — Minor — C5's `tenant-management.test.ts:244` adjudication drops a clause that is still true

Filed by **Testing (F16)**.

The full comment (`:242-246`) has two clauses. The first ("logAuditAsync dead-letters")
is stale. The second ("the denial never reaches `tenant-domain unmapped`") is **still
true for a different reason**: the row lands under `SYSTEM_TENANT_ID`, and
`tenant-domain unmapped` groups by `tenant_id`, so the denial shows under `__system__`
rather than under the refused tenant — documented at
`src/lib/tenant/tenant-management.ts:364` and `src/lib/audit/auth-failure.ts:200-207`.
A one-line "stale" label invites replacing the whole comment and erasing a live
operational consequence — the failure mode C5 exists to prevent, appearing inside C5's
own table.

Testing also adjudicated the plan's three "to adjudicate" rows: `v1/tags/route.test.ts:38`
and `v1/vault/status/route.test.ts:38` **legitimate** (they describe an unmocked
`tenantAuditBase` throwing into the catch arm, still accurate);
`audit-fifo-flusher.test.ts:267` **legitimate** (already post-#806 and correct).

**Disposition: fixed in the plan.** Row restated as "partially stale", the surviving
clause named, and a paired grep added that must still match `tenant-domain unmapped`
after the rewrite — the clause that stops the fix from being a deletion.

---

### R1-20 — Minor — C13 (new): the five anchor-publisher sentinel sites are in the same vacuity state

Filed by **Functionality (F1)**, **Testing (F11)** — promoted from the C1 member-set
finding because it is a distinct subject with its own scope question.

`src/workers/audit-anchor-publisher.ts:118,197,232,360,449` each state
`tenantId: SYSTEM_TENANT_ID`, and neither `src/workers/audit-anchor-publisher.test.ts`
nor the integration twin names `SYSTEM_TENANT_ID` anywhere. They pre-date `e3f50de5e`
(`git show --stat` does not touch that file), so they are outside "#806's changes" —
but they are members of the class C1 defines, and excluding them by a `grep -v` rather
than by an adjudication is the failure the plan exists to avoid.

**Disposition: recorded as C13, scope-deferred with the triple** — see the revised plan.

---

### R1-21 — Minor — Go/No-Go gate omits the decision points that can stop the branch

Filed by **Functionality (F18)**.

The gate has one row per contract and no row for C12's pre-flight escalation (a
user-in-the-loop decision recorded only inside C12's prose), the per-contract
`verifiable-local`/`verifiable-CI`/`blocked-deferred` classification VC1-VC4 define, or
the four mandatory commands.

**Disposition: fixed in the plan.**

---

## Adjacent Findings

Routed and dispositioned:

- `[Adjacent] Major (Functionality → Security)`: C12's justification rests on
  "/api/tenant/audit-logs scopes by membership", asserted rather than shown.
  **Closed** — Security derived it independently (13 readers, three resolvers, all
  membership-keyed) and the derivation is now recorded in the plan.
- `[Adjacent] Major (Functionality → Security)`: C3's leaked sentinel row would be
  indistinguishable from a genuine unattributable event, corrupting the `alerts.md`
  investigation. **Folded into R1-04**, which is why its remedy is a reclaim scoped by
  recorded row id and never by `tenant_id = <sentinel>`.
- `[Adjacent] Major (Functionality → Testing)`: whether all three twins should exist is
  a test-architecture decision affecting 16 modules
  (`project_duplicate_test_files_two_trees`). **Recorded as SC7** — this branch decides
  only the `logAuditAsync` triple.
- `[Adjacent] Minor (Testing → Functionality)`: C12's `23514` inside
  `withBypassRls`/`withTenantRls` poisons the enclosing interactive transaction
  (`project_prisma_p2002_aborts_interactive_tx`), so the SSO sign-in path at
  `src/auth.ts:323,333,493` must survive it. **Partially closed** — Security verified
  `auth-adapter.ts:329-352` aborts the whole transaction cleanly with no partial state,
  which is the correct behaviour; the `src/auth.ts` upsert sites are added to C12's
  acceptance criteria as an explicit allow-arm check.
- `[Adjacent] Minor (Security → Testing)` ×2 and `[Adjacent] Minor (Security →
  Functionality)` ×1: folded into R1-02 (matcher regex), R1-03 (RT1 mechanism) and
  R1-18 (retention clamp) respectively.
- `[Adjacent] Minor (Functionality → Testing)` ×2: folded into R1-02 and R1-18.

## Quality Warnings

None. No finding was flagged `VAGUE`, `NO-EVIDENCE`, or `UNTESTED-CLAIM`. Every finding
in this round names a `file:line` in the tree, and the ones that assert a mechanism does
or does not work were verified by executing it — three experts independently reported
running probes and confirming `git status --porcelain` clean afterwards (R21).

## Resolution Status

### R1-10 Major C9 backup-db red-proof count — Closed, resolved (no change)
- **Anti-Deferral check**: not a deferral — the finding is withdrawn because its premise
  is false.
- **Justification**: `npx vitest run scripts/__tests__/backup-db.test.mjs` →
  `Tests 237 passed (237)`, matching `e3f50de5e`'s "3 redden + 234 green". The static
  count of 218 came from `grep -cE '^\s*it\('`, which cannot see the `describe`-level
  generators at `scripts/__tests__/backup-db.test.mjs:1022` and `:1288`. Recording a
  "correction" would publish a wrong figure as verified.
- **Carried into the plan** as C9's replacement text so a future static count does not
  re-open it.
- **Orchestrator sign-off**: confirmed by execution, twice, by two independent experts.
  User decision 2026-08-31: record and close.

### R1-11 Major C8 prose half — Withdrawn
- **Anti-Deferral check**: not a deferral — the premise is refuted.
- **Justification**: `scripts/__tests__/backup-db.test.mjs:61-67` already states the
  contract per path, and the throw at `:82-85` is unreachable from the Linux branch
  (return at `:71`). C8's proposed restatement is weaker than what is there. Requirement
  7 applies to a stated contract too.
- **Orchestrator sign-off**: confirmed by two experts; user decision 2026-08-31.

### R1-11 Major C8 probe-path coverage — Blocked-deferred
- **Anti-Deferral check**: acceptable risk, quantified.
- **Justification**:
  - Worst case: the `unallocatablePid` probe loop is unexercised on this host and in CI,
    so a regression in it surfaces only on a macOS contributor's machine, as a
    `backup-db` suite that refuses to load.
  - Likelihood: the loop runs only where `/proc/sys/kernel/pid_max` is unreadable — every
    macOS run of this suite, no Linux run. VC3.
  - Cost to fix: extracting `unallocatablePid` to
    `scripts/__tests__/helpers/unallocatable-pid.mjs` with an injected reader — a signature
    change C8 declared it would not make, plus two red-proofs. Roughly an hour including
    the proofs, which exceeds the 30-minute rule's threshold.
- **TODO marker**: `TODO(audit-sentinel-verification-gaps): extract unallocatablePid for
  probe-path coverage` to be added at `scripts/__tests__/backup-db.test.mjs:68`.
- **Orchestrator sign-off**: exception 3 (acceptable risk, quantified) satisfied; user
  decision 2026-08-31.

### R1-20 Minor C13 anchor-publisher sentinel sites — Out of scope (different feature)
- **Anti-Deferral check**: exception 4 — out of scope, tracked.
- **Justification**:
  - Worst case: `tenantId: SYSTEM_TENANT_ID` can be deleted from any of the five sites at
    `src/workers/audit-anchor-publisher.ts` and the suite stays green; the anchor rows
    would then be attributed by `resolveTenantId`'s fallback instead of stated. Since the
    publisher's actor is `SYSTEM_ACTOR_ID` with no `users` row, the fallback returns
    `SYSTEM_TENANT_ID` anyway — so the observable impact today is nil, and it becomes real
    only if the publisher ever gains a real actor.
  - Likelihood: low; the file has not changed since before `e3f50de5e`.
  - Cost to fix: five separate mutation-proofs plus whatever assertions they turn out to
    need — comparable to C1's whole cost, against a defect with no live impact.
- **TODO marker**: `TODO(audit-sentinel-verification-gaps): mutation-prove the five
  anchor-publisher sentinel sites` — recorded as SC8.
- **Orchestrator sign-off**: exception 4 satisfied; the class was derived (not assumed)
  and the exclusion is now an adjudication rather than a `grep -v`.

## Recurring Issue Check

Preserved as each expert filed it.

### Functionality expert

- R1 (Requirements coverage): Checked — Finding F1, F7
- R2 (Architecture violation): Checked — Finding F5
- R3 (Feasibility of stated remedy): Checked — Findings F3, F10
- R4 (Edge cases): Checked — Finding F6; F3
- R5 (Error handling / fail-closed): Checked — no issue; `logAuditAsync`'s catch arm at `audit.ts:343-348` correctly identified as still log-only (verified)
- R6 (Contract completeness): Checked — Finding F5, F2
- R7 (Consumer-flow walkthrough — schema change): Checked — Finding F13; C12's writer/seeder/migration walkthrough otherwise sound (verified `rls-cross-tenant-seed.sql:159`, all four migrations predate the sentinel, `helpers.ts:425`)
- R8 (Consumer-flow walkthrough — config surface): Checked — Finding F2
- R9 (ORM/type-shape correctness): Checked — no issue; `model TenantMember` has `tenantId … @db.Uuid`, so the `::uuid` cast is type-correct
- R10 (SQL/DDL correctness): Checked — no issue; seven `ADD CONSTRAINT … CHECK` precedents exist
- R11 (Infinite loop / deadlock): N/A — no concurrency primitive introduced
- R12 (Data corruption): Checked — Finding F6
- R13 (Naming / readability): Checked — Finding F14
- R14 (Dead code / duplication): Checked — Finding F14
- R15 (Test that cannot fail): Checked — Finding F3
- R16 (Mock shape vs. code under test): Checked — no issue; C2's diagnosis verified exactly
- R17 (Cleanup on failure path): Checked — Finding F6
- R18 (Shared-environment safety): Checked — Findings F6, F12
- R19 (Worker/test contention): Checked — no issue; VC2 matches CLAUDE.md's recorded procedure
- R20 (Boundary/tie stated): Checked — Findings F3, F5, F10
- R21 (Sub-agent production-mutation residue): Checked — no issue; residue sweep present in the plan
- R22 (Mutation proof on throwaway only): Checked — no issue
- R23 (Commit before mutating): Checked — no issue
- R24 (Exit code vs. stderr): Checked — Finding F4
- R25 (Gate weakened to pass): Checked — no issue in intent; F4's remedy would have caused one
- R26 (Silent-when-healthy gate): Checked — Finding F3
- R27 (Prohibited deferral phrasing): Checked — Finding F12
- R28 (Anti-Deferral triple present): Checked — Finding F12
- R29 (Derived-claim accuracy): Checked — Findings F13, F15; reconciled: 218 `it(`, 237 runtime cases, 1040/315/244, 10 review-doc files, 6 create/upsert writers
- R30 (Citation resolves): Checked — Findings F8, F15
- R31 (Remedy deletes nothing load-bearing): Checked — no issue in C12
- R32 (Allow side paired): Checked — Finding F5
- R33 (Fail-loud): Checked — Finding F3
- R34 (Preference vs. defect): Checked — no issue
- R35 (Evidence inside the change): Checked — no issue
- R36 (Question ranked as a question): Checked — no issue
- R37 (Severity proportionality): Checked — one Critical, eleven Major, six Minor
- R38 (Handoff list treated as hint): Checked — Findings F1, F7, F11
- R39 (Null delta is evidence only if derived): Checked — Finding F1
- R40 (Adjudication recorded per member): Checked — Finding F7
- R41 (Legitimate members preserved): Checked — no issue (verified against `audit.ts:194-197` and `:343-348`)
- R42 (Member-set re-derivation): Checked — Findings F1, F7, F8, F11, F13
- R43 (Class gives membership, not failure mode): Checked — F1's remedy requires per-site execution
- R44 (Exit code asserted): Checked — no issue in the existing self-test; F4 is about the pattern
- R45 (Gate cited by name vs. member set): Checked — Finding F2
- R46 (Read a sibling gate first): Checked — Finding F3
- R47 (Forbidden pattern must not match its fix): Checked — Findings F4, F17
- R48 (AST vs. grep): N/A — C12 uses a storage-engine constraint
- R49 (Control class / over-claim): Checked — Finding F9; C5's `detection or audit only` correct
- R50 (No downstream reliance on detection-only): Checked — no issue
- R51 (Adjudication authority): Checked — Finding F5
- R52 (Widening a control's reach): Checked — no issue; C12's R52 note verified
- R53 (Null return holding a second invariant): Checked — no issue; `assertEnqueueableUserId` present and documented
- R54 (No durable emit on a limiter's refusal arm): Checked — no issue
- R55 (Reviewer finding not taken at face value): Checked — Findings F1, F9
- R56 (Rounds that seed their own defects): Checked — Findings F3, F4 are the signal to watch
- R57 (Go/No-Go completeness): Checked — Finding F18

*Orchestrator note*: this expert populated the R-column with its own descriptive names
rather than the catalogue's. Each check ran and is evidenced; the naming deviation is
recorded rather than corrected, since re-labelling would misrepresent what was filed.

### Security expert

- R1: Checked — no issue. C12 reuses the existing migration mechanism and `resolveTenantRef`; C7's failure to reuse an existing override is F2a.
- R2: Finding F1. The sentinel literal would gain a third independent copy with no gate tying them.
- R3: Finding F4. The writer enumeration does not propagate over installed trigger functions.
- R4: N/A — no event/notification dispatch; the sentinel owns no webhooks (WEBHOOK_MANAGE requires membership, `tenant-auth.ts:30-40`).
- R5: Checked — no issue. C12's only multi-step DB work is DDL; `auth-adapter.ts:329-352` already wraps the pair in one transaction.
- R6: Checked — no issue, and it cuts the plan's way. `audit_logs_tenant_id_fkey` is `ON DELETE RESTRICT`; `ON UPDATE CASCADE` would let an ad-hoc `UPDATE tenants SET id` cascade a real tenant's rows into the sentinel — C12's CHECK blocks that too. Unclaimed strength.
- R7 / R8: N/A — no UI or E2E surface.
- R9: Checked — no issue. No emit moves inside a transaction; SC3's a1 half stays deferred.
- R10: N/A — no new module or import edge.
- R11: N/A. R12: Checked — no issue; no `AuditAction` added. R13: N/A.
- R14: Checked — no issue. Adding a CHECK changes no ACL. Note the manifest is at `scripts/checks/db-grants-manifest.json`, not `scripts/db-grants-manifest.json`.
- R15: Finding F1 — the same defect in constant form.
- R16: Finding F6. The pre-flight covers the dev database only.
- R17: N/A — no new helper. R18: Checked — no issue; `bound-unknown-ip-manifest.json` untouched, see F8.
- R19: Routed [Adjacent] to Testing. C2's substance confirmed against `audit.ts:341-348`.
- R20: Checked — C5/C10 guard it explicitly, and the three protected sites verified.
- R21: Checked — followed it; `git status --porcelain scripts/` clean after the probes.
- R22: N/A. R23: N/A. R24: Checked — the tree has a `NOT VALID` precedent with its reason recorded; C12 deliberately does not follow it, correctly.
- R25 / R26 / R27 / R28: N/A.
- R29: Finding F5, and F2/F3/F8 are rationale-accuracy instances of the same rule.
- R30: Checked — no issue; the artifact is a doc, not a PR body.
- R31: Checked — the plan is correct and explicit; F6 is a documentation gap under a correct rule.
- R32: N/A. R33: Checked — no issue.
- R34: Finding F3. SC3's form is right; the content does not survive measurement.
- R35: Checked — no issue; F6 asks for the operator half.
- R36: Checked — F2a is the one place the plan's own text puts Requirement 7 at risk.
- R37: Checked — no issue; operator vocabulary, not end-user strings.
- R38: Checked — no issue. A `23514` on the SSO sign-in path is a correct refusal, not a wedge: the whole `withBypassRls` transaction aborts, so no partial state persists.
- R39: N/A. R40: Checked — one instance, correctly deferred (SC3's a1 half; the stdout line emits `params.tenantId ?? null` at `audit.ts:305`/`:395` while the row carries the sentinel).
- R41: Finding F7.
- R42: Findings F4, F8. Recomputed C1's set (2, matches), C10's (adjudications spot-checked, all correct), C11's (10, matches), C12's (F4 is the miss). Derived the audit-reader set independently: 13 files, all membership-keyed — the plan should record it, since "membership is the only gate" is C12's premise.
- R43: Checked — C12 narrows. F2a is the one place a fix could widen a boundary, which is why it is Major.
- R44: Finding F2b. C7 forbids the stderr-only shape but its own criterion routes through a three-way-ORed boolean.
- R45: Checked — no issue; the widened-sink probe ran over the same 1040 files with no runtime change.
- R46: Checked — the gate already resolves innermost-binder-first and records the measurement that made it necessary. F1's parity gate must be written the same way.
- R47: Checked — the plan's choice is right. A CHECK cannot be deferred (`SET CONSTRAINTS` applies only to deferrable FK/UNIQUE), cannot be skipped by `COPY`, and survives every writer. The residual surface-form problem is F1.
- R48: Checked — no issue, and the plan's strongest structural choice: one adjudicator, the tool refusal explicitly demoted to a message.
- R49: Findings F3 and F7. F7 is the direct instance; F3 is the inverse — a real, cheap control declared too expensive.
- R50: Checked — the plan is unusually good here (VC1-VC4). F2b is the one place a proxy signal slips back in.
- R51: Finding F1 — the primary rule for it.
- R52: Finding F4, partially. The audit reaches the right answer for the writers enumerated; the gap is the one that was not.
- R53: Checked — no threshold set or raised; the citation for `MAX_ROWS_PER_TENANT` is off (F5).
- R54: Checked — no issue, and the rule that would have bitten a different design. `withBypassRls` sets `app.bypass_rls` for the enclosing transaction and both RLS policies honour it, so RLS alone would not have protected the sentinel's rows. C12 prevents the membership instead, which is the right layer.
- R55: Checked — no issue. `SYSTEM_TENANT_ID` is UUIDv4-structural with a zeroed random field, so `gen_random_uuid()` cannot emit it. The `resolveTenantId`-null/`UUID_RE` hazard is carried correctly and now held by `assertEnqueueableUserId`.
- R56: Checked — C11's direction is correct: annotate, never delete.
- R57: Checked — no issue in the plan's changes. Adjacent observation for the record: `getTenantMembership` uses `findFirst` with no `orderBy` while `resolveUserTenantIdFromClient` orders by `createdAt` and throws on >1. Pre-existing, untouched, and C12 makes the sentinel instance unreachable.
- RS1: N/A — no secret/MAC comparison.
- RS2: Checked — no new route; F8 covers the adjacent claim, all limiters verified IP-keyed with `boundUnknownIp`, none emitting on the refusal arm.
- RS3: Checked — C12's refusal at the operator-supplied `<ref>` ingest boundary is the right place.
- RS4: Checked — no issue; `corp.example` is a reserved example domain.
- RS5: Checked — the sentinel arrives from a constant. `userAgent` is externally supplied but length-bounded (`audit.ts:155`) and formula-guarded on CSV export.
- RS6: Checked — the escape-the-escape-character clause is handled at `unsafe-display-chars.ts:70-95`; C10 correctly leaves it alone.

### Testing expert

- R1-R20, R22-R28, R30, R32-R43, R45-R48, R50, R53-R57: N/A — not engaged by a
  test-strategy plan; no matching shape found in the plan or the verified code.
- R21 (sub-agent production-mutation residue sweep): Checked — no issue. Applied to own probes; `git status --porcelain` → only the untracked plan file.
- R29 (counts and `file:line` re-derived): Findings F6, F15, partial F8, F11. Re-derived: backup-db 218 static vs **237 run**; C1 grep 2 reported vs **7**; C5 grep 11 tabled vs **52**; C11 10 vs **71** widened; C7 1040/315/244 ✓; C11 10-file list ✓ exact; C10's ten citations all ✓; SC1 `registry.ts:487-494` ✓; SC2 `:255` ✗ and C10 `audit.ts:46-50` ✗.
- R31: Checked — no issue. C12 states it explicitly, and the pre-flight returns 0 so the stop condition is not triggered.
- R44: Checked — no issue; already-satisfied state. All refusal cases assert `status`; `:275` documents why. Folded into F1 as evidence.
- R49: Checked — no issue in intent. One residual overstatement noted in F9: C8's `enforceable boundary` is scoped to the `pid_max` value read at module load, since `pid_max` is root-writable at runtime.
- R51: Checked — no issue. C12 states it explicitly; `prisma/schema.prisma:630` confirms `@db.Uuid`.
- R52: Checked — no issue. Confirmed `sweep.ts:752` and `audit-anchor-publisher.ts:118,197,232,360,449` write `audit_logs`, never `tenant_members`.
- RT1: Findings F3, F14. The mock is missing `$executeRaw`, proved by execution; RT1's typing remedy has no named mechanism.
- RT2, RT3, RT6: N/A — no matching shape.
- RT4: Checked — no issue; the plan's reasoning verified (C12 is DDL, C3/C4 are single statements). No race test proposed, so no vacuous-pass guard owed.
- RT5: Findings F3, F4. C2 names the right obligation and aims it at the wrong primitive.
- RT7: Finding F1; also bears on F9 and F12.
- RT8: Finding F2. The vacuity is correctly measured by #806; the plan's remedy misdiagnoses the cause.
- RT9: Finding F5. Three suites, not two.
- RT10: Findings F2, F3, F7. **C12 handles RT10 correctly and explicitly — both arms carry an allow side; the plan's best contract on this axis.**
- RT11: Finding F7. C3's `ctx.cleanup()` cannot reach the row; C4's fixture *is* genuinely covered (`helpers.ts:627-629` sweeps on the failure path), so the plan is right about C4 and wrong about C3. C12's allow-arm row is covered by `deleteTestData`.

### Verified clean — reported so round 2 does not re-derive

- C12 pre-flight passes now: `SELECT COUNT(*) FROM tenant_members WHERE tenant_id='00000000-0000-4000-8000-000000000002'` → **0**.
- C12's deny arm will fail for the right reason. Testing proved PostgreSQL reports the
  CHECK violation (SQLSTATE 23514) even when an FK on the same row is also violated —
  temp-table probe inside `BEGIN … ROLLBACK` on the dev DB, non-destructive. So the test
  needs no real `users` fixture to avoid a 23503 false pass.
- C12's existing-fixture risk is nil: `helpers.ts:425` and
  `admin-vault-reset-cross-tenant-sessions.integration.test.ts:72` insert under
  `createTenant()` ids; `scripts/rls-cross-tenant-seed.sql:159` and the four migration
  inserts use their own tenant ids. None names the sentinel. All four
  `tenant_members`-inserting migrations predate the sentinel's `20260428170853`, so a
  fresh replay is safe.
- C12's writer derivation is exact: 6 create/upsert, 8 update sites across 3 files
  ("Update-only sites (4)" is a labelling slip, not a member-set miss), nested-write
  command returns zero rows.
- C7's production counts: 1040 / 315 / 244, exit 0. Matches #806.
- C11's narrow derivation: exactly the 10 files listed.
- `worker-error-log-fields-code-review.md:249`'s three items (F-M4/F-M5/F-m3) are all
  closed in current code — independently re-verified by Functionality and Testing.
- `/proc/sys/kernel/pid_max` = 4194304 on this host; `process.kill(4194305, 0)` → ESRCH.
- Widened narrative-gate sink measurement: `244 → 610` properties, **0 violations**,
  exit 0, 22 self-tests green.

---

# Round 2

## Changes from Previous Round

Revision 2 of the plan, rewritten against all 21 of round 1's merged findings: C1's class
restated as an intersection with `e3f50de5e`, C2 re-scoped and its member set stated, C3
given a reclaim, C4's two arms separated, C7 rewritten, C8's prose half withdrawn, C9 closed
as resolved-no-change, C10's scope narrowed, C11 split into two tiers, C12 given a parity
gate and a moved refusal, plus two new contracts — C13 (operations runbook) and C14 (the S7
sink widening the user pulled in-branch after Security's cost measurement refuted the
deferral).

## Result: 43 findings, 1 Critical — and one signal all three experts named independently

**R56 — rounds that seed their own defects.** Functionality: "five of the seventeen findings
are round-1 remedies reproducing the defect they closed — this is the round's dominant
signal." Security: "two round-2 remedies reintroduce round-1 shapes." Testing: "six remedies
that carry forward or re-create the defect they close. This is the round's dominant signal."

The concentration was diagnostic: the reproductions sat in the pre-baked derivation tables,
the frozen `file:line` citations, and the pre-specified self-test constructions — the parts
of the plan specifying what the toolchain settles in seconds. That drove the revision-3 scope
decision (see "Phase 1 exit").

## Findings (merged, by root cause)

- **R2-01 — Critical — C2's `Pick<PrismaClient, "user" | "team" | …>` does not compile.**
  Executed: `TS2740`, both delegates. `Pick` selects whole members, so it demands the full
  17-method delegate. Round 1's own claim that "a `Pick<>` annotation works" was refuted.
  Testing supplied and executed the nested form (`Pick<PrismaClient, "$transaction" |
  "$executeRaw"> & { user: Pick<PrismaClient["user"], "findUnique">; … }`), which compiles and
  whose deny arm reddens with `TS2561`. **Adopted verbatim into C2.**
- **R2-02 — Major — C14's sink set was 4 of 5.** Security derived the class from
  `buildOutboxPayload` and the schema and found `ip` uncovered: `VarChar(45)`, passed through
  unsliced, inserted verbatim by the worker. Measured: 4-member = 610 properties, 5-member =
  681, **zero violations either way** — the identical cost argument that pulled the other
  three in-branch. **Fixed.**
- **R2-03 — Major — C14 widened the sink but not the report channel.** The violation header
  and the self-test's detection predicate both hard-code `metadata`, so a `targetId` violation
  would be reported as a `metadata` one — or the predicate loosened to a substring that cannot
  tell the sinks apart, which is C7's own lossy-channel defect one contract over. **Fixed.**
- **R2-04 — Major — C12's `cmdRemove` refusal deleted the audited undo.** `cmdRemove` performs
  a *soft* revoke with a claim event, and its own comment names that lifetime as what incident
  response needs. `cmdAdd` is the only creator of a sentinel claim (the sign-in JIT path
  creates its claim nested inside a `tenant.create`, so always on a new tenant; the backfill
  filters on a column the sentinel row lacks). Refusing `remove` blocks no creation path and
  strands any deployment where the accident already happened. **Fixed — `cmdAdd` only.**
- **R2-05 — Major — C13 had no containment step.** Both membership resolvers filter
  `deactivatedAt`, so setting it removes the read path immediately and destroys no evidence —
  and the CHECK adjudicates regardless, so containment does not unblock the rollout. Neither
  was stated. **Fixed — ordered 5-step response.**
- **R2-06 — Major — the pre-flight counted members, not the claims that create them.** A
  claim exists before any member does, so an upgrading deployment reads 0, applies the
  migration, and inherits a permanent sign-in denial for that domain. `COUNT(*)` also omits
  the `role` the severity call depends on: claim-driven memberships are created as MEMBER,
  audit-log read requires OWNER/ADMIN, and nothing can promote inside the sentinel. **Fixed —
  two queries, per-role interpretation.**
- **R2-07 — Major — the parity gate tied the constant to the CHECK only.** The sentinel
  literal's other load-bearing SQL occurrence is the `tenants` row that is the FK target of
  `audit_logs`/`audit_outbox`. A gate scoped to the CHECK goes green on a change that leaves
  no `tenants` row for the new UUID, at which point every unattributable emit FK-fails into
  the log-only catch arm — #806's gap reopened silently with the new gate reporting OK.
  **Fixed.**
- **R2-08 — Major — the parity gate had no execution path.** No `queue_step` line, no wiring
  self-test, in a tree where seven `scripts/checks/*.mjs` are unreferenced by `pre-pr.sh`.
  **Fixed — wiring plus an anchored self-test that rejects a commented-out `queue_step`.**
- **R2-09 — Major — C7's two new cases were not constructible.** The harness writes one fixed
  subject path into a root created once per file, and the leftover subject makes case B
  order-dependent. Case A was also not distinct from the existing non-existent-path case.
  **Fixed — harness support named as in-scope; construction pinned.**
- **R2-10 — Major — the refusal-predicate split under-counted.** The gate has four `fail()`
  sites, not three, and every existing case asserts the shared boolean — so removing it
  contradicted "existing cases pass unchanged". **Fixed — four-way split with the OR retained;
  Testing verified `OR ≡ today's boolean` across all six constructions.**
- **R2-11 — Major — C3's reclaim was scoped by ids it had no way to obtain.** `logAuditAsync`
  returns void and `audit_outbox` carries no caller-supplied key, so the obvious `SELECT` is
  the tenant-wide scope the contract forbids. **Fixed — the test sets its own `randomUUID()`
  marker in `targetId`.**
- **R2-12 — Major — C10's and C5's element-wise criteria were unsatisfiable.** C10's narrowed
  derivation returns 69 rows across 23 files against a table of ~25; C5's returns 18 against a
  table of 11. **Fixed via Testing's own suggestion — a diff-of-derivations criterion, residue
  adjudicated by class.**
- **R2-13 — Major — SC4's `--reporter=json` would blind `pre-pr.sh`.** The JSON reporter
  *replaces* the default, and `pre-pr.sh` extracts its failure count, seed line and context
  window from the default output. **Fixed — two-reporter form with the keyed output-file flag,
  allow arm executed.**
- **R2-14 — Major — C11's Tier 2 had a threshold-shaped rule with no threshold.** Measured
  delta: 78 headings across 71 files. **Fixed — 15-heading budget with a Go/No-Go row.**
- **R2-15 — Major — C4's query arm and C1's assertion rule were labelled fail-closed** while
  neither has an enforcing mechanism. **Fixed — both relabelled `detection or audit only`, and
  C1 states that its two mutation proofs are the mechanism.**
- **R2-16 — Major — C6 offered two options and its criterion admitted only one.** **Fixed —
  C6 decides: delete.**
- **R2-17 … R2-22 — Minor** — the installed `AFTER INSERT` trigger missing from C12's writer
  set (adjudicated unreachable, but its blast radius aborts the parent `users` INSERT, which
  no other writer does); C12's nested-write grep using a relation name the schema does not
  have, so its "null result" was a typo; the raw-SQL row double-counting the trigger; SC1's
  emitter set naming 2 of at least 10; C12's second forbidden pattern unenforceable (deleted);
  and citation slips — five of seven Bucket C line numbers off by one, plus four others. All
  fixed, and the citation class was closed at its cause by removing the frozen tables.

## Verified clean in round 2

237 backup-db cases; gate baseline `1040 / 315 / 244` exit 0; widened 4-member `610` with 0
violations; sentinel `tenant_members` count 0; PostgreSQL reports `23514` even when an FK on
the same row is also violated; `payload` is `jsonb` with `targetId` at top level; the
membership resolvers, the `ON DELETE RESTRICT` / `ON UPDATE CASCADE` behaviours, and the
`audit_outbox` BEFORE DELETE guard all as the plan describes.

---

# Round 3

## Changes from Previous Round

Revision 3, 623 lines from 905. Two kinds of change: the design fixes above, and a deliberate
**de-specification** — frozen member tables, exact expected counts and exact `file:line`
citations removed and replaced with the derivation obligation plus the adjudication rule.

## Result: 30 findings, 3 Critical — and the de-specification verdict

**The de-specification worked where it was applied.** All three experts re-derived C1, C10's
Bucket C, C11 and C12 from revision 3 alone and reproduced the sets exactly. Security put it
strongest: C12's derivation obligation reached `e2e/helpers/db.ts` — two raw
`INSERT INTO tenant_members` sites that appeared in **neither** round-1 nor round-2 frozen
list. A rule outperformed two curated lists.

**Every surviving R56 instance sat in what stayed frozen.** Security: "de-specification removed
the R56 surface everywhere it was applied — every surviving instance sits in C14's per-field
table, the one enumeration revision 3 kept frozen." Functionality reached the same split.

## Findings

- **R3-01 — Critical — C12's parity gate had no discovery predicate.** Functionality
  constructed both readings and broke both: value-anchored, a mutated literal *drops out of the
  match set*, so the gate sees fewer occurrences and exits 0 — making two of the three
  red-proof clauses unsatisfiable; shape-anchored over all UUID literals, another sentinel
  actor id appears twice under `prisma/` and mismatches, so the allow arm breaks on the
  unmodified tree. **Fixed** — C12 now states the two properties any implementation must
  satisfy and names two viable mechanisms; the choice is CF1.
- **R3-02 — Critical — C3's failure boundary named an FK that was dropped.** The
  `audit_deliveries → audit_outbox` FK was removed in migration `20260415143000` and never
  re-added; the schema declares no relation. So the "23503 or 0 rows" boundary was inoperative,
  and a VC2 violation would have left an `audit_logs` row under the sentinel with **every
  stated check passing**. **Fixed** — replaced with a marker-scoped `audit_logs` read.
- **R3-03 — Critical — C14's per-sink floor refuses on every existing self-test fixture.**
  Testing built it: the shared anchor carries only a `metadata` property, so a per-sink floor
  reddens ~17 cases while the plan listed one as the expected edit — and the available wrong
  fix (a floor over the *sum*) restores all 17 while voiding the fail-loud clause, since
  renaming one sink leaves 527 of 681 properties. Functionality red-proved the same thing from
  the other side: with the aggregate counter revision 3 specified, renaming `ip` gives
  `610 … OK, exit 0`. **Fixed** — per-sink counters, per-sink floor, and the anchor widening
  named as required work (Testing verified it works).
- **R3-04 — Major — C14 adjudicated `teamId`/`serviceAccountId` out of class on a mechanism
  that does not hold.** Security executed every link: the worker accepts any string for those
  fields, the insert casts them to `uuid`, PostgreSQL's `22P02` message **embeds the offending
  text verbatim**, the worker catches it, and at max attempts its error recorder writes an
  `audit_logs` row whose `metadata.lastError` carries the truncated message. The error
  sanitizer strips URL params and credential patterns, not narratives. So the narrative reaches
  the same tenant-readable sink — Anti-Deferral rule 7 applies. **Fixed — the class is seven.**
- **R3-05 — Major — C5's and C10's primitives were prose labels, not expressions.** Testing
  showed three plausible readings of C5's label returning 1, 24 and 142 rows. A diff criterion
  over an unstated pattern is trivially satisfiable — the exact inverse of round 1's finding
  that the element-wise criterion was unsatisfiable. **Fixed — both expressions carried
  verbatim, recorded, and re-run byte-identically.**
- **R3-06 — Major — C5's mandatory pre-edit validation referenced a set in no artifact.** It
  required confirming "every site independently confirmed stale across rounds 1-2", and round
  2's enumeration existed nowhere — this file was `Review round: 1`. That is the one place the
  de-specification lost something load-bearing. **Fixed two ways** — the six-site seed is
  carried in C5, and rounds 2 and 3 are now recorded here.
- **R3-07 — Major — C3's two post-run clauses contradicted, and the stricter was false.**
  Testing measured live rows under the sentinel on the dev database, written by the retention-GC
  heartbeat, so "a non-zero post-run count fails" would fail every run. **Fixed — marker-scoped.**
- **R3-08 — Major — C7's and C14's message edits collide.** Testing executed it: written
  against today's message, the per-refusal predicate stops matching after C14 and the retained
  OR reports **false for a real refusal** — fail-open in the harness's own channel. **Fixed —
  ordering stated (C14 first) plus a post-C14 cross-check.**
- **R3-09 — Major — C14's "every dereference follows" missed the remediation block.** It is a
  hard-coded string literal, not a dereference, so `grep` for the constant cannot surface it —
  and its text is wrong for every non-`metadata` sink, since neither sanitizer touches them and
  two are unbounded `text` columns. **Fixed.**
- **R3-10 … R3-20 — Minor** — `ip`'s in-class reason omitting the 45-character boundary (below
  it a narrative lands verbatim; above it `22001` loses the audit event, and unlike `22P02` the
  message does not embed the value — so the payload builder should slice `ip` as it already
  slices `userAgent`); C14's `userId` and `tenantId` out-of-class reasons naming the wrong
  mechanism (`logAuditInTx` skips the actor guard entirely; `tenantId` fails at the app-side
  enqueue); C3's deny arm naming an FK where an explicit `SELECT EXISTS` guard throws first;
  "seven unwired gates" overstating (four run in CI; three are truly unexecuted); C10's Bucket
  C tie-break resolving one of *two* ambiguous basenames; C13 offering a `docs/` scan-set branch
  Requirement 2 forbids and an "untied" branch with no instantiable catch; the literal's five
  coincidental non-sentinel reuses needing a role-not-spelling adjudication; applied migrations
  being checksummed so the constant is the side that must move; C7's "shadowed-by-construction"
  annotation contradicting a self-test that reaches the floor; C5's ordering clause citing a
  rename C6 no longer performs; and C11's Tier 1 glob including this branch's own artifacts.
  All fixed in revision 4.

## Verified clean in round 3

C1's intersection (7 → 2); C11's 10 / 71 / 88 / delta 78; C14's field count (12 = 5 in + 7
out, before R3-04 moved two); the widened 5-member measurement `1040 / 315 / 681` exit 0 with
per-sink breakdown `metadata 244, targetType 158, targetId 154, userAgent 54, ip 71`; the four
`fail()` sites; C2's nested `Pick` compiling with `TS2561` on the deny arm; SC4's two-reporter
form working; C12's pre-flight reading 0/0; the seven-unwired-gate derivation; `payload->>'targetId'`
resolving; and C6's subsumption claim.

---

# Phase 1 exit

**Closed at round 3 by user decision (2026-08-31), after the finding character changed.**

| Round | Findings | Critical | Character of the Criticals |
|---|---|---|---|
| 1 | 21 merged | 1 | **design** — a contract specifying unbuildable work over an existing mechanism |
| 2 | 43 | 1 | **mechanism** — a TypeScript construct that does not compile |
| 3 | 30 | 3 | **mechanism** — a gate's discovery predicate, a self-test fixture's shape, a dropped FK |

Counts did not converge, which the saturation criterion anticipates as the normal case. What
changed is that round 3 produced **no finding against the design**: C12's constraint, C14's
widening, C3's marker reclaim, C10/C5's diff criterion and C11's tiers were all confirmed
across three rounds, and every round-3 Critical arrived with a remedy the expert had already
executed. The remaining questions are what a gate's implementation looks like — settled faster
by writing the gate than by another plan round.

This exit does **not** satisfy the skill's saturation criterion, which requires no open
Critical or Major. It is the user's decision, taken with the table above in front of them, and
the cost is recorded: the six items in the plan's `## Carried-Forward Plan Findings` section
each carry an Anti-Deferral entry and a one-line statement of what would settle them. Phase 2
Step 2-1 reads that section.

**The methodological result, which outlived the branch.** Revision 2 pre-specified member sets,
counts and citations; three experts independently reported that its own remedies were producing
the next round's defects. Revision 3 replaced the frozen tables with derivation obligations and
adjudication rules and shrank by a third; round 3 confirmed the rules reproduced every set —
and in one case reached a member two curated lists had missed. Every defect that survived into
round 3 sat in the one table revision 3 left frozen. **Specify what the toolchain cannot decide;
derive the rest.**
