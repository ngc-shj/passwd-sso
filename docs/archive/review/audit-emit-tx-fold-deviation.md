# Coding Deviation Log: audit-emit-tx-fold

## Step 2-1 — CI gate parity

15 CI gates extracted. A naive `npm run <name>` key match suggested 9 gaps; each
was checked against `scripts/pre-pr.sh`'s actual invocation, which calls the
underlying script rather than the npm alias. **Seven were false gaps** — the
mechanical diff is not the measurement, which is the R29 shape this log exists to
keep honest. Two are real:

- **Deferred parity gap: `npm run licenses:check:strict` (and the `:cli` / `:ext`
  variants)** — reason: they read `package-lock.json` / the CLI and extension
  lockfiles and assert a license allowlist. `pre-pr.sh` does not run them, and
  this diff adds no dependency, so the gate's input set is unchanged by it. Run
  once in Step 2-4 to confirm, not added to `pre-pr.sh` here — extending the
  aggregate script with three license gates is a change to every future PR's cost
  and belongs to whoever owns that decision.
- **Deferred parity gap: `bash scripts/check-state-mutation-centralization.sh`** —
  reason: not in `pre-pr.sh`. This diff **does** touch `transition()` call sites
  (C0/E2 changes the `db` argument), so this gate is in scope and MUST be run
  locally in Step 2-4 rather than deferred to CI.

## Step 2-1 — carried-forward disposition

CF1, CF3, CF4, CF5 are fixed in this phase (see the Implementation Checklist).
**CF2 is dispositioned as "derived by running"**: its member set is produced by
landing C2 with I2.4's module-load assertion and reading which test files fail at
import. Revision 3's static list was wrong in both directions, so reproducing a
list here would repeat the error. The 15 candidates recorded in the checklist are
the expected superset, not the answer.

## Implementation deviations

### D1 — I0.2 and I0.4 could not both be satisfied at the placement I0.2 named

I0.2 specified the emit "immediately after `transition()` returns `{ok:true}`,
before the re-fetch"; I0.4, added in the same revision, requires the row to carry
`metadata.outcome`. At the placement I0.2 names the outcome is not yet known.

Resolved by keeping I0.2's *property* — the emit covers every path the CAS
succeeded on — and moving the call to after the outcome is classified, with
`ownerId` read from the pre-CAS select. That is what makes the `!updated` arm
safe, which was I0.2's stated reason for preferring the earlier placement, so the
reason survives the move. I0.3 is unaffected: the classification and the emit are
both after `promoted.ok`.

### D2 — `metadata.outcome` is a named constant, not an inline union

Three literals with a derived type (`EA_ACTIVATE_OUTCOME`), exported from
`vault-auto-promote.ts` and used by the approve route. The plan wrote the union
inline.

### D3 — the forwarder carve-out is a separate `_logType`, not a fluent-bit rule

I2.5 said to "carve the new reason out of the exclusion". The first attempt used
`rewrite_tag` to move the record past `Exclude _logType ^audit-dead-letter$` —
and every OUTPUT in that config matches `app.*`, so the re-tagged record reaches
none of them. A carve-out that forwards nothing while reading as correct is the
class of defect this PR exists to remove, so it was discarded rather than
adjusted.

The refusal ships under `_logType: "audit-refused"` on a sibling logger instead.
The exclusion's justification — dead-letter records carry caller error text —
does not apply: the refusal payload has no `error` field, because it reports a
control decision rather than a failure. `docs/operations/alerts.md` gains the
signal with its recovery action, and its "two remaining reasons" enumeration is
corrected.

### D4 — the C0 forbidden pattern became a standalone gate, not an inline step

The plan specified a `run_step` in `pre-pr.sh`'s grep idiom. That satisfied the
step but not `check-gate-selftest-coverage.sh`, which requires every inline gate
to carry a sibling self-test or a debt entry — a constraint the plan did not
anticipate for inline steps, only for new `scripts/checks/*.mjs`.

Four existing inline gates take the debt-entry route. This one is extracted to
`scripts/checks/check-emergency-activate-atomic.mjs` with a self-test instead:
the gate's whole value is that it examines one specific file, so "the file moved"
must be distinguishable from "the file is clean", and that arm needs a test to
be worth claiming. Adding a fifth debt entry would have deferred the same work
onto a list the repo is evidently trying to shrink.

The pattern matches `logAuditAsync(`, not `logAuditAsync`: run against the
corrected file first, the word-shaped form flagged the file's own comments
explaining what it used to do.

### D5 — CF2's member set, as derived by running

The plan's disposition was to derive it by landing C2 with I2.4's module-load
assertion and repairing what failed at import. Result: **four** files, three of
which review had predicted and one — `src/app/api/vault/unlock/data/route.test.ts`
— which no list contained. `src/lib/tenant/tenant-management.test.ts`, named in
revision 3's list, did not fail: it is not a member, as Round 3 found. Each was
repaired with `importOriginal` spread plus its existing opener override; none
received a bare `getTenantRlsContext` stub.

### D6 — deferred CI-parity gaps, both run locally

Recorded in Step 2-1 and discharged here rather than deferred to CI:
`bash scripts/check-state-mutation-centralization.sh` (in scope — this diff
changes `transition()`'s `db` argument) exits 0, and the three license gates
exit 0 with no dependency change.

## Step 2-5 — self-R-check findings, all fixed in this phase

Three sub-agents ran the Recurring Issue Checklist against the committed diff.
One Critical and seven Majors fired; every one was mine, and every one is fixed
rather than deferred.

- **R49 (Critical) — the new gate asserted only an absence.**
  `check-emergency-activate-atomic.mjs` checked that `logAuditAsync(` was gone
  and printed "written in-transaction" on the strength of it. Measured on
  copies: deleting the emit **entirely** passed, and so did an aliased call and
  a call split across lines. Its self-test's first case was satisfied by
  `const x = 1;`. Rewritten AST-based, site-scoped over **both** emitters, with
  the positive assertion (at least one `logAuditInTx` carrying the action) and a
  scanned-subject refusal. The self-test grew from 4 cases to 7, including the
  emit-deleted case the first version could not fail on. The name-alias limit is
  declared rather than claimed closed.
- **R29 — `check-critical-audit-atomic.mjs`'s comment claimed "both sites are
  pinned individually"** while only one site had a gate. True now; the comment
  names the companion gate and the measurement behind the action-scoped limit.
- **R29 — the contract docblock in `vault-auto-promote.ts` still said the emit
  fires "ONLY on the success path"** — the exact description this PR names as
  the defect — while the file header above it said the opposite. Rewritten to
  the implemented order; the duplicated `Step 6` renumbered.
- **R29 — `AUDIT_DEAD_LETTER_REASON`'s docblock claimed the forwarder enumerates
  the reasons.** It does not: it filters on `_logType` and never reads `reason`,
  which is *why* the refusal needed its own logger. Corrected. The same read
  exposed a further error in this PR's own runbook edit: `invalid_user_id` also
  fires with a healthy database and is also excluded, so "the two remaining
  reasons ... mean the database was unreachable" was wrong about a third one.
  `alerts.md` now states that as a known gap rather than implying it away.
- **R49 — E2 wrote `outcome: "released"` for a route that releases nothing.**
  The approve route selects only `{ownerId, granteeId}`; it never reads
  `encryptedSecretKey` or `granteeKeyPair`, and the actual handover happens on a
  later vault GET. A grant E1 would label `no_escrow` was being labelled
  `released` by E2. Added `EA_ACTIVATE_OUTCOME.APPROVED` and used it there.
- **RT6 — `refusedEmitLogger`'s `_logType` was asserted nowhere**, and it is the
  load-bearing value of the whole forwarder argument. Pinned, with distinctness
  from `deadLetterLogger` and the presence of `_app`; red-proved by drifting the
  value back to the excluded stream.
- **R42 / RT10 — the `no_escrow` outcome had no test.** Added; red-proved
  against the pre-fix emit placement.
- **RT7 / R33 — `enqueueAuditBulk` was pinned by no always-running test.**
  Reverting only that opener left the whole unit suite green. Added the
  client-identity assertion for the bulk path, and added `src/lib/audit/**` to
  `ci-integration.yml`'s `paths:` — without it a future PR touching only that
  directory reaches no gate, no unit pin and not the integration job.
- **Residual pinned as literals** — the dead-letter reason strings were asserted
  as constant-against-itself, so a value change reddened nothing while staling
  the runbook that tells operators to query them. Now pinned as wire values.

### R50 — the C3 cold-cache cell, implemented rather than deferred

The plan's `[D/C3]` sign-in criterion had no test and no deviation entry. It is
now `session-create-cold-timeout-cache.integration.test.ts`, the only venue
where the real guard, the real opener and the real resolver run together.

Writing it surfaced a defect in its own first version: the warm cell was warmed
by a first `createSession` call, which is itself a cache miss — so under the
un-hoist mutation **both** cells reddened and the pair distinguished nothing.
Warmed through the resolver directly, the mutation now reddens the cold cell and
leaves the warm one green, which is what an allow-side companion is for.

### One latent vacuity fixed in this PR's own integration test

`audit-outbox-unproxied-client.integration.test.ts` compared `txid_current()`
(xid8, epoch-extended) against `xmin` (32-bit xid). They agree only while the xid
epoch is 0; after one wraparound the inequality assertion would hold
unconditionally — including under the defect it exists to catch. Now
`pg_current_xact_id()::xid`, which truncates to the same width.
