# Plan Review: audit-emit-tx-fold

Date: 2026-09-05
Review round: 1

## Changes from Previous Round

Initial review. Three expert sub-agents (functionality, security, testing) reviewed
revision 1 of `docs/archive/review/audit-emit-tx-fold-plan.md` against
`main @ e780c75fe`, each with read access to the tree and to Bash. A fourth
agent, spawned by an expert, independently re-derived the RLS-nesting member set.

Local LLM pre-screening (`pre-review.sh plan`) returned "No issues found" and is
not counted as a round.

## Merge method

Mechanical pre-pass over the three fenced json indices, joined on (file, line
±5, root cause), then merged by hand — the Ollama `merge-findings` path was not
used because all three indices were well-formed and the join was unambiguous.
Convergent findings carry `convergent:` and take the **maximum** reported
severity, never the average.

Counts as filed: functionality 10 Major / 4 Minor / 2 Adjacent; security 5 Major
/ 6 Minor / 1 Adjacent; testing 3 Critical / 8 Major / 2 Minor / 2 Adjacent.
After merge: **3 Critical, 20 Major, 8 Minor.**

## What reproduced, and what did not

All three experts re-derived the plan's member sets independently, with
differently-structured scans. The load-bearing sets **all reproduce exactly**:

| Claim | Plan | Independently re-derived | Verdict |
|---|---|---|---|
| `prisma(Base)?.$transaction` in `src/lib/audit/` | 2 | 2 | reproduces |
| Callers of `enqueueAudit`/`enqueueAuditBulk` | `audit.ts` only | `audit.ts:485,566` only | reproduces |
| Lexical in-context emits | 0 | 0 (three scans) | reproduces |
| Transitive in-context emits | 1 (N3) | 1, identical (three scans) | reproduces |
| Live nesting sites / non-members | 3 / 2 | 3 / 2, identical (four scans) | reproduces |
| `CRITICAL_ACTIONS` | 7 | 7, `EMERGENCY_ACCESS_ACTIVATE` absent | reproduces |
| `withTenantRls` call sites | 126 | 126 | reproduces |
| Registered functions | 2826 | 2788 / 2794 / 4178 | **subject-dependent** (M12) |
| Fold sites | 35 | 33 | **subject-dependent** (M12) |

The fourth agent's sweep additionally cleared, with evidence, every category the
plan did not enumerate: notification/webhook/policy/rate-limit helpers, the four
password/SCIM service modules, the two state machines, the crypto helpers, and
`src/workers/` — **zero** opener calls in any of them. It also confirmed the two
`derivePasskeyState` non-members and found the only bare-identifier opener
callbacks in the tree to be three sites (M5).

**The member sets are not the problem with this plan.** The findings below are
about the plan's *reasons*, its *control-class claims*, its *acceptance
criteria*, and one contract (C4) that is not implementable as specified.

---

## Functionality Findings

### M1 — Major (convergent: functionality+security) — C2's forbidden pattern `void .*logAudit` has no derived member set, matches two untouched production sites, and has no runner

`grep -rnE 'void .*logAudit' src --include='*.ts'` (tests excluded) returns two
production hits, neither touched by this plan and both deliberate:
`src/workers/audit-anchor-publisher.ts:227` and
`src/lib/auth/session/auth-adapter.ts:759` — the latter placed *after* its
`withBypassRls` has settled, with a comment saying so.

The pattern also names no gate that would run it: C4's declared subject is
opener-in-opener, and `scripts/pre-pr.sh` has no step matching it.

**Impact.** The implementer meets a pattern red on two files the plan does not
mention. Both exits are bad: delete two deliberate fire-and-forget sites (an
unreviewed behaviour change), or soften the pattern until it goes green (R36 —
a gate passing because its subject was narrowed).

**Recommended action.** Replace the surface-form pattern with the predicate that
matches the hazard — *an emit inside an opener callback whose result is not on
the callback's awaited path* — and give it a runner inside C4, which already
walks opener callbacks. Allow side: both existing sites stay green **and** stay
`void`ed, asserted by name in the gate's self-test. Red-prove separately: (i)
add a `void` emit inside an opener callback → red naming file:line; (ii) move it
one line below the opener's closing brace → green; (iii) revert, both existing
sites still green. Fail loudly: a call whose awaited-ness cannot be decided
reports `UNDECIDED` and exits non-zero. Preserve: the two sites' fire-and-forget
behaviour, which exists because awaiting them inside the block was the bug
already fixed. Boundary/tie: the opener callback's lexical closing brace; when
two openers nest, the innermost owns the call.

### M2 — Major (convergent: functionality+security) — the ALS context outlives the drain, so a late-pushed thunk is dropped with no row and no dead-letter

`tenantRlsStorage.run(...)` binds the store to the whole async subtree started
inside the callback, including branches that outlive `with*Rls`'s resolution.
`getTenantRlsContext()` therefore keeps returning a context *after* the drain has
run. A thunk pushed then is appended to an array nobody reads again.

Today the same call reaches the Proxy's fold arm with a closed `tx`, Prisma
throws, and `logAuditAsync`'s catch produces a dead-letter. **C2 converts a loud
loss into a silent one.** No live member exists today (a sweep for detached async
work started inside an opener callback found none), and the reason today's two
`void` emit sites survive is incidental: `logAuditAsync` runs synchronously as
far as `resolveTenantId`, so the push lands before the callback yields. The plan
never states that as an invariant, and any helper that awaits before emitting
breaks it.

This also contradicts C2's own control class: "there is no per-call-site
obligation to get right" is stated on the same contract that then adds a
per-call-site forbidden pattern. Both cannot be true (R49).

**Recommended action.** Seal the queue at drain time: after the drain, a push
falls through to the inline path (safe post-commit, no context transaction live)
and, if that also fails, dead-letters with its own reason
(`drained_queue_late_push`). State explicitly that the push happens in the
emit function's synchronous prefix — it can, since `buildOutboxPayload`, the
`auditLogger.info` block and `assertEnqueueableUserId` are all synchronous today.
Allow side: an awaited in-context emit is still deferred and drained exactly
once, and two awaited emits produce two rows in call order. Red-prove
separately: (i) push after the drain via the fallback → exactly one row; remove
the fallback → zero rows and the test reddens; (ii) with the fallback present,
break `enqueueAudit` → the dedicated dead-letter reason, not silence. Fail
loudly: route each of queue-absent, drain-re-entrant, and foreign-context-push to
its own named refusal; none may be spelled "no work to do". Preserve:
`logAuditAsync`'s never-throws contract and R9 (the fallback must not float).
Boundary/tie: the instant the drain reads the queue's last element; a push
interleaving with the drain is executed by that same loop (drain until empty),
and must resolve to written-once — never twice, never dropped.

### M3 — Major — I2.4 is contradicted on the rollback path; the plan never says which side of the deferral boundary `assertEnqueueableUserId` sits on

C2 describes the queued work as "tenant resolution + `enqueueAudit`" (excluding
the id check) but also says `audit.ts` "keeps ownership of … the dead-letter
arm" (including it). The two readings diverge exactly on C2 AC3's rollback path:
check before the push → one dead-letter line, I2.4 holds; check inside the thunk
→ the queue is discarded and the malformed-id emit produces **zero** lines, and
the only forensic record of a caller passing a malformed actor id is gone. Per
`assertEnqueueableUserId`'s own docblock the line is the whole point of the guard.

**Recommended action.** State that `buildOutboxPayload`, the `auditLogger.info`
emit and `assertEnqueueableUserId` all run at call time on both paths; only
`resolveTenantId` + `enqueueAudit` are deferred. Allow side: a well-formed id
inside a context produces zero dead-letter lines and one row after the drain.
Red-prove: malformed id + throwing transaction → exactly one line, zero rows;
move the check into the thunk and watch it drop to zero. Fail loudly: a payload
that cannot be constructed at all dead-letters rather than pushing an
unconstructable thunk. Preserve: the never-enqueue-a-poison-row property.
Boundary/tie: the first `await`; a batch with one malformed and one well-formed
id logs exactly one line and enqueues exactly one payload — the inline path
already does this and the deferred path must match.

### M4 — Major — the drain's error handling is specified per-thunk but not per-queue

I2.3 says a rejecting thunk is caught and logged. It does not say the drain
**continues**. `try { for (const t of q) await t(); } catch { log(); }` satisfies
I2.3 as written and abandons every thunk after the first failure, and no
acceptance criterion distinguishes the two. Multi-emit contexts are not rare —
the session-eviction loop emits once per evicted session,
`logAuditAsyncBothScopes` emits twice, and any per-item event inside a
transaction emits N times. One transient error then loses N−1 unrelated events
silently, because each thunk's own dead-letter never runs.

**Recommended action.** Invoke each thunk in its own try/catch; the loop always
runs to completion; each failure produces its own dead-letter carrying that
thunk's params. Allow side: N thunks with no failures produce N rows in queue
order. Red-prove: three thunks, first rejects → two rows and exactly one
dead-letter; wrap the loop in one try/catch → zero rows, one line. Fail loudly:
a thunk that neither resolves nor rejects stalls the response, since the drain
runs post-commit but still inside the request — name the timeout and its
refusal. Preserve: requirement 8. Boundary/tie: one thunk; two failures produce
two lines, not one aggregate.

### M5 — Major (convergent: functionality+security+testing) — the derivation method, and C4 with it, cannot see inside an opener callback passed as a value; C3's fail-closed member set carries no residual statement

Three opener call sites forward a bare identifier rather than an inline function,
so neither the plan's scan nor any expert's walks their bodies:
`src/app/api/vault/status/route.ts:25` and
`src/app/api/vault/unlock/data/route.ts:57` (both `withVaultTenantRls`, a local
wrapper defined under `src/app/` and therefore outside the plan's `src/lib/`
opener grep), and `src/lib/auth/policy/passkey-enforcement.ts:103` (`run`).

**All were resolved by hand and none reaches an opener or an emit, so no member
is missing.** The defect is the method, inherited by the gate the plan builds to
keep the set closed — and C4's I4.1 covers an unresolvable *callee*, a different
axis from an unresolvable *callback*.

C2 records its residual and discharges it soundly (the control lives inside the
emit functions, so an unenumerated call site inherits it). **C3 has no residual
paragraph and the discharging argument is not available there**: its control sits
at the opener, it is fail-closed, and the plan says so — an unenumerated site is
a denied request. The one contract whose miss-mode is a production denial is the
one whose derivation states no blind spot.

**Recommended action.** Add the residual to C3 naming the value-passed-callback
class with the three sites and how each was cleared. Add I4.4: an opener call
whose callback argument is not an inline function is **reported** with the
argument's text, not skipped; resolve same-file locals (all three are) or
allowlist them with a one-line reason each and a per-run count so a fourth
cannot arrive unnoticed. Allow side: the two `derivePasskeyState` sites must stay
non-members — a gate that reports them gets an allowlist entry on day one — and
the three cleared sites must not require inlining `withVaultTenantRls`, which
exists to choose between two openers on a real condition. Red-prove separately:
(i) rewrite N1's nesting into the indirect form (`const inner = async (tx) => …;
withTenantRls(prisma, tenantId, inner)`) → the gate as currently specified goes
**green**, which is the clause that proves the new rule; (ii) drop `tx` at one
`derivePasskeyState` call site → C3 throws and C4 names it. Fail loudly:
"reported and allowlisted" and "never examined" print differently. Preserve:
I4.3's fold exclusion. Boundary/tie: "can this callback's body be located by the
parse tree alone"; a conditional expression over two locals is reported, not
guessed.

### M6 — Major — I4.1 is not implementable as stated: 948 unresolvable callee occurrences inside opener callbacks

Measured with the registry and resolution rules the plan describes: 572 opener
call sites, 1263 calls inside their callbacks, **948 unresolvable occurrences**
across 56 distinct names — overwhelmingly Prisma model delegates and JS builtins
(`findUnique` 200, `findMany` 140, `findFirst` 80, `updateMany` 76, `create` 76,
`map` 65, `slice` 34, `$transaction` 33, …). A gate implementing I4.1 literally
prints 948 findings on a clean tree.

The plan gives no derivation for the boundary between "unresolvable because it is
`tx.user.findUnique`" and "unresolvable because it is a local helper" — and that
boundary is the whole gate. Whoever implements C4 will invent the suppression
list at the keyboard, which is the failure `check-bypass-rls.mjs`'s own header
records eleven rounds of, and which SC3 promises C4 will not repeat.

**Recommended action.** Derive the exclusion from the primitive: a call is out of
scope when its receiver resolves to a Prisma client or transaction-client binding
(`check-bypass-rls.mjs`'s `clientBindingsIn` already does exactly this and is
this repo's existing answer), or the callee is in a documented builtin set.
Publish the expected reported-unresolvable count so a later round can tell a
regression from a resolution change. Allow side: the gate exits 0 on the current
tree **with the reported count equal to a stated number** — not merely "no
violations", because a resolution change that silently drops 900 calls to 0 also
produces "no violations". Red-prove separately: (i) delete one builtin entry →
count moves by the known amount; (ii) break client-binding resolution → count
jumps ~700 and exit non-zero; (iii) add a genuinely unresolvable local helper
inside an opener callback → one new report. Fail loudly: the count must fail on
drift in **either** direction. Preserve: I4.3. Boundary/tie: the receiver, not
the method name — `tx.findMany` excluded, a bare `findMany()` identifier not;
where a name is both a client member and a local function, the local wins.

### M7 — Major (convergent: functionality+security) — the connection-pool rationale names a false member set

The plan writes: "the only case that holds two connections at once is a **direct**
`enqueueAudit` call from inside a bare non-RLS transaction, which no caller
makes". The class is "any emit reachable inside a transaction with no active RLS
context", and three callers make it:
`src/workers/audit-anchor-publisher.ts:113`, `:192`, `:227` call `logAuditAsync`
inside `this.prisma.$transaction` with no ALS store.

The conclusion — C1/C2 introduce no *new* overlap — is nonetheless **true**: with
no context the Proxy falls through to `baseClient`, so `prisma` and `prismaBase`
are the same object there and C1 is a no-op on that path. R29: a true conclusion
resting on a false member set is what licenses the next edit.

Related: requirement 3 ("a caller's transaction that rolls back must leave no
outbox row") is stated universally but holds only for RLS contexts; at those
three sites the outbox row commits independently of the anchor transaction's
rollback, both before and after this change.

**Recommended action.** Restate the class, name the three sites, and give the
actual reason no new overlap appears (Proxy fall-through). Qualify requirement 3
with "for a caller inside an RLS context". Allow side: the publisher's emits keep
working after C1 — pin with the existing worker test asserting a row is enqueued
when the anchor transaction rolls back. Red-prove: re-run the derivation and
check the count is 3, not 0. Fail loudly: if the ancestor chain cannot be
resolved, print the unresolved count rather than 0; if a pool-size probe cannot
run, say "not measured" rather than "no overlap". Preserve: the three publisher
emits and the worker's independent pool. Boundary/tie: an active
`tenantRlsStorage` store at the moment of the emit, not the lexical presence of
`$transaction`; a bare `$transaction` nested inside an opener is on the context
side.

### M8 — Major — "the drain runs outside any context" is established by C3, not by probe `(d)`

`withTenantRls`'s body runs in its **caller's** async context, so statements
after `await prisma.$transaction(...)` see whatever store was active when the
opener was *called* — not "no store". Probe `(d)` was taken from a top-level call
site and measures only that the opener's own store does not survive its `await`.
When the opener is entered from inside another context, the drain executes with
the outer store still active, and two things follow: `resolveTenantId`'s
`withBypassRls` is rejected and swallowed into a dead-letter, and the inner
`$transaction` folded, so the drain is not post-commit relative to the real
transaction.

Both are closed by C3 — but the plan attributes the property to `(d)` and orders
the work C1 → C2 → C3 with C2's tests written first. Between C2 and C3 the
property does not hold.

**Recommended action.** Rewrite C2's drain-placement paragraph: the drain runs
outside any context **because C3 guarantees the opener was entered with none**;
`(d)` establishes only the weaker property. Add the **C3 → C2** edge explicitly
alongside the existing C2 → C3 one, and state that C1/C2/C3 ship in one
commit-range, never as separate deployable states. Allow side: after C3 a
top-level opener still drains exactly once, **and** the drain must still run when
the opener is entered from inside a bare `prisma.$transaction` with no store —
which C3 does not forbid. That is its own criterion; it is the case the
fail-closed guard leaves open. Red-prove separately: (i) with C3 reverted, nest
two openers and emit inside → dead-letter line, no row, observed rather than
argued; (ii) with C3 in place, the same nesting throws before any emit runs. Fail
loudly: a non-empty ambient context observed at drain time is an invariant
breach, not a recoverable case — its own event name, and dead-letter the queue
rather than drain into the wrong transaction. Preserve: the fold at the intended
in-context `$transaction` sites. Boundary/tie: the opener's entry, not its exit;
when an opener and a bare `$transaction` both enclose the emit, the opener
decides.

### M9 — Major (convergent: functionality+security) — the C2 consumer walkthrough is incomplete, and it substitutes "no field changes" for "no value changes"

Code-derived, the walkthrough omits three consumers:

| Consumer | Evidence | Reads |
|---|---|---|
| `src/lib/health.ts` — `readAuditOutboxDepth` / `checkAuditOutbox` | `:150-196` | `COUNT(*) WHERE status='PENDING'` and `oldest_age`; drives the **readiness probe** (`/api/health/ready` → 503) |
| `src/workers/retention-gc-worker/sweep.ts` | `auditOutbox.create` heartbeat | writes `audit_outbox` from a **different DB role** |
| `scripts/tenant-domain.ts` | `:502` | stranded-denial diagnosis for the SSO lockout runbook |

None breaks — but the omitted one, `health.ts`, is the only consumer whose
**measured quantity is timing itself**, precisely the axis C2 changes. An
enumeration that omits the timing-sensitive consumer from a timing-change
walkthrough has not done the thing it claims.

Separately, the substitution "no field is added or removed" is legitimate for
three consumers but incomplete for `audit_outbox.tenant_id`, whose **value** is
computed at emit time by `resolveTenantId` from a live lookup. Moving that
resolution past the caller's commit means an operation that deletes its own
resolution target resolves differently (`?? SYSTEM_TENANT_ID`), and a row under
the sentinel is invisible to `/api/tenant/audit-logs`, which scopes by
membership. No live member — N3 resolves through the grantee's user row, which
the promotion does not delete — so this half is latent.

**Recommended action.** Add the three consumers with a one-line verdict each, add
`audit_outbox.tenant_id` as a value-axis entry with the resolution-target-deleted
case named, and state the mitigation (an in-context emit on a delete path passes
`tenantId` explicitly). Add one acceptance criterion for the health probe. Allow
side: `/api/health/ready` returns 200 under normal emit load after C2; an emit
with no owning tenant still resolves to `SYSTEM_TENANT_ID` and is still enqueued
— that property must not be undone. Red-prove: stop the worker, drive N >
`READY_PENDING_THRESHOLD` deferred emits through a context → the probe flips to
`fail`; restart → `pass`. Separately, emit in-context on a path that deletes the
resolution target and assert which tenant the row lands under; pass `tenantId`
explicitly and watch it flip. Fail loudly: keep `checkAuditOutbox`'s existing
`PG_UNDEFINED_TABLE`→`warn` vs everything-else→`fail` split; and log
"resolved to no owning tenant" distinguishably from "target row vanished before
the drain", which today read the same. Preserve: the GC heartbeat's direct
`auditOutbox.create` path must **not** be routed through `enqueueAudit` — that
worker connects as a different role with a different grant set. Boundary/tie:
`audit_outbox.status = 'PENDING'`; the caller's COMMIT for the value axis, where
a target deleted in the same transaction sits exactly on the boundary and the tie
must resolve to the tenant that owned it before the delete.

### M13 — Minor — N1's flatten requires rewriting three `tx.*` uses, which the disposition does not mention

The block binds and uses `tx` three times (`tx.teamPasswordEntry.findMany`,
`collectEntryAttachmentRefs(tx, …)`, `tx.team.delete`), and
`withTeamTenantRls`'s callback signature hands out no `tx`. So the flatten is a
deletion **plus three rewrites** to `prisma.*`. Both things that could make it
infeasible are fine: the Proxy delegates `prisma.<model>` to the open
transaction, and `collectEntryAttachmentRefs(client: TxOrPrisma, …)` accepts
`PrismaClient`. Behaviour is unchanged — the inner opener re-set `app.tenant_id`
to the same value.

*Question that closes it:* does the plan intend the `tx.*` → `prisma.*` rewrite,
or to thread `tx` through (which is SC2, explicitly deferred)?

**Recommended action.** Add the three rewrites to N1's disposition. Allow side:
team deletion still captures attachment refs **before** the cascade, and the refs
list is non-empty for a team with attachments — an empty list is what a silently
wrong client produces. Red-prove: delete a team with one attachment-bearing
entry, assert one ref reaches `deleteAttachmentBlobs`; point
`collectEntryAttachmentRefs` at a fresh client and watch the count go to zero.
Fail loudly: state what happens if no context is active when the rewritten body
runs — `prisma.team.delete` would address the bare client with `app.tenant_id`
unset, which must be a 22P02 or zero rows, never a successful cross-tenant
delete. Preserve: capture-before-cascade ordering. Boundary/tie: the
`withTeamTenantRls` callback's scope; the `tenantId` it supplies and the id the
outer wrapper resolved are the same value, which is why the flatten is safe.

### M14 — Minor — `TenantRlsContext` is not exported

C2 specifies the queue "on `TenantRlsContext`", declared non-exported at
`src/lib/tenant-rls.ts:18`. `getTenantRlsContext()` returns it so `audit.ts` can
read the field by inference, but cannot annotate a local or helper parameter.

*Question that closes it:* does C2 export the type (a public-surface change
belonging in the contract's signature block) or rely on inference?

**Recommended action.** State the answer. Allow side: `audit.ts` compiles under
`npx next build`, the mandatory check that catches this. Red-prove: write the
annotation without the export and observe TS2459/TS4023. Fail loudly: if
inference is chosen, the field must be **required** on the type so a context
shape lacking it is a compile error, not `undefined` at runtime. Preserve: R10 —
exporting a *type* creates no runtime import edge, so the cycle argument is
unaffected; say so explicitly with `import type` named as the form that keeps it
true. Boundary/tie: type-only vs value import.

---

## Security Findings

### M15 — **Critical** (convergent: testing+security) — the probe measured a configuration with no live member, and C2's integration pins are vacuous or red-for-the-wrong-reason as written

This is the plan's centre and the merge's most consequential finding.

`withBypassRls` **already** throws `INVALID_RLS_NESTING` when
`getTenantRlsContext()?.bypass === false` — i.e. inside a tenant context, today.
So `logAuditAsync` called inside `withTenantRls` **without** `params.tenantId`
never reaches `enqueueAudit`: `resolveTenantId` opens `withBypassRls`, the
pre-existing guard fires, `logAuditAsync`'s catch dead-letters it, and no
`set_config` runs and no row is written. On the pre-fix tree, in that
configuration:

| AC | pre-fix | post-fix | verdict |
|---|---|---|---|
| AC1 GUCs unchanged | **green** (nothing ran) | green | **vacuous** |
| AC2 no row visible in tx | green (zero rows) | green | vacuous half |
| AC2 exactly one row after | red (zero rows) | green | **red for the wrong reason** — the nesting guard, not the fold |
| AC3 rollback → no row | green (zero rows) | green | **vacuous** |

The plan's own instruction — "watch it be red for the reason claimed, not
because a fixture is wrong" — is defeated by a fixture detail the plan does not
name.

The same reading corrects the security framing. Probe `(b)`'s
`before={"b":null,"t":"bb5a70fe-…"}` is a **tenant** context, reachable there only
by calling `enqueueAudit` **directly**. At N3 — the one live member, confirmed by
four independent derivations — the context is a **bypass** context where
`app.bypass_rls` is already `'on'` and `app.tenant_id` already `NIL_UUID`
(`personalAuditBase` supplies no `tenantId`, so `resolveTenantId` does open, and
opens bypass-in-bypass, which is allowed). The only GUC the fold actually forges
there is **`app.bypass_purpose`**.

So the plan's headline — "Every subsequent statement in that transaction runs
with tenant isolation disabled" — is true of the probe's configuration and is
**not** what happens at any enumerated member. The escalation the probe
demonstrates has **zero live members**. The plan's conclusion that nothing is
exploitable on `main` holds, but for a stronger and different reason than the one
given ("no database statement follows the emit"), and the stated reason invites
the wrong test for a future emit ("is there a statement after it?") instead of
the right one ("is the enclosing context a tenant context?").

**Recommended action.** Recalibrate the Background section to what was measured:
the fold escalates only from a **tenant** context; reaching it through
`logAuditAsync` additionally requires `params.tenantId` to be supplied (otherwise
the existing guard fires first); there are zero such sites today; at the one live
member only `bypass_purpose` is forged. Keep probe `(b)` — it demonstrates the
mechanism is real — and add the bypass-context arm beside it. Then state each C2
AC's fixture precondition explicitly (`params.tenantId` supplied) and add the
second configuration, the live one, asserting `app.bypass_purpose` rather than
`app.bypass_rls`. Allow side: with `tenantId` supplied and no context active the
row is enqueued inline and a subsequently opened transaction's GUCs are clean —
pins a fix that defers unconditionally. Red-prove: run each pin on a pre-fix
checkout and record the exact failure text; a pin whose pre-fix failure mentions
`INVALID_RLS_NESTING` or `dead_letter` is measuring the wrong thing and must be
rewritten **before** any production edit. Fail loudly: a harness observing zero
rows *and* zero GUC change must fail with "fold not reached — check
`params.tenantId`", never report a pass. Preserve: the conclusion that the defect
is real and worth closing, and the existing behaviour that an unattributable emit
dead-letters rather than enqueues. Boundary/tie: `params.tenantId` present vs
absent, and tenant vs bypass enclosing context — all four cells named, with the
two that have no live member marked as such.

### M25 — Major (convergent: security+functionality) — SC1's Anti-Deferral and I2.2 both rest on a compensating control that is off by default

SC1 justifies accepting a best-effort `EMERGENCY_ACCESS_ACTIVATE` with "the
synchronous stdout line as the remaining record", and I2.2 calls that line "the
record that survives a database outage". It does not survive: `auditLogger` is
gated on `AUDIT_LOG_FORWARD`, which `src/lib/env-schema.ts:298` defaults to
`false` — so `auditLogger.info(...)` is a no-op in a default deployment. The tree
already says this in the very file C1 edits (`src/lib/tenant-rls.ts:90`).

Two compounding errors in one justification. First, on the crash path SC1 names
there is **no** record at all, not a degraded one. Second, the stated worst case
is too narrow: after C2 the drain is a new transaction on a new connection, so
pool exhaustion, a statement timeout or a transient DB failure at drain time also
loses the row — reachable under ordinary load, unlike a crash. Today the same
failure would have rolled the promotion back, because the enqueue was folded into
the promotion's transaction; after C2 the promotion commits and the audit does
not. The weakened operation hands a grantee the owner's escrowed vault key
material, and `personalAuditBase` carries no `tenantId`, so nothing else
attributes it. R5: one transaction was split into two and the atomicity invariant
was not re-verified for the resulting pair.

The weakening *itself* is defensible — post-commit best-effort is this tree's
normal contract for `logAuditAsync`, and the action is genuinely not in
`CRITICAL_ACTIONS`. What is not defensible is the reasoning offered for it (R29:
the reason licenses the next such deferral).

**Recommended action.** Replace the justification with the true residual: on
drain failure the record is a `deadLetterLogger.warn` line (always enabled,
unlike `auditLogger`); on process death between commit and drain there is **no**
record. Then decide against *that* — the security expert's recommendation is to
enrol `EMERGENCY_ACCESS_ACTIVATE` in `CRITICAL_ACTIONS` **in this PR**, because
C2 is what converts the site from accidentally-atomic to best-effort and it is
cheaper to keep it atomic than to re-derive the argument later. Allow side: a
grantee whose wait period elapsed still receives the vault payload on the first
GET, and the concurrent CAS loser still gets `not_eligible` with no audit row —
pin with exactly one `EMERGENCY_ACCESS_ACTIVATE` row per successful promotion
under two concurrent GETs. Red-prove separately: (a) delete the
`deadLetterLogger.warn` in the catch and confirm the drain-failure test goes
green — if it does, that test was not measuring the record; (b) force the drain's
`enqueueAudit` to reject and observe the promotion committed with no outbox row —
the fact SC1 trades away, observed rather than argued; (c) if `CRITICAL_ACTIONS`
is amended, remove the `logAuditInTx` call and confirm
`check-critical-audit-atomic.mjs` exits non-zero naming the action. Fail loudly:
the drain-failure test cannot distinguish "no row because the drain failed" from
"no row because the fixture never promoted" — assert `status = ACTIVATED` and
`activatedAt` positively first, and make the absence assertion marker-scoped, not
`tenant_id`-scoped. Preserve: `logAuditAsync`'s never-throws contract — an atomic
path must use `logAuditInTx` inside the route's bypass transaction, not make
`logAuditAsync` throw. Boundary/tie: the promotion's COMMIT — an audit failure
strictly before it fails the request, strictly after it does not; under
`logAuditInTx` the tie (both succeed or both roll back) is the property bought.

### M26 — Major — C3's fail-closed claim is false on the one path that matters most

C3's control-class paragraph — "a nesting site missed by the member-set
derivation becomes a **denied request**, not a silent one … which is why C4
exists" — is the argument the plan uses to license accepting a derivation with
known residuals. It does not hold for the audit path, the largest consumer of
`withBypassRls`-nesting: `resolveTenantId` opens `withBypassRls` and the entire
enqueue sits inside `try { … } catch { deadLetterLogger.warn(…) }`. A missed
nesting site reached from `logAuditAsync`/`logAuditBulkAsync` produces neither a
denial nor a 500 — it produces a swallowed `INVALID_RLS_NESTING`, a dead-letter
warn, and **no audit row**: silent in exactly the direction the paragraph says it
cannot be.

R52 in its literal form: C3 widens the guard into a newly covered population
whose principal caller neutralises the fail-closed direction, and the plan audits
neither the caller nor the swallowing catch against that population.

**Recommended action.** Restate the class honestly — enforceable boundary for
callers that propagate, best-effort for callers that swallow, with
`logAuditAsync`/`logAuditBulkAsync` named as the swallowing caller. Then close
the swallow: discriminate `INVALID_RLS_NESTING` from other errors and route it to
a distinct, alertable reason (`rls_nesting_at_emit`), not the generic
`logAuditAsync_failed` — a control violation and a database blip must not be
spelled the same in the dead-letter stream. Allow side: an emit failing for an
ordinary reason still takes the existing `logAuditAsync_failed` /
`invalid_user_id` arms and still does not throw; pin both reason strings by
assertion, not by "a dead-letter line was emitted". Red-prove separately: (a)
force `resolveTenantId` to throw the nesting error and assert the new reason —
then delete the discrimination and watch it redden; (b) force a generic DB error
and assert the old reason survives. Fail loudly: match on a **named error class**,
not a message substring — C3 must reword both current messages anyway (they name
only the cross-kind case), so a substring match will drift; the tree already did
this for `RlsSentinelContextRefused`. Preserve: requirement 8. Boundary/tie: "the
emit's own failure vs a violation of the tenancy control"; a dead-letter line
that cannot say which side it fell on is the tie that must not exist.

### M10 — Major (convergent: security+functionality) — I1.1 cites an enforcement C4 explicitly declines, and the R54 class is left with no static gate

I1.1 says the invariant is "enforced … statically by the forbidden pattern below
plus C4's gate". I4.3 says the opposite in its own words: the gate does **not**
flag folds and the outbox module "is covered by C1's forbidden pattern instead".
So C4 does not enforce I1.1, and I1.1 says it does.

Nor does anything else. `check-bypass-rls.mjs` classifies files through
`withBypassRls` call sites, and `audit-outbox.ts` contains none — its
`ALLOWED_USAGE` entry is already inert and C1 does not change that.
`check-rls-read-context.mjs` — whose subject is precisely "a statement against an
RLS-protected table with no active `tenantRlsStorage` store" — has scan roots
`src/workers`, `scripts/`, `src/lib/health.ts`, and its header singles out
`health.ts` as "the one `src/lib` member of this class that the ambient-Proxy
argument does NOT cover". **C1 creates a second one**: after C1,
`audit-outbox.ts` issues `auditOutbox.create`/`createMany` on `prismaBase`, a
client the ambient-Proxy argument by construction does not cover. That
enumeration becomes false the moment C1 lands.

Compounding it, the forbidden pattern is scoped to one *file* while the class is
defined by a *primitive* ("a raw `set_config('app.bypass_rls'|'app.tenant_id')`
on a client that may be the ambient one"). A second module doing the same
tomorrow is outside the pattern entirely. R3: the three worker instances satisfy
a *different* precondition (those processes establish no ALS store), which is
exactly the divergence R3 asks to be stated rather than assumed.

**Recommended action.** Add `src/lib/audit/audit-outbox.ts` to
`check-rls-read-context.mjs`'s scan roots and switch the module's three inline
`set_config` calls to the `setBypassRlsGucs(tx)` helper that gate already
recognises; update that gate's header, whose `health.ts`-is-the-only-one
enumeration C1 falsifies. Either extend C4 with a second, separately named
primitive-level rule or add a small dedicated gate — but do not leave I1.1 citing
C4; correct the claim to match whatever is built. Allow side: the gate is green
on `audit-outbox.ts` **and** `enqueueAudit` still writes a row — both, since a
green gate over a module that stopped writing is not the outcome; and
`tenant-rls.ts` plus the three worker files stay green via an explicit allowlist
keyed on the **precondition** ("this process establishes no ALS store"), not on
path coincidence. Red-prove separately: (i) delete a `set_config` line → gate red
naming the file; (ii) revert, remove the file from the roots, re-apply the same
mutation → gate green, the vacuous-green demonstration that the root widening is
load-bearing; (iii) add the same shape to a **new** file under `src/lib/` → the
file-scoped version of the rule passes it green, which is the clause separating a
class gate from a file gate; (iv) delete the allowlist entry for
`tenant-rls.ts` and watch it fail. Fail loudly: use `unresolvedTargets` so a
moved file is not spelled the same as a clean one, and report — never skip — a
`set_config` whose GUC name is not a literal; confirm whether an env override of
the roots can silently drop the new target, or state that as a limit. Preserve:
`enqueueAuditInTx`'s caller-supplied-`tx` path, which issues no `set_config` at
all — that is the discriminator to key on. Boundary/tie: "who owns the client the
GUC lands on"; `prismaBase` never establishes a context, `tx` inside its own
`$transaction` callback does, and a file containing both is judged per statement,
not per file.

### M27 — Minor — C1 AC2 corrects one of two false reasons in the docblock; C3 falsifies the second

`assertOpenableTenantContext`'s docblock gives two reasons it writes no audit
row. C1 AC2 corrects the first. The second — "without one, `resolveTenantId`'s
`withBypassRls` is refused by the nesting guard and the row is swallowed" — stops
being true because of C3: the nesting guard runs **before**
`assertOpenableTenantContext`, so once all four combinations are rejected,
reaching that function implies no context is active, and an emit from there would
neither fold nor be refused.

The docblock's conclusion is "It does NOT write an audit row, deliberately" — and
the refusal is a tenancy-control trip (someone attempted to open a context on
`SYSTEM_TENANT_ID`, which "hands the holder every unattributable audit row in the
deployment"). After this PR both stated blockers are gone and the event stays
visible only in `getLogger()` app logs.

**Recommended action.** Extend AC2 to both sentences and record whether the
refusal should now emit — recommendation: yes, `tenantId: SYSTEM_TENANT_ID`,
actor `SYSTEM_ACTOR_ID`; the sentinel actors exist for this and the "no
`req`/`userId`/`ip`" objection does not block a system-attributed row. Allow
side: `withTenantRls` must still refuse and throw `RlsSentinelContextRefused` —
adding an emit must not soften the refusal. Red-prove separately: (a) call with
the sentinel and assert the throw plus exactly one row; (b) delete the emit and
watch the row assertion redden; (c) confirm the emit cannot recurse. Fail loudly:
if `enqueueAudit` fails here, dead-letter — never swallow a tenancy-control trip.
Preserve: the guard-order comment, load-bearing for this argument. Boundary/tie:
the sentinel id under any spelling PostgreSQL accepts; the uppercase/unhyphenated
tie is already handled by the `UUID_RE` + fold.

### M28 — Minor — is `assertOpenableTenantContext`'s position after the widened guard preserved, and is the new population pinned?

C3 states neither the guard's new shape nor its position relative to
`assertOpenableTenantContext`, and the current order is deliberate and commented.
`src/lib/tenant-rls.test.ts:142-155` pins the order for the **old** population
only (a sentinel-carrying `withTenantRls` inside `withBypassRls`). The newly
covered combination — a sentinel- or non-canonical-carrying `withTenantRls`
inside `withTenantRls` — has no pin, and an implementation that hoists
`assertOpenableTenantContext` above the guard would pass every test the plan
lists while reclassifying that case from `INVALID_RLS_NESTING` to
`RlsSentinelContextRefused`.

*What answer closes it:* "C3 keeps `assertOpenableTenantContext` strictly after
the nesting guard, and the four-combination table includes one case carrying
`SYSTEM_TENANT_ID` and one carrying a non-canonical id, each asserted to throw
`INVALID_RLS_NESTING` and not `RlsSentinelContextRefused`."

**Recommended action.** State the order in C3 and add the two cases. Allow side:
a non-nested sentinel call still throws `RlsSentinelContextRefused` with
`refusal: SENTINEL` — the existing test covers this and must stay green.
Red-prove: swap the two statements and confirm each new case flips its error
class. Fail loudly: assert the error **class**, not a message substring — C3
rewords both messages anyway, so a substring assertion passes vacuously.
Preserve: the comment explaining why the order is what it is. Boundary/tie:
"nested AND sentinel"; the tie is which of two true refusals gets reported, and
the answer must stay "the outer defect".

---

## Testing Findings

### M16 — **Critical** — C2's unit acceptance criterion is a false-positive test by construction

The strategy nominates `src/lib/audit/audit.test.ts` for "deferral routing with a
faked context". That file replaces the entire `tenant-rls` module with a two-key
stub (`:12-15`, no `importOriginal`), and separately mocks `enqueueAudit`
(`:17-21`). A "faked context" there means the test authors `getTenantRlsContext`
to return an object it also owns, then asserts a thunk was pushed onto that same
object — RT1's identity assertion, with both halves test-authored.

The four invariants that matter are all outside what such a test can reach: that
the openers **create** the queue, that they **drain** it, that the drain runs
**outside** `tenantRlsStorage.run`, and that a throwing callback **discards** the
queue. A queue that is pushed to and never drained — audit events silently
dropped, the exact fail-mode C2 introduces — passes every assertion this venue
can make. RT5: no test on this path reaches the production primitive.

**Recommended action.** Move the routing pin to a venue that loads the **real**
`tenant-rls`. `src/__tests__/audit.mocked.test.ts:51-53` is the existing pattern
(`importOriginal` spread + a mocked `@/lib/prisma` whose `$transaction` is
`fn => fn(mockClient)`); real `withTenantRls` runs end-to-end against it today.
The assertion is **ordering**, not membership: `not.toHaveBeenCalled()` at the
moment the callback returns, `toHaveBeenCalledOnce()` after the opener resolves —
a pair no undrained queue can satisfy. Allow side: with no context active,
`enqueueAudit` is called **before** `logAuditAsync` resolves; pin it in the same
file so a deferral that swallows the no-context path fails. Red-prove separately,
one mutation each: (i) delete the drain → the after-resolve assertion reddens;
(ii) delete the deferral branch → the at-callback-return assertion reddens; (iii)
move the drain inside `tenantRlsStorage.run` → a `getTenantRlsContext()`
assertion inside the thunk reddens. Fail loudly: if `@/lib/tenant-rls` is stubbed
in the venue, the suite must fail by name — a `getTenantRlsContext` that is
`undefined` must not be silently read as "no context active". Preserve: the
never-throws contract and the synchronous `auditLogger.info` line (I2.2).
Boundary/tie: "context active at the moment `logAuditAsync` is entered"; state
that the decision is read once, at entry, and test entry-inside/resolve-after
explicitly.

### M17 — **Critical** — C3 AC4 (sign-in on a cache miss) has no venue that can satisfy it

The plan warns that "a test that only exercises the cached path would pass while
the flatten was wrong". It is worse: the only unit test of `createSession`
exercises **neither** path, because
`src/lib/auth/session/auth-adapter.test.ts:94-96` replaces the whole
`session-timeout` module. The two adjacent candidates are also blind —
`session-timeout.test.ts` stubs `@/lib/tenant-rls` with a passthrough factory
(structurally immune to C3's tightened guard), and
`src/__tests__/db-integration/session-timeout.integration.test.ts` calls the
resolver **directly**, never from inside `createSession`'s `withBypassRls`.

C3 is fail-closed on the sign-in path. If N2's flatten is done wrong, every
sign-in on a cold cache throws `INVALID_RLS_NESTING` and **no test in the tree
goes red**. That is the "no tests for critical path" row, on a path that is also
an operational-recovery path: a cold cache is exactly the state after a deploy.

**Recommended action.** Give AC4 a real venue — an integration test driving
`adapter.createSession` against the real DB with the module cache cleared in
`beforeEach` and the real `session-timeout` loaded. (Un-mocking inside
`auth-adapter.test.ts` cannot work: that file's `@/lib/prisma` mock does not
model a transaction.) Allow side: the **cached** path must also still create a
session — assert both cells in the same file, warm-cache × flattened and
cold-cache × flattened, and record that warm-cache × unflattened is green today
and would stay green if the flatten were wrong, which is why the cold-cache cell
is load-bearing. Red-prove: restore the inner `withBypassRls` at N2 and run the
cold-cache test — it must fail naming `INVALID_RLS_NESTING`; then run the
warm-cache test and confirm it still passes. A mutation that reddens both proves
the fixture, not the guard. Fail loudly: assert positively that the exported
cache `clear` was called; if the cache cannot be cleared the suite must fail
rather than run. Preserve: sign-in must still succeed — this remedy is entirely
on the allow side. Boundary/tie: the 60 s TTL — pin `expiresAt` exactly at
`Date.now()` (the `>` comparison puts it on the miss side) rather than relying on
wall-clock drift; a `sleep`-based miss is the race the common testing rules
forbid.

### M18 — Major — C1 and C2 break existing tests the plan does not name

Three concrete breaks:

1. `src/__tests__/audit-outbox.test.ts:36-40` mocks `@/lib/prisma` as
   `{ prisma: { $transaction } }` and imports the **real** `enqueueAudit`. C1
   makes it read `prismaBase`, which the mock does not provide → TypeError; all
   three `describe("enqueueAudit")` cases fail.
2. `src/lib/audit/audit.test.ts` and `src/lib/tenant/tenant-management.test.ts`
   load the **real** `audit.ts` while stubbing `@/lib/tenant-rls` to two keys. C2
   makes `audit.ts` import `getTenantRlsContext`, which is `undefined` there —
   either every emit dead-letters or a function documented as never-throwing
   throws.
3. `src/__tests__/db-integration/audit-logaudit-non-atomic.integration.test.ts`
   stays green but its stated premise inverts: its header calls itself a
   "negative test … proving the audit write is non-atomic", which after C2 is the
   **designed** behaviour. Nothing signals the drift.

More broadly, **175 test files mock `@/lib/tenant-rls`**; 13 use a bare factory
with no `importOriginal` and are structurally immune to both the C2 drain and the
C3 guard — four of them the `rotate-master-key` route tests, i.e. the
`CRITICAL_ACTIONS` set `check-critical-audit-atomic.mjs` exists to protect.

The consumer walkthrough enumerated four consumers of the persisted state and
omitted the largest one: the suite's mock surface.

**Recommended action.** Add the three files as named, pre-declared edits with the
change each needs, and enumerate the 13 by running the derivation rather than
trusting the list. Allow side: the ~150 `importOriginal` files must keep passing
unchanged — that is what shows the conversion is a mock-completeness fix, not a
behaviour change. Red-prove one at a time: land C1 alone, run
`npx vitest run src/__tests__/audit-outbox.test.ts` → red; add `prismaBase` to
the mock → green with no other edit. Same shape for C2 against
`src/lib/audit/audit.test.ts`. Fail loudly: a stub omitting a symbol `audit.ts`
now imports must fail loudly — do **not** write `getTenantRlsContext?.()` in
production code to tolerate it, which would convert a broken mock into a silently
inline path and make M16's false green permanent. Preserve: the never-throws
contract, and the direct-`enqueueAudit`-is-independent behaviour that
`audit-logaudit-non-atomic` pins. Boundary/tie: "real module loaded vs stubbed";
where both `tenant-rls` and `audit.ts` are mocked in one file (10 of the 13),
neither side is exercised — name those cells as deliberately uncovered rather
than leaving them looking covered.

### M19 — Major — C4 AC3's pre-fix red proof is satisfiable by the gate not existing

Verified: `git cat-file -e e780c75fe:scripts/checks/check-rls-nesting.mjs` →
path does not exist; `node` on an absent script → **exit 1**, byte-identical to a
violation exit; `git ls-files node_modules` → 0 entries, so a detached worktree
outside the repo cannot resolve `ts-morph` — also non-zero, also
indistinguishable. AC3 is passed by three flavours of "the check never ran".
RT7's sixth clause is unmet and Remedy Floor clause 3 is violated.

The sibling gates already solved this: `check-critical-audit-atomic.mjs` reads
`CRITICAL_AUDIT_ATOMIC_ROOT`, `check-null-tenant-fail-closed.mjs` reads
`NTFC_CHECK_ROOT`, and `sourceFilesFrom(project, targets, repoRoot)` takes the
root as a parameter for exactly this. C4's stated signature has no root
parameter.

**Recommended action.** Put the root override in C4's **signature**, not in the
test procedure, matching the sibling gates. The gate prints its resolved root and
scanned-file count on **every** run, and the self-test asserts the count is
non-zero — otherwise I4.2 catches only the empty-root case, not the wrong-root
case. Correct AC3's expected value: on the pre-fix tree the gate reports
**three** sites, not two — N3 is a live nesting site there by the plan's own
N-table and disappears only after C2. Allow side: the same invocation against the
post-fix tree exits 0 **and** reports the same non-zero scanned-file count; equal
counts with different verdicts is what separates "clean" from "scanned nothing".
Red-prove separately: (i) an empty root → refuse by name, not exit 0; (ii) the
pre-fix worktree → exit 1 naming three file:line pairs; (iii) delete the gate
file → the *harness* must distinguish ENOENT from a violation, e.g. by requiring
the gate's banner line on stdout before accepting an exit code. Preserve:
runnable with no environment set, from `pre-pr.sh`, defaulting to the repo root.
Boundary/tie: scanned-file count zero vs non-zero; when two roots yield the same
count, the printed root disambiguates — which is why it must be printed.

### M20 — Major — C4's red proof exercises only the direct-call arm; the transitive arm is never mutated

AC2's mutation re-introduces N1, which is the **only** lexical direct
opener-in-opener in `src/`. N2 and N3 are transitive, through an imported helper
and a three-hop chain. The gate's hard part — same-file-then-import resolution to
a fixpoint — is what catches them, and no mutation in the plan reddens it. A gate
whose transitive arm silently resolves nothing passes AC1, AC2 and AC4, and fails
only AC3 — which M19 shows is already satisfiable by a missing file.

**Recommended action.** Add a second mutation: a helper in a **different** file
that opens `withBypassRls`, called from inside an existing `withBypassRls`
callback; the gate must flag the call site and name the resolution chain. Add a
third at two hops, to prove the fixpoint iterates. Allow side: the
`tx`-passing shape (`derivePasskeyState`) must be **reported, not silently
skipped** (I4.1) and the report must be distinguishable from a confirmed
violation, so the two known-good sites do not fail the build — state which the
gate emits and how `pre-pr.sh` treats it. Red-prove each separately and confirm
each moves the count by exactly one. Fail loudly: an unresolvable callee produces
a named "unresolved" line and a non-zero exit — neither counted as a violation
(permanent noise) nor dropped. Preserve: I4.3's fold exclusion. Boundary/tie: hop
count — state the maximum depth explored and what the gate does at a **cycle**
(RT7's termination clause is unaddressed).

### M21 — Major — three of C3's five acceptance criteria are already green today, and the cells the new guard actually constrains are uncovered

`src/lib/tenant-rls.test.ts` already contains tenant-in-bypass rejected (`:215`),
bypass-in-tenant rejected (`:262`), sequential pair not rejected (`:292`), and
both openers opening normally with no context (`:32`, `:159`). Only
**tenant-in-tenant** and **bypass-in-bypass** can change state. The plan presents
all five as new work without saying which two are the non-vacuous ones — which is
how a reviewer reads "5 assertions added, all green" as evidence.

The RT10 gap is specific: the existing sequential test is a **cross-kind** pair.
The pairs C3 newly constrains are the **same-kind** ones — tenant-then-tenant and
bypass-then-bypass — and neither is covered. A naive implementation recording
"have we opened a tenant context in this request?" rather than reading the live
store would pass `:292` and fail only on the uncovered cells.

**Recommended action.** Mark the two new combinations explicitly and cite
`:215`/`:262`/`:292` as pre-existing so they are not re-counted as coverage. Add
the two missing same-kind sequential-allow cells, adjacency measured against the
predicate the code implements (`getTenantRlsContext() !== undefined` at entry),
not the old `bypass === true/false` one. Assert each of the four denials
individually, and record why: an `it.each` over four rows is satisfied by an
implementation that throws unconditionally — which is exactly what the paired
allow cases exclude. Red-prove: flip each new guard's condition back to the old
one-directional form, singly; exactly one denial test reddens per mutation and no
allow test moves. Fail loudly: the guard must throw **before**
`prisma.$transaction` is called — keep the existing `:251`/`:283` style
assertions that `$transaction` and `$executeRaw` call counts did not increase,
for the two new combinations too, since a guard throwing from *inside* the
callback would already have run `set_config`. Preserve:
`assertOpenableTenantContext` stays after the nesting guard (pinned at `:142`).
Boundary/tie: context-active at entry; the tie is two openers started
concurrently in the same async context via `Promise.all` — state which side that
falls on, since today's ALS semantics make it a nesting and no test covers it.

### M22 — Major — the N1 flatten and the N3 disappearance are unobservable in their own route tests

`src/app/api/teams/[teamId]/route.test.ts:53-57` mocks **both**
`withTeamTenantRls` and `withTenantRls` as passthroughs, and `mockWithTenantRls`
is never asserted on. Dropping the inner wrapper changes nothing that file can
see, in either direction.
`src/app/api/emergency-access/[id]/vault/route.test.ts:19-28` mocks
`logAuditAsync` **and** `withBypassRls` — N3's chain severed at both ends.

The two production edits C3 depends on land with no test that fails if they are
done wrong. N1's flatten in particular relies on the Proxy delegating
`prisma.<model>` to the ambient transaction — a behaviour these mocks do not
model at all. The plan's fallback ("the full suite and integration tests pass")
has, at these two sites, measured observing power of zero.

**Recommended action.** Pin N1 where the delegation is real: an integration test
deleting a team through the collect-then-cascade path, asserting the collected
refs match the rows that existed and observing the tenant GUC inside the
transaction — the statement the removed wrapper used to guarantee. Allow side:
team deletion still succeeds and still cascades; the risk of a flatten is a
dropped statement, not a leak. Red-prove: drop one of the statements the inner
wrapper enclosed → the test reddens naming the missing ref; if it stays green the
test is not pinning the flatten. Fail loudly: `withTeamTenantRls` throws
`TENANT_NOT_RESOLVED` when no tenant resolves — the test must fail on that rather
than treat "no refs collected" as a pass. Preserve: `withTeamTenantRls`'s public
signature (SC2) — the remedy is a test, not a contract change. Boundary/tie:
inside-vs-outside the tenant transaction for the cascade statements; when two
teams share a tenant, assert the cascade touched only the target team's rows.

### M23 — Major — a deferred emit can write an outbox row the integration harness is structurally unable to clean

C2 moves `resolveTenantId` to drain time, and it returns `SYSTEM_TENANT_ID`
whenever the user or team lookup misses. The harness cannot remove rows under
that tenant, by design: `helpers.ts:473-474` calls `refuseSentinel`, `:436`
returns early **unless** the tenant is the sentinel (its purpose is to refuse
it), and `:513`'s outbox cleanup is scoped to the one tenant handed in. So any
deferred emit whose actor has no resolvable tenant at drain time leaves a
permanent row in a table every other integration test reads — the mechanism
behind the steady-state background the plan's own fixture rule works around.

RT11. The plan says how to *measure* around sentinel residue but not how to
*avoid producing* it, and C2 is the change that moves resolution to a point where
the fixture's user row may already be gone.

**Recommended action.** Add a fixture precondition: for every C1/C2 pin the
actor's `users` row must exist **at drain time**, and the test asserts the
resolved tenant **is** the test tenant, not merely that a row exists. Add a leak
check in `afterAll`: sentinel-tenant `audit_outbox` count before and after the
file, asserting the **delta is zero** — a delta, not an absolute, since the
sentinel's rows are steady state. Register release at acquisition, in vitest's
`afterEach`/`afterAll` (which run on the failure path). Allow side: the
deliberate sentinel writers — the anchor publisher, the GC heartbeat, and the
unattributable-event path already pinned by
`audit-unattributable-tenant.integration.test.ts` — keep working and keep writing
under the sentinel; the delta check belongs in the C1/C2 files, not globally.
Red-prove: run a C2 pin with the actor's `users` row deleted before the drain →
the delta assertion reddens naming the sentinel tenant; restore → green. Fail
loudly: a pre-count query returning no row at all (table missing, RLS denial)
fails rather than counting as zero. Preserve: `refuseSentinel` stays — the fix is
to stop producing the rows, never to let the harness delete under the sentinel.
Boundary/tie: whether the actor resolves to a tenant at drain time; compute the
delta per file with the workers stopped (VE1), or a live worker's drain moves the
count underneath it.

### M24 — Minor — does C4's fixpoint terminate on a call-graph cycle?

C4 computes a may-reach fixpoint over a name-resolved call graph. The plan states
the registry contents and resolution order but says nothing about mutual
recursion. RT7's terminating clause is unaddressed, and a gate that hangs in
`pre-pr.sh` is neither pass nor fail.

*What closes it:* a stated visited-set, a self-test fixture containing a two-node
cycle asserting the gate terminates and reports, and a wall-clock bound in
`pre-pr.sh` so a hang is spelled as a named refusal rather than a stalled queue.

### M12 — Minor (convergent: functionality+security+testing) — two quoted figures are subject-dependent and not reproducible from a durable artifact

"35 fold sites" and "2826 registered functions" did not reproduce for any expert
(33 / 33 and 2788 / 2794 / 4178 respectively). **Reconciled by the orchestrator:**
35 = 33 direct `prisma.$transaction` **plus 2 transitive** (`replaceScimUser`,
`deactivateScimUser` in `scim-user-service.ts`). Both numbers are correct for
different subjects, and the registry counts differ because the scans included
different roots. This is the "numbers measured on a different subject" class, and
neither figure changes any decision: I4.3's conclusion holds at 33 as it does at
35.

Compounding it, AC4 asks the reviewer to "read the count" from a gate that, when
green, reports violations only — there is nothing to read.

**Recommended action.** Drop both figures rather than reconcile them in prose, and
have the gate print a positive census on every run
(`root=… files=N opener-callbacks=N folds-ignored=N violations=N`). AC4 then
becomes "folds-ignored is non-zero and violations is zero", which is checkable,
and the number acquires a durable source. Allow side: the census must not become
a build-failing threshold — a legitimate new fold site is normal. Red-prove: add
a fold site in a scratchpad copy and confirm the printed count moves by one. Fail
loudly: `files=0` prints as an error, not a clean run. Preserve: I4.3's
exclusion. Boundary/tie: `$transaction` reached through an alias
(`const db = prisma`) — decide whether the count includes it and say so beside
the number.

---

## Adjacent Findings

- **[Adjacent] Major (functionality → security): SC1's weakening at N3 is a security-scoped judgement.** From a functionality standpoint the deferral is defensible; whether an emergency-access *activation* belongs in `CRITICAL_ACTIONS` is a security call. Flagged so it is not read as accepted by both reviewers because each assumed the other owned it. **Routed to M25**, where the security expert made the call: enrol it.
- **[Adjacent] Major (testing → security): the probe did not make the observation the live member needs.** **Routed to M15.**
- **[Adjacent] Major (testing → functionality): `withUserTenantRls` / `withTeamTenantRls` open a bypass context (via `resolveUserTenantId` / `resolveTeamTenantId`) *before* the tenant one**, so under C3 a call to either from inside an existing context throws at the bypass step, with a different error and at a different site than the N-table implies. The fourth agent's sweep confirms **no such call exists today** (none of the four names appears in the 177-name in-region callee set), so this is a correction to the N-table's predicted failure mode, not a missed member. **Routed to M5's remedy** (the gate's opener seed set) and to C3's residual paragraph.
- **[Adjacent] Minor (functionality → security): `tenantRlsStorage` is exported.** C2 and C3 both name `getTenantRlsContext()` as the sole adjudicator (R48). Any module can call `tenantRlsStorage.run(...)` to fabricate a store, thereby suppressing the fold **and** falsely satisfying the guard's "no context" precondition. No non-test caller does today. Worth one sentence in C3 recording that the adjudicator's authority rests on the export not being used elsewhere.
- **[Adjacent] Minor (security → functionality): floating `void logAuditAsync` inside an open `$transaction`** at `src/workers/audit-anchor-publisher.ts:227` (transaction opened at `:152`) — R9's shape, pre-existing and outside this plan's contracts. Benign today for a second, independent reason the fourth agent established: every publisher emit supplies an explicit `tenantId`, so `resolveTenantId` early-returns and opens nothing. That safety is a property of the call arguments, not of the nesting guard — dropping any of those `tenantId` fields makes it a silent nested-transaction bug the new guard would **not** catch. Record as a follow-up; do not fix here.

## Quality Warnings

None. All three experts grounded every finding in a file and line or in an
executed command, and each ungrounded requirement was filed as a Minor question
with its closing answer stated, per the Finding Floor.

---

## Recurring Issue Check

### Functionality expert

| ID | Status |
|---|---|
| R3 | F1 (pattern applied without enumerating its existing matches), F5 (C3's derivation does not confirm each target satisfies the same preconditions) |
| R5 | Checked — C2 splits one transaction into business-tx + post-commit outbox-tx; the plan re-verifies the atomicity invariant per sub-transaction at N3 (SC1) and states requirement 3 for the rollback case. See F8 for the ordering caveat and F3 for the dead-letter arm the split moves. |
| R9 | Checked — I2.3 awaits the drain; requirement 6 states it. F2 records the residual (a detached emit whose push lands after the drain), F4 the per-thunk isolation gap. |
| R10 | Checked — the opaque-thunk queue keeps `tenant-rls.ts` free of any `audit/*` import; `audit.ts` → `tenant-rls.ts` is the existing direction (`src/lib/audit/audit.ts:69`). No cycle. F13 notes the type-export question, which is type-only and creates no runtime edge. |
| R12 | N/A — no new `AUDIT_ACTION` value, no action-group / i18n / UI-label surface touched. |
| R13 | N/A — no delivery-failure event path is changed. |
| R29 | F7 (false connection-pool member set), F10 (command returns nothing as written), F11 (33 vs 35), F8 (probe `(d)` cited for a claim it does not establish). Reproduced and confirmed: 1 in-context emit, 0 lexical, 3 nesting sites + 2 non-members, 7 `CRITICAL_ACTIONS`, 2 outbox-module transaction hits, 126 `withTenantRls` call sites. |
| R36 | F1 (the pattern's two false positives will be answered by softening it), F6 (an undeclared suppression set is where the narrowing lands) |
| R42 | F1, F5, F6, F9. C2 arm (a)/(b) and C3's table reproduce exactly; the gaps are the forbidden patterns' member sets, C3's residual, and the consumer enumeration. |
| R47 | Checked — C1/C2/C3 all adjudicate through `getTenantRlsContext()`, the same store the Proxy consults, rather than through a name in the source; C1's authority is `txid_current()` on the engine. Highest available rung. F1 is the one place the plan drops to surface form (a text pattern deciding a scope question). |
| R48 | Checked — one adjudicator per predicate. The deferral decision and the fold decision both read the ALS store. F2 notes the one timing divergence (C2 reads the store at emit-call time, the Proxy at property-read time) and it is benign in the awaited case. |
| R49 | Checked — all four contracts declare a class. C1 "enforceable boundary": justified, the fold is structurally unreachable on `prismaBase`. C2 "enforceable boundary": justified for awaited callers, **overstated for detached ones** — F2; the honest class for the detached path is best-effort until the seal exists. C3 "enforceable boundary" with the fail-closed cost stated: accurate. C4 "fail-closed verification gate, not a boundary": accurate, but F6 shows the implementation cannot deliver I4.1 as specified. |
| R50 | F6 (a gate whose reported-unresolvable count is unstated cannot distinguish "examined" from "examined nothing"), F11 (subject identity — the quoted 35 was measured on a script whose subject I could not confirm), F14 (input resolution — the new bare-client site resolves to no gate's scan root). C4 AC3's pre-fix-tree red run addresses run isolation and reviewability well. |
| R52 | Checked — C3 widens the nesting guard from 2 of 4 combinations to 4 of 4. The plan re-audits the newly covered population (N1/N2/N3 + the two non-members) and states the fail-closed cost. F5 is the residual: the widened control's decision path was not audited against the value-passed-callback population. |
| R54 | Checked — this is the defect the plan exists to close; probe `(b)` is the evidence. C1 scopes the GUC grant to `prismaBase`'s own transaction, C2 removes the in-context emit, C3 makes the leak unreachable. F8 records that the "same context immediately after the sanctioned call returns" test must be run *after* C3, not after C2 alone. |

### Security expert

| ID | Status |
|---|---|
| R3 | F4, F6 — the `set_config`-on-ambient-client pattern was propagated by file, not by primitive; the three worker instances satisfy a different precondition that the plan does not state. |
| R5 | F1 — C2 splits one transaction into two; the `EMERGENCY_ACCESS_ACTIVATE` atomicity invariant is re-verified per sub-transaction only in prose, and against a false premise. |
| R9 | F3 (structural — the drain is awaited, but a late push is dropped silently), F12 (pre-existing, adjacent). |
| R10 | Checked. The opaque-thunk design (`Array<() => Promise<void>>` on the context) is sufficient: `src/lib/tenant-rls.ts` imports only `constants/app` and `logger` today, and `audit.ts → tenant-rls.ts` is the existing direction. No cycle introduced. |
| R12 | N/A — no new `AuditAction` value is added. |
| R13 | N/A — no delivery-failure event path is touched. |
| R29 | F1 (compensating control that does not exist), F6 (false reason, true conclusion), F7 (probe conclusion generalised past its measurement), F9 (two figures do not reproduce). Load-bearing figures 2/1/0/3+2/7/126 all reproduce exactly. |
| R36 | F4 — C1 moves `audit-outbox.ts` off `prisma`, and the file's already-inert `check-bypass-rls.mjs` ALLOWED_USAGE entry (`:94`) stays inert; the module gains no static coverage from the change, and I1.1 claims it does. |
| R42 | F5 (derivation method: five opener call sites with non-inline callbacks are outside the walk, all manually cleared). Member sets themselves re-derived independently by two differently-structured AST scans and by the primitive-level `set_config` sweep — **no member in `mine \ plan's`**. |
| R47 | F5 — C4 decides a runtime (AsyncLocalStorage) question from the parse tree; the plan correctly climbs to the runtime guard (C3) as the authority, but the gate's surface-form rung has an unstated hole. |
| R48 | Checked. C2, C3 and the Prisma Proxy all read `getTenantRlsContext()` as the single adjudicator; the plan states this explicitly and it is true of `src/lib/prisma.ts:167` and `src/lib/tenant-rls.ts:106-108`. |
| R49 | F2 (C3's fail-closed class false on the audit path), F3 (C2's enforceable-boundary class contradicted by its own forbidden pattern), F4 (I1.1 cites an enforcement C4's I4.3 declines). C4's own class declaration — fail-closed verification gate, explicitly *not* a boundary — is accurate. |
| R50 | Checked, with F5 as the exception. C4's acceptance criteria cover exit status (non-zero on violation), positive input resolution (I4.2 / `unresolvedTargets`), subject identity (red on the pre-fix tree for N1 and N2), run isolation (VE1's worker-stop precondition), and reviewability. The unresolvable-*callback* outcome is the one route to neither-pass-nor-fail that is unrouted. |
| R52 | F2 (the widened `withBypassRls` reaches a population whose caller swallows the denial), F10 (the decision path's ordering relative to `assertOpenableTenantContext` is unstated and unpinned for the newly covered combinations). |
| R54 | Checked — the core claim verified and the remedy judged sound. C1 does not relocate the suspension: `prismaBase` (`src/lib/prisma.ts:163`) is outside the Proxy's fold arm (`:177-183`), and `set_config(..., true)` is transaction-local, so the GUC reverts at the enqueue transaction's end and never reaches the pooled connection — corroborated by `scripts/checks/check-rls-read-context.mjs:6-9`. C1 AC1 tests the invariant in the same context immediately after the sanctioned call returns, as R54 requires. |

### Testing expert

| ID | Status |
|---|---|
| R3 | Checked — F4 (mock-pattern propagation across 175 files; 13 stub targets whose preconditions differ), F9 |
| R5 | Checked — C2 splits one commit into commit-then-drain; requirement 3 and I2.2 re-verify the atomicity claim per sub-transaction. No finding; SC1's Anti-Deferral covers the one weakened site. |
| R9 | Checked — I2.3 awaits the drain; the `void .*logAudit` forbidden pattern covers the call sites. No finding. |
| R10 | Checked — the opaque-thunk shape preserves `audit.ts` → `tenant-rls.ts` and adds no reverse import. No finding. |
| R12 | N/A — no new action value. |
| R13 | N/A — no delivery-failure event introduced. |
| R29 | F10 (broken grep, exit-1 silence), F12 (35 not reproducible; I measured 33), Adjacent-1 (probe conclusion outside its observed configuration) |
| R36 | Checked — C3's `allowNested\|skipNestingGuard\|force.*[Nn]esting` forbidden pattern is the right shape and is pre-emptive rather than reactive. No finding. |
| R42 | F9 (opener set: `withVaultTenantRls`, `resolveUserTenantId`, `resolveTeamTenantId`; grep returns 8 for 4), F6 (transitive arm unproven). C1's two-member outbox set and C2's "0 lexical in-context emits" both reproduce — my AST scan over 567 opener callbacks returns 0 lexical emits and 1 lexical opener-in-opener (`src/app/api/teams/[teamId]/route.ts:157`), matching the plan. |
| R47 | Checked — F10 is the instance: the plan adjudicated a member set by a surface-form grep whose interpreter (BRE vs ERE) changes the result. Reported there rather than duplicated. |
| R48 | Checked — C2 and the Proxy both read `getTenantRlsContext()`; one adjudicator, correctly argued. No finding. |
| R49 | Checked — C1/C2 "enforceable boundary" and C4 "fail-closed verification gate" both match what the described implementation delivers. C4's self-declared non-boundary status is correct and is why F5 is Major rather than Critical. |
| R50 | F5 (subject identity + input resolution: ENOENT and missing `node_modules` both spelled as red), F10 (exit status), F12 (positive input-resolution assertion missing) |
| R52 | Checked — C3 widens the guard's reach from 2 of 4 combinations to 4 of 4. The control itself (`getTenantRlsContext()` at entry) and its decision path were re-read against the newly covered population; F3 is the finding that the newly denied population includes the sign-in path with no test. |
| R54 | Checked — this is the defect C1/C2 close; the fix scopes the GUC suspension to `enqueueAudit`'s own transaction on `prismaBase`. Correctly framed. |
| RT1 | F1 (faked ALS context makes the deferral assertion an identity) |
| RT5 | F1 (no test on the deferral path reaches the real `tenant-rls`), F3 (`session-timeout` mocked out of `createSession`'s only test) |
| RT7 | F5 (clause 6 — subject not loaded), F6 (clause 4 — transitive arm unmutated), F13 (termination) |
| RT10 | F3 (warm/cold cache cells), F7 (same-kind sequential-allow cells uncovered; cross-kind already green), F6 (the `tx`-passing allow shape) |
| RT11 | F11 (sentinel-tenant outbox residue the harness refuses to clean) |

---

## Round 1 disposition

**Saturation does not apply.** Criterion 2 is unmet — 3 Critical and 20 Major
findings are open — and criterion 3 is unmet: M2, M5, M6, M10, M15, M26 are
against the design itself (control classes, invariants, and the adequacy of the
acceptance criteria), not against prose.

Revision 2 of the plan addresses all Critical and Major findings; Round 2
follows.

---

# Round 2 (incremental)

Date: 2026-09-05

## Changes from Previous Round

Revision 2 of the plan addressed all 31 Round 1 findings. It added a new contract
C0 (`EMERGENCY_ACCESS_ACTIVATE` becomes an atomic audit), recalibrated the
Objective and Background, added five invariants to C2, restated C3's control
class with a discriminated dead-letter, substantially redesigned C4, moved C1's
enforcement citation from C4 to `check-rls-read-context.mjs`, replaced the test
venues, and deleted two unreproducible figures.

## Resolution of Round 1 findings

**Resolved (21):** M1, M3, M4, M7 (member set), M8 (partially — see N6), M9,
M11, M12, M13, M14, M16, M17, M19, M20, M21, M23, M27, M28, M29, M30, and M15's
Objective half.

**Partially resolved (7):** M2 (seal added, premise false → N3), M5 (C3 resolved,
C4 gap → N4), M6 (census answers the count half, mechanism not constructible →
N4), M18 (rule cannot find the file C0 breaks → N14; prescribed edit insufficient
→ N13), M22 (N1 resolved; N3's venue now *fails* → N14), M24 (declared, not
bounded → N16), M15 (AC half unresolved → N11).

**Unresolved — the defect moved rather than went away (1):** M10 → **N1**.

## Merged findings — 1 Critical, 15 Major, 9 Minor

### N1 — **Critical** (convergent: functionality+security+testing) — I1.1's enforcement claim is still false; the newly cited gate cannot decide the predicate, and the prescribed helper does not exist

Three experts independently enrolled `audit-outbox.ts` in
`check-rls-read-context.mjs` on scratchpad copies and ran it. Every table agrees:

| Mutation | Verdict |
|---|---|
| verbatim pre-C1 (`prisma.$transaction` + inline `set_config` ×3) | **exit 0** |
| post-C1 (`prismaBase.$transaction` + `setBypassRlsGucs`) | **exit 0** |
| revert `prismaBase` → `prisma` — the exact defect C1 forbids | **exit 0** |
| delete `setBypassRlsGucs` in `enqueueAudit` | **exit 0** |
| delete every GUC setter (bulk path) | exit 1 |
| bare `prisma.auditOutbox.create` at top level | exit 1 |

Two mechanisms. `enqueueAudit`'s only RLS-table statement lives inside
`enqueueAuditInTx`, whose `tx: Prisma.TransactionClient` annotation satisfies the
gate's `TX_TYPE_RE` unconditionally — that callback has nothing the gate can
judge. And the gate never reads the *receiver* of `$transaction`, so `prisma` and
`prismaBase` are indistinguishable to it. The gate's predicate is "is a GUC
established on this receiver"; I1.1's predicate is "which client opened the
transaction". They are different questions.

Compounding, both independently verified: **there is no shared
`setBypassRlsGucs`** — the only definitions are module-private in
`src/workers/audit-outbox-worker.ts` and a test helper — so C1 must *create* one
(with a bundling constraint: a worker-only import must not reach the app bundle).
And the gate's helper branch matches `callee.getText() === "setBypassRlsGucs"`,
a **name-only** test that a locally-declared no-op satisfies, whereas the inline
form C1 replaces is decided by reading the actual SQL and receiver. The switch
*weakens* the recogniser on this module.

Round 1's M10 asked for the claim to be corrected "to match whatever is built".
Revision 2 moved the citation from C4 to a second gate without checking that the
new citee decides the predicate, and repeated the claim. **This is the second
round in which a control class rests on an enforcement that declines to provide
it (R49/R50/R36), and C1's acceptance criterion is green on the tree before C1
lands.**

**Recommended action.** Split the claim. `check-rls-read-context.mjs` enrolment
is a *second, independent* control (bare-client statements in the module) worth
keeping on its own terms — it catches a top-level `prisma.auditOutbox.create`.
I1.1's client-identity half is **app-enforced, not gate-checked**, unless a
receiver-level rule is built: report `$transaction` on a binding resolving to the
`prisma` export from within `src/lib/audit/`. Say which, and give the forbidden
pattern a named runner — `scripts/pre-pr.sh` has no generic forbidden-pattern
step, which is M1's unresolved shape reappearing on a second contract.

### N2 — Major (convergent: functionality+security+testing) — `EMERGENCY_ACCESS_ACTIVATE` has a second production emitter that C0 leaves best-effort behind a green gate

`src/app/api/emergency-access/[id]/approve/route.ts:56` emits the same action via
`logAuditAsync`, on the **success** path immediately after a CAS `transition()`
to `ACTIVATED` — the owner's early-approval route, same state change, same
consequence (the grantee can now fetch the escrowed key material).

`check-critical-audit-atomic.mjs` is **action**-scoped and requires the action to
appear as the `action:` of **at least one** `logAuditInTx` call. Verified by
execution on a synthetic root: one atomic site plus one async site → **exit 0**.
So after C0 the gate prints OK, which reads as "this action's audit is atomic",
and half its emitters are not.

R42 in its plainest form: C0's invariant is quantified over an action, its member
set is two sites, and the plan derived one — the same failure the plan flags in
others. The approve route is structurally harder (its `transition()` runs inside
`withUserTenantRls`, whose callback hands out no `tx`, so atomicity there needs
SC2's threading). Either do it or record it as a knowing residual **where a
reader of the green gate will find it**; silence is what is unacceptable.

### N3 — Major (convergent: functionality+security) — I2.5's seal rests on a premise both experts measured false

I2.5 says a post-drain push "runs inline (safe: no context transaction is live)".
The transaction is dead; **the ALS store is not**. Both experts ran it:

```
drain ran; ctx during drain = undefined
push AFTER seal -> inline path; ctx at that moment = {"tenantId":"T","bypass":false}
```

A continuation started inside the opener callback still reads the store
afterwards. Consequences: with `params.tenantId` **absent**, the inline path
calls `resolveTenantId`, whose `withBypassRls` sees a live store and — after C3 —
throws in all four combinations: zero rows, one dead-letter. With `tenantId`
**supplied**, it writes a row, but only *after C1*, because pre-C1 the Proxy
folds it onto the closed `ctx.tx` and Prisma throws.

So **AC7 is unsatisfiable as written** — it will be made green against a
fabricated fixture (a late push with no ambient store) or by silently supplying
`tenantId`. And the seal is described as a C2-internal property when it is a
**C1 → C2 dependency** the ordering statement does not name.

**Recommended action.** Restate the reason (the safety comes from C1 putting
`enqueueAudit` on a client the Proxy does not rebind), split AC7 into its two
cells with the outcome of each stated, and consider having the fallback escape
the store (`tenantRlsStorage.exit(...)`) so the fallback means what its name says.

### N4 — Major (convergent: functionality+testing) — I4.1's reuse of `check-bypass-rls.mjs`'s client-binding resolution is not constructible, and it contradicts SC3

`clientBindingsIn` is a plain `function` in a script with **zero exports**. C4's
three options are: extract it (a modification to the gate SC3 declares out of
scope), duplicate it (a second adjudicator for "is this receiver a Prisma
client" — R48), or re-implement narrower (the hand-written list I4.1 exists to
avoid). The plan names none.

Worse, the resolver answers I4.1's own question the opposite way: its header
states *"where the tree cannot prove the mapping, the call is **SKIPPED, not
reported**"* — 38 imported-callee sites today. I4.1 is precisely a rule about
what to do with an unresolvable callee.

Related, same axis: C4 asserts its computed closure "contains
`withVaultTenantRls`", but that name is a **local const inside two different
route handlers**, so a name-set assertion is satisfied by finding either one.
Assert `(file, name)` pairs.

### N5 — Major — I3.2 requires a named error class that neither the tree nor C3 provides

`INVALID_RLS_NESTING` is thrown as a bare `Error`; the only named class in the
module is `RlsSentinelContextRefused`. C3's text says signatures are unchanged
and "both messages are reworded" — it never says a class is introduced. The
implementer therefore has nothing to `instanceof` against and falls back to a
substring match against a message C3 rewords in the same commit: exactly the
drift I3.2 exists to prevent, failing in the direction where a tenancy-control
violation is spelled as a database blip.

Put the class in C3's signature block, modelled on `RlsSentinelContextRefused`,
and keep the `INVALID_RLS_NESTING:` message prefix so the four existing
message-based assertions in `src/lib/tenant-rls.test.ts` stay green — otherwise
the rewording is a fifth unannounced test edit.

### N6 — Major — the ordering statement omits the C0 → C3 and C1 → C2 edges

"Technical approach" names one constraint (C3 must land with C2) and the
Go/No-Go table carries no order. But N3 is bypass-in-bypass, which the guard
**allows today** and C3 makes throw. With C3 applied and C0 not yet applied,
every emergency-access auto-promotion produces **zero audit rows and one
dead-letter** — an intermediate state that destroys the audit trail for the
operation that releases escrowed key material, caught by nothing (the route test
mocks both `logAuditAsync` and `withBypassRls`). The C1 → C2 edge is N3's.

State both edges, and make the range bisectable: `npx vitest run` and
`npm run test:integration` must pass at **each** commit, not only at the tip.

### N7 — Major — I2.6's tie is reachable, the seal/drain boundary is unnamed, and neither I2.6 nor I2.3 has an acceptance criterion

Executed (a 10 ms detached push against 30 ms thunks):

```
snapshot   : drained=1 left-behind=["LATE"]
until-empty: drained=2 left-behind=[]
```

So I2.6 is not dead weight — the two plausible drain implementations differ
observably and the wrong one silently drops the event. But I2.5 and I2.6 do not
compose: nothing says **where the `sealed` flag flips relative to the
`while (queue.length)` check**. Flip it before the loop and I2.6 is unreachable;
flip it after with any `await` in between and a push landing in that window is
queued and never run — the exact silent loss C2 exists to prevent. Specify the
flip in the same synchronous turn as the final emptiness check, and give I2.6 and
I2.3 acceptance criteria.

### N8 — Major — the connection-pool rationale's *replacement* reason is false, on a different axis from the one Round 1 corrected

Revision 2 replaced M7's false member set with: "with no context the Proxy falls
through to the base client, so `prisma` and `prismaBase` are the same object".
Both halves are wrong: `prisma` is a `Proxy` **over** `baseClient` and
`prismaBase` **is** `baseClient` — different objects that forward to the same
target. And materially, at the three publisher sites the emit's transaction was
never on the singleton: `AuditAnchorPublisher` holds its own `PrismaClient` built
from its own adapter and pool, so those sites already hold two connections from
**two different pools**, before and after C1.

R29 in the form the rule exists for: a true conclusion now resting on its
**second** false reason.

### N9 — Major (convergent: functionality+security) — C0 breaks `check-critical-audit-atomic`'s own self-test, and T17 already pins C0's first acceptance criterion

`scripts/__tests__/check-critical-audit-atomic.test.mjs` holds a hard-coded seven-entry
`ALL` list ("Must match CRITICAL_ACTIONS in the gate") and asserts
`stdout` contains `"all 7 security-critical actions"`. C0 reds both. Revision 2
pre-declares three test edits for C1/C2 and none for C0 — the newest contract
inherited none of that lesson (R3). Note the trap: updating only the count string
leaves the mirrored list one short and the self-test still passes.

Separately, `centralize-state-transitions.integration.test.ts` (T17) **already**
implements C0's concurrency criterion against the real `autoPromoteIfElapsed`
under two real `withBypassRls` scopes. C0 presents it as new work, and its
comment ("logAuditAsync is async / outbox-based, so we poll until the worker
drains") becomes false the moment C0 lands. Mark it pre-existing coverage the way
C3 does for the `tenant-rls.test.ts` pins.

### N10 — Major — C0's atomicity is one-directional: two exit paths commit `ACTIVATED` with no audit row

C0 declares its adjudication authority as "both rows commit or neither does".
That holds for emit-then-fail. It does not hold in the other direction:
`transition()` flips `REQUESTED → ACTIVATED` **inside the caller's transaction**,
and two exits then return before the emit — `revokedAt !== null` and
`!encryptedSecretKey || !granteeKeyPair`. Neither throws; the route returns 403
and the enclosing `withBypassRls` **commits**. The grant is `ACTIVATED` with
`activatedAt` set and no audit row — before C0 and after it.

Pre-existing, but C0 is the contract that declares the invariant, and it declares
a biconditional while delivering an implication. Either restate the authority as
the implication with the residual recorded, or hoist the emit above the two
checks so it covers every path on which the CAS succeeded — the stronger fix,
costing nothing structurally since the emit is already inside that transaction.

### N11 — Major (convergent: testing+functionality) — 6 of C2's 9 pins cannot be red pre-fix under a mandatory pre-fix-red rule, and AC3 is still vacuous in its assigned venue

| AC | pre-fix | verdict |
|---|---|---|
| AC1 GUCs unchanged | GUC mismatch | red, right reason |
| AC2a no row within tx | count 1 ≠ 0 | red, right reason |
| AC2b one row after | — | green pre-fix |
| AC3 rollback → no row | — | **green pre-fix — still vacuous** |
| AC4 bypass, purpose unchanged | purpose mismatch | red, right reason |
| AC5 no context → inline | — | green pre-fix |
| AC6 `logAuditInTx` unchanged | — | green pre-fix |
| AC7 seal / AC8 isolation | queue does not exist | not runnable pre-fix |
| AC9 malformed id | — | green pre-fix |

The plan makes the pre-fix red proof a hard, universally-quantified gate. Only
three pins can satisfy it. AC3 in particular: with `tenantId` supplied the emit
folds into the caller's transaction, so a rolling-back callback discards the row
**pre-fix and post-fix** — identical observable in the integration venue the plan
assigns it to.

**Recommended action.** Classify each pin as *discriminating* (red pre-fix) or
*regression* (green both ways) and narrow the mandatory clause to the first set;
add the missing outcome — a pin declared discriminating that comes up green
pre-fix must fail the procedure **by name**. Move AC3 to
`src/__tests__/audit.mocked.test.ts`, where it becomes discriminating:
pre-fix a throwing callback still leaves `mockEnqueueAudit` called once, so
`not.toHaveBeenCalled()` is red **for the fold**, not for a dead-letter.

### N12 — Major — C4's census prints `unresolved=N` and no criterion pins it

I4.6's own justification is that a resolution change silently dropping 900 calls
to zero produces the same "no violations" as a clean tree. The criteria then
assert only `files` and `folds-ignored` non-zero. Round 1's M6 remedy was
explicit: publish the expected count, fail on drift in **either** direction, with
three mutations moving it by known amounts. None became a criterion. Put the
equality assertion in the gate's **self-test against a pinned fixture root** (not
as a live-tree threshold, where a legitimate new opener callback would red the
build).

### N13 — Major — the prescribed edit to `src/lib/audit/audit.test.ts` is insufficient and its natural repair restores the blind stub

The plan prescribes converting that file's `@/lib/tenant-rls` stub to the
`importOriginal` spread. Applied literally, that makes `withBypassRls` **real** —
and the file's `@/lib/prisma` mock provides only `{ user, team }`, with no
`$transaction` and no `$executeRaw`. Every `resolveTenantId` then throws, the
catch dead-letters, and the file's enqueue assertions invert. The correct edit is
spread **and keep** the explicit `withBypassRls` override (the shape the vault
route test uses), or spread and complete the prisma mock. The shortest path back
to green from the red suite is to restore a bare `getTenantRlsContext` stub —
re-creating the exact false green M16 removed, in the co-located twin of the
venue M16 moved the pin to.

### N14 — Major — C0 breaks the vault route test in three places, and the plan's derivation rule for pre-declared edits cannot find it

`src/app/api/emergency-access/[id]/vault/route.test.ts` uses the `importOriginal`
spread for `@/lib/tenant-rls`, so it is **not** in the class the plan's derivation
rule scans. It breaks anyway on C0, through two different mocks: the
`@/lib/audit/audit` factory supplies no `logAuditInTx`; the `@/lib/prisma` factory
supplies only `emergencyAccessGrant`, so the grantee-tenant lookup is
`undefined.findUnique`; and `enqueueAuditInTx` issues two `$queryRaw` calls the
mock has no method for. Two tests drive the promotion path, so these are live
failures. Widen the rule from "files with a bare `@/lib/tenant-rls` factory" to
"files whose factory mock of any module C0/C1/C2 newly imports from omits the new
symbol" — and run it rather than listing it.

### N15 — Major (convergent: testing+security) — C0 introduces a denial path with no acceptance criterion and an unstated tenant-resolution fallback

`logAuditAsync` never throws; `logAuditInTx` does — `enqueueAuditInTx` throws on
its GUC precondition and on a missing `tenants` row. After C0 those propagate to
a 500 where today the grantee receives the payload and the audit is lost. C0's
four criteria cover concurrency, rollback, the gate mutation and the allow side;
the **new denial cell is unclaimed** (RT10).

It matters because the resolution is new code: if C0 reproduces
`resolveTenantId`'s `?? SYSTEM_TENANT_ID` fallback, a missing grantee row lands
the record under the sentinel (invisible to `/api/tenant/audit-logs`); if it does
not, a missing row **denies the vault release**. Both are defensible; only one
ships. Security adds the mitigating facts: `User.tenantId` is NOT NULL with an FK,
the GUC arm passes because the route already opened `withBypassRls`, a throw rolls
the CAS back so the grant stays `REQUESTED` and the next GET retries under the
route's `max: 10` limiter — so the trade is a retryable 500 instead of a silently
unaudited escrow release, which is the right direction. **State it.**

### Minor findings (9)

- **N16** — I4.5's wall-clock bound does not exist: `pre-pr.sh` has zero `timeout`
  usages and `queue_step` has no such facility. No criterion exercises the visited
  set either. Declared, not proven.
- **N17** — AC7 needs a named deterministic barrier (a `Promise` gate released
  after the opener resolves); the obvious `setTimeout` is the `sleep`-shaped race
  the testing rules forbid. AC8's "produce two rows" is wrong currency for its
  venue, and I2.4 places the per-thunk catch in the **drain**, inside
  `tenant-rls.ts`, which cannot emit an audit-specific dead-letter without
  breaking R10 — the thunk's catch must live in `audit.ts` with the drain's as a
  second `getLogger()`-only net.
- **N18** — `health.ts` is named as the timing-sensitive consumer and given no
  acceptance criterion; its venue is itself in C2's mock-breakage class.
- **N19** — RT10 cell dropped: `Promise.all([withTenantRls(…), withTenantRls(…)])`
  from one async context. Both read `getTenantRlsContext()` before either enters
  `run`, so both open — C3 does **not** reject sibling concurrency. Almost
  certainly right, and `logAuditAsyncBothScopes` is a live `Promise.all` over two
  emits, so the cell is reachable and unclaimed either way.
- **N20** — `check-gate-selftest-coverage.sh` requires every `scripts/checks/*.mjs`
  to have a sibling `scripts/__tests__/<base>.test.mjs`. Executed:
  `MISSING_GATE_SELFTEST: scripts/checks/check-rls-nesting.mjs (exit 1)`. C4
  cannot land without a file the plan never names.
- **N21** — after C0 the activation row lands in the **grantee's** tenant in
  personal scope, so the vault owner's tenant admins see no record of the escrow
  release. Pre-existing and faithfully preserved — which is why it needs stating,
  since C0 is the contract that inspects this attribution, declares it correct,
  and enrols the action in a gate whose premise is reliable auditability.
- **N22** — C0 drops the synchronous `auditLogger.info` line and
  `assertEnqueueableUserId` (consistent with all ten other `logAuditInTx` sites),
  while I0.2 says attribution is unchanged. Deployments with
  `AUDIT_LOG_FORWARD=true` stop seeing this action in the forwarded stream.
- **N23** — `setBypassRlsGucs` must be **created**; state where, with the
  constraint that a worker-only module must not reach the app bundle, and that the
  worker's private copy is deleted rather than left as a second definition. Also,
  the gate header C1 must correct **contradicts itself**: its SEARCH_DIRS comment
  claims `health.ts` is the one such member and its docblock explicitly disclaims
  that completeness. C1 falsifies only the first.
- **N24** — C2's cell table has a pre-fix column and no post-fix column, and the
  tenant × absent cell changes outcome (no row → one row, tenant resolved at drain
  time) without being said. The fifth cell (bypass × supplied) is elided.

## Round 2 disposition

**Saturation does not apply.** Criterion 2 is unmet (1 Critical, 15 Major open)
and criterion 3 is unmet — N1, N2, N3, N4, N5, N6, N7, N10 and N15 are against
the design itself.

**But the finding CHARACTER has shifted, and the shift is the signal the
saturation section describes.** Of Round 2's 16 Critical/Major findings, **7 are
against C0** — a contract that did not exist in revision 1 and was added to
resolve a Round 1 finding — and **4 are against C4's added mechanics**. Only
N1, N3, N7 and N11 are against surface that existed in revision 1, and N1 is a
*claim* about enforcement rather than about the change C1 makes.

The core of the issue — C1 (`prismaBase`) and C3 (four-way guard + two
flattenings) — has been stable across both rounds. What keeps generating findings
is the specification added around it: a second contract (C0) that surfaced a real
pre-existing defect (N10) and now needs its own member set, ordering edge, test
edits, denial cell and attribution decision; and a CI gate (C4) whose mechanism
cannot be settled in prose.

This is the documented pattern where plan granularity becomes the defect surface.
The scope question is surfaced to the user before Round 3.

---

# Round 3 (incremental)

Date: 2026-09-05

## Changes from Previous Round

Revision 3 narrowed the scope on the user's decision: **C4 scoped out** to SC1,
**C2's deferral queue replaced** by a loud refusal, **C0 extended to both
`EMERGENCY_ACCESS_ACTIVATE` emitters**, **N10 fixed in this PR**, C1 reduced to
two identifiers, and C3's named-error-class requirement dropped as unreachable.

## Resolution of Round 2 findings

**Moot — removed with the contract (11):** N3, N4, N5, N7, N12, N16, N17, N18,
N20 and the main halves of N23 and N24. All three experts confirmed no dangling
references: `check-rls-nesting.mjs`, `census`, `seal`, `drain` and `thunk` survive
only inside SC1/SC2's descriptions of what was dropped.

**Resolved (9):** N6, N8, N9, N11 (for C2), N13, N14 (partially — see below), N19,
N21 (stated), N22.

**Partially resolved / unresolved (5):** N1 (claim correctly demoted, but its
supporting sentence is false and its "give the pattern a runner" half is refused
on a false premise), N2 (membership fixed, the criterion proving it is not), N10
(defect real and addressed, mechanism and semantics open), N15 (stated, no
venue), N23's second half (gate header correction dropped).

## Merged findings — 1 Critical, 20 Major, 10 Minor

**The Critical and roughly half the Majors are false factual claims in the plan's
own prose**, each falsified by execution. They are listed first because they share
one cause.

### P1 — **Critical** — C0's gate-mutation criterion is green under the exact mutation it names

The criterion reads "removing **either** `logAuditInTx` call makes
`check-critical-audit-atomic.mjs` exit non-zero naming the action". The gate is
action-scoped, and the plan states that two paragraphs earlier. Executed on a
synthetic root with an existing critical action duplicated across two files:

```
both sites present    → OK (all 7 …)   exit 0
remove ONE of the two → OK (all 7 …)   exit 0   ← the plan's mutation
remove BOTH           → ERROR: … not written via logAuditInTx   exit 1
```

RT7 clauses 2 and 3 fail: zero delta on the real subject, no output naming
anything. The criterion would be run, come up green, and be recorded as
satisfied — certifying a gate reach that does not exist. This is the same class
N2 filed, re-created inside the criterion written to close it.

**Fix:** deny side = remove **both** calls → exit 1 naming the action; allow side
= both present → exit 0 **and** the `all 8` banner on stdout (so ENOENT, which
also exits 1, is distinguishable); keep the one-converted-site run as *evidence of
the action-scoped limit*, labelled not-a-pass. Per-site coverage comes from the
per-site pins, never from this gate.

### P6–P10, S9, S10, Q9 — Major/Minor — false claims inherited from Round 2's measured tables and compressed wrongly

- **P6** — "green with the GUC setters deleted" is false. Round 2's table said
  *"delete `setBypassRlsGucs` **in `enqueueAudit`**" → exit 0* and *"delete every
  GUC setter **(bulk path)**" → exit 1*; revision 3 dropped the qualifier.
  Re-measured: deleting `enqueueAudit`'s three setters → exit 0; deleting
  `enqueueAuditBulk`'s → **exit 1** naming `createMany`. The conclusion (the
  gate cannot decide client identity) is true; the reason understates live
  coverage, and "Also in C1" should claim two proven properties, not one.
- **P7** — "`pre-pr.sh` has only named `node scripts/checks/*.mjs` steps" is
  false. `pre-pr.sh:531` is a grep-based static step, and three more follow it.
  That premise is what demoted both forbidden patterns to review aids, so C0's
  pattern ships runner-less when a three-line `run_step` would give it one (R36's
  mild form: a control weakened by a reason rather than by a decision).
- **P8** — C2's "fails loudly" is false as shipped. `deadLetterLogger` sets
  `_logType: "audit-dead-letter"`, and `infra/fluent-bit/fluent-bit.conf` carries
  `Exclude _logType ^audit-dead-letter$`. `docs/operations/alerts.md` licenses
  that exclusion on an explicit premise — "**the two remaining reasons** fire only
  when the database is unreachable" — and records that the old alert was replaced
  by a SQL count of sentinel-tenant `audit_logs` rows. C2 adds a third reason that
  fires with a healthy database and writes **no row**, so neither surface sees it.
  Same shape as M25 one level down.
- **P9** — SC4's Anti-Deferral misidentifies both halves. The owner's admins are
  blind because of the **scope**, not the tenant (`/api/tenant/audit-logs` filters
  `scope IN (TENANT, TEAM)`), so re-filing the row would change nothing. And a
  cheaper close already exists: `/api/audit-logs` surfaces emergency rows to the
  owner through a `metadata.ownerId` OR-branch, and E1's emit already carries
  `metadata: { ownerId }`.
- **P10** — I1.1 is quantified over **two** openers and the discriminating
  criterion names only `enqueueAudit`. A conversion leaving `enqueueAuditBulk` on
  `prisma` is green in every suite and every gate.
- **S9 / S10 / Q9** — the "102 of 234 emit call sites" figure has no reproducing
  command and does not reproduce (independently measured 115/232 and 101/232 —
  subject-dependent, decision-neutral); C0's member-set command is annotated
  "expect 2" and returns 4 (two emitters plus two group registrations); and the
  "list first, count derived" self-test trap **does not exist** — the gate's banner
  is already derived and the count-only edit reds. The one wrong-but-green
  combination is the opposite one, caught by a different case in the same file.

### P2 — Major (convergent: functionality+security) — C2's refusal misfires on the detached-continuation shape, and the prescribed remedy does not resolve it

Both experts measured it independently:

```
detached async started INSIDE the opener callback → ctx = {"tenantId":"T",…}
statement after `await opener(...)`                → ctx = none
```

The transaction is closed; the ALS store is not. Post-C1 an inline enqueue there
would be **correct** (separate transaction, no fold, no forgery) and C2 refuses
it, because the adjudicator is the store and the hazard is the transaction. User
scenario 5's remedy — "move the emit past the transaction" — does not clear the
store; only leaving the ALS scope does (`tenantRlsStorage.exit`). Zero live
members (0 lexical emits across ~570 opener callbacks; both production `void
logAuditAsync` sites are outside the store), so this is C2's undeclared false-deny
cell, not a live loss.

### P3 — Major (convergent: functionality+security) — C0 uses two different tenant-resolution primitives and argues I0.5's safety from one

Three primitives are in play and the plan treats them as one: today's
`resolveTenantId` reads **`User.tenantId`** (NOT NULL, FK, never throws, falls
back to the sentinel); E2's stated mechanism `resolveUserTenantId` reads the
active **`TenantMember`** (returns `null` when the only membership is deactivated,
**throws** on two active memberships); E1's is unnamed. I0.4 asserts the result
"matches what `resolveTenantId` produces today" and I0.5 argues the
tenant-existence arm is unreachable "because `User.tenantId` is NOT NULL" — an
argument about the first primitive licensing a conversion whose E2 half uses the
second. Divergence is reachable: SCIM creates an active membership in tenant B for
a user whose `User.tenantId` is A. And if the implementer reaches for
`resolveUserTenantIdFromClient` at E1, a grantee with a deactivated or duplicated
membership turns a working escrow release into a rolled-back 500 — the denial
I0.5 says cannot happen. R48 + R3.

### P4 — Major (convergent: functionality+security) — the N10 hoist changes what `EMERGENCY_ACCESS_ACTIVATE` asserts, with no discriminator

After the hoist the action is emitted on three outcomes — escrow released,
`revoked`, `no_escrow` — and nothing in the payload distinguishes them. C0's own
urgency argument is that "the operation hands a grantee the owner's escrowed vault
key material", true of one of the three. The vault GET emits no
`EMERGENCY_VAULT_ACCESS` (its only emitter is `.../vault/entries`), so on this path
`EMERGENCY_ACCESS_ACTIVATE` is the sole record that key material moved. Consumers
reachable from the value: the audit-log row label, the action-icon map, and
`AUDIT_ACTION_GROUP.EMERGENCY`. **Fix:** an additive
`metadata.outcome: "released" | "revoked" | "no_escrow"` at both emitters, with a
three-line consumer note — not a new action value, which would be an R12
propagation.

### P5 — Major (convergent: functionality+security+testing) — SC1's worst case is understated on two disjuncts

SC1 prices the missing gate at "a denied request … or by the test suite". Both
halves measured:

- **93** opener call sites sit inside a `try`; **40** under a `catch` with no
  rethrow, several documented as deliberate (`lockout-admin-notify.ts:37`
  "never block the auth/lockout flow"; `new-device-detection.ts:43,80`;
  `account-lockout.ts:420` "Swallow —"; `directory-sync/engine.ts:84,600`
  "best-effort"). A nesting introduced there is silent, not denied. C3's control
  class correctly says "no swallowing caller **on the audit path**"; SC1 drops the
  qualifier.
- **170 of the 175** test files that mock `@/lib/tenant-rls` replace an opener
  with a passthrough, and **3 of 103** integration files call the real openers. So
  "or by the test suite" is close to zero outside the two venues C3 itself adds.

### P11 — Major (convergent: security+testing) — the pre-declared edit list names a non-member and misses members whose failure mode is silent

Run with the intersection the plan omits ("…and the changed module is reachable
from the test's unmocked imports"):

- `src/lib/tenant/tenant-management.test.ts` **is not a member** — nothing in its
  import graph reaches `src/lib/audit/audit.ts`. Inherited from M18 through N13
  and never re-measured.
- Two members are missing: `src/__tests__/api/mcp/authorize.test.ts` and
  `src/__tests__/api/extension/token-refresh-cnfJkt.test.ts` — both mock
  `@/lib/tenant-rls` with a bare two-key factory, neither mocks
  `@/lib/audit/audit`, and both drive routes that call `logAuditAsync`.
- **The failure mode at those files is silent**: per I2.2 the context check sits
  inside `logAuditAsync`'s existing `try`, so `getTenantRlsContext is not a
  function` is caught and dead-lettered as `logAuditAsync_failed`. Neither file
  asserts on audit, so the suite stays green while the emit path is disabled.

### P15 — Major — I2.2's ordering puts the refusal check inside the never-throws catch

Same mechanism as P11's second half, stated as a design point: a control
violation, a database blip and a broken mock all land on
`reason: "logAuditAsync_failed"`, which is what I2.3 exists to prevent, and the
emit is silently skipped. The plan forbids the *loud* wrong answer
(`getTenantRlsContext?.()`) while the *silent* one is the default. **Fix:** a
module-load-time assertion in `audit.ts` that the symbol resolves — failing the
suite at import, before any emit, leaving the call-time never-throws contract
untouched.

### P12–P14, P16–P20 — Major — venues, cells and mechanisms

- **P12** (func+test) — E2 has **five** concrete breaks in
  `approve/route.test.ts` (bare `@/lib/tenant-context` factory missing
  `resolveUserTenantId`; real `withTenantRls` against a prisma mock with no
  `$transaction`/`$executeRaw`; no `logAuditInTx`, which unlike `logAuditAsync`
  takes the request down; an `importOriginal` repair breaks two
  `toHaveBeenCalledTimes(1)` assertions; `transition`'s `db` changes), left in the
  plan as "same class; check its mocks". And **no venue observes E2's atomicity** —
  the integration list is all E1.
- **P13** — E2's opened form leaves the grantee lookup and `sendEmail` unplaced.
  The natural placement (inside the new callback) is a `withBypassRls`-in-tenant
  **denial** under the existing guard, plus R9's shape for `void sendEmail`. State
  that the callback contains only `transition()` and `logAuditInTx`.
- **P14** — I0.2 offers two mechanisms as an "implementation choice"; one cannot
  cover the `!updated` CAS-success arm (`updated` is `T | null` there, so
  `updated.ownerId` does not compile). Name the mechanism: widen the pre-CAS
  select with `ownerId`, emit immediately after `transition()` returns `ok`.
- **P16** — C2's member set is three functions; all five criteria exercise
  `logAuditAsync`. `logAuditBulkAsync` has its own prefix, its own
  `assertEnqueueableUserId` **filter** with an empty-batch early return, and a
  catch that emits one dead-letter *per entry*. An implementation adding the check
  to `logAuditAsync` only satisfies every stated criterion.
- **P17** — AC5 ("row visible inside the transaction, gone on rollback") is
  assigned to a venue with no database and a bare `enqueueAuditInTx` spy; AC4's
  batch half calls `enqueueAuditBulk`, **absent from that file's factory**. Split
  AC5 by half, and pre-declare the factory addition.
- **P18** — the discriminating/regression labelling reached C2's 5 criteria and
  none of C0's 7, C1's 3 or C3's 8. And within C2, AC1/AC2's **GUC clause is
  satisfied by C1** — at the C1 commit the GUCs are already unforged, so only the
  "no row written" clause discriminates C2. Label all 23, and name the *commit*
  each discriminates against, since the range is bisectable.
- **P19** — I0.2's `revoked` fixture is **unreachable in production**: the only
  writer of `revokedAt` sets it in the same CAS that sets `status: REVOKED`, and
  the promotion requires `status = REQUESTED`. Neither fixture exists in the file
  that must hold them (`seedGrant` has no `revokedAt` and always inserts the
  escrow; `fetchGrant` selects no `activated_at`). Mark `revoked` a
  defensive-branch pin built by direct SQL; the live arm is `no_escrow` via
  `!granteeKeyPair`.
- **P20** — I0.5's denial cell has no venue and no fault-injection mechanism. The
  natural home is `centralize-state-transitions.integration.test.ts` and the
  natural mechanism, a file-hoisted `vi.mock` of `@/lib/audit/audit-outbox`,
  **poisons T17 and case #6** in the same file. Prescribe a delegating spy
  (`vi.fn(actual.enqueueAuditInTx)` + `mockRejectedValueOnce`).

### Minor findings (10)

S11/F11 (the gate header enumeration C1 falsifies is no longer a pre-declared
edit), S12 (I2.2's discriminating cell — context active × malformed id — is
unpinned; AC4 measures the configuration where the refusal cannot fire), S13 /
P14's residue (`!updated` unreachable-in-transaction, worth recording rather than
leaving as a silent third member), F10 (C2's justification names one of the three
in-context cells C1 changes), Q10 (C3's two ordering cases omit the nesting
combination; the `SYSTEM_TENANT_ID` case is already green in tenant-in-bypass),
Q11 (after C0, T17's `>= 1` poll masks a late duplicate — the fix is structural,
not a comment rewrite), Q12 (AC4's "logs one line" is ambiguous — two
`auditLogger` lines, one dead-letter; AC3's ordering clause is a vestige of the
deferral), Q13 (SC1's test-suite disjunct, measured), S9/S10 (figures), Q9
(self-test trap).

## Round 3 disposition — the character has changed

**Saturation still does not apply** (criterion 2: one Critical and twenty Majors
open). But the composition is now unambiguous:

| Kind | Count |
|---|---|
| Against the **design** (contracts, control classes, invariants) | **4** — P2, P3, P4, P13 |
| **False factual claims in the plan's own prose** (R29) | 9 — P1, P6, P7, P8, P9, P10, S9, S10, Q9 |
| **Missing test venue / fixture / mock declaration** | 6 — P11, P12, P17, P19, P20, P16 |
| **Missing residual, cell, or label** | ~12 — P5, P14, P15, P18, and the Minors |

Design Criticals are **zero**, and have been for two rounds (3 → 1 → 0 across
Rounds 1–3). Every remaining Critical/Major is either the plan mis-stating a fact
about the tree that the toolchain settles in seconds, or a test-construction
detail that Phase 2 settles by building.

The cause is identifiable and recurring: each revision imports the previous
round's measured tables into the plan, compresses them, and the next round
falsifies the compression. P6 and P7 are that failure exactly — both are Round 2
measurements copied with a qualifier dropped. This is what the skill's "keep the
specification and the litigation apart" section describes: the measurements belong
in this artifact, and the plan should carry the obligation and the acceptance
criterion, not the evidence.

The exit question is surfaced to the user.

## Phase 1 exit — recorded

**Exited by user decision at Round 3, not by saturation.** The skill's saturation
criterion 2 (no Critical or Major open) is unmet: revision 4 resolves the Round 3
Critical and the design and prose findings, and routes five test-construction
findings to `## Carried-Forward Plan Findings` in the plan, each with an
Anti-Deferral entry. Those five are Major as the experts filed them, and filing a
cost-justification tracks a finding rather than resolving it — so this exit leaves
Majors open and is recorded as such.

The call was surfaced to the user with the numbers and the composition:

| Round | Critical | Major | Design-level findings |
|---|---|---|---|
| 1 | 3 | 20 | many |
| 2 | 1 | 15 | 9 |
| 3 | 1 | 20 | **4** |

Design Criticals reached zero at Round 2 and stayed there. Round 3's single
Critical (`P1`) was an acceptance criterion contradicted by a fact the plan itself
stated two paragraphs earlier, and nine of its Majors were factual claims the plan
had imported from this artifact's own measured tables and compressed wrongly.
That is the documented pattern in which plan granularity becomes the defect
surface, and it is why revision 4 is a deletion rather than an expansion.

**Per-finding labels are as the experts filed them**; the orchestrator merged and
did not re-label. Where the orchestrator disagreed with a severity (notably
`M25`/`P8`, which R29 would escalate to Critical because a false compensating
control licensed a security-loosening decision), the disagreement is recorded here
rather than applied, and the finding was fixed in the revision regardless.

**Remaining open at exit** — CF1 (approve-route test's five breaks), CF2 (the
test-edit derivation and its wrong instance), CF3 (C2's venue mock additions and
criterion split), CF4 (C0's missing fixtures and the delegating-spy requirement),
CF5 (T17's poll). All five are reachable only by building and executing the
implementation, which is Phase 2 work by definition. CF2 carries the load-bearing
obligation: it must land with I2.4's load-time assertion, or its missed members
fail silently.
