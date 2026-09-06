# Code Review: audit-emit-tx-fold

Date: 2026-09-06
Review round: 1

## Changes from Previous Round

Initial code review. Three expert sub-agents reviewed `git diff main...HEAD` on
`fix/audit-emit-tx-fold` (31 files, ~4200 insertions). Ollama seed generation
timed out on the diff size, so all three fell back to full-diff review; each
recorded `Seed unavailable — no dispositions to record.`

Phase 2 Step 2-5 had already run a focused R1–R57 self-check and fixed one
Critical and seven Majors, so this round was scoped as incremental verification.

## Merged findings — 1 Critical, 4 Major, 16 Minor

Severity floors follow "Perspective Convergence as a Severity Signal": a finding
reported by two or more perspectives takes the **maximum** reported severity.

### C1 — **Critical** (convergent: functionality+testing) — five `[D]` acceptance criteria had no test, and the deviation log said otherwise

The Implementation Checklist named
`src/__tests__/db-integration/centralize-state-transitions.integration.test.ts`
with four obligations (CF4's `seedGrant` extensions, `fetchGrant`'s
`activated_at`, the I0.6 fault-injection spy, CF5's structural T17 fix). The file
was **not in the diff**, and the deviation log's Step 2-1 section stated "CF1,
CF3, CF4, CF5 are fixed in this phase" — wrong in the direction that hides the
gap.

Unbuilt as a result: the post-emit-rollback cell, E2's in-transaction visibility
cell, I0.6's retryability cell, and the C3 team-delete cell.

**The red proof made it concrete**: at review time, moving E1's emit to the
ambient module client left **90/90 tests green and both gates at exit 0**.
Nothing in the tree distinguished an atomic activation emit from a non-atomic one
at the site level — the primitive's atomicity was pinned generically by
`audit-outbox-atomicity.integration.test.ts`, but the site-level binding C0
exists to establish was not.

**Fixed.** The E1 route cells now assert the client identity against a distinct
tx object (that alone closes the red proof — the same mutation now reds three
tests), and three `[D/C0]` integration cells were added to
`centralize-state-transitions.integration.test.ts` along with CF4's seeder
extensions and CF5's poll replacement. Each cell asserts the grant status
positively **before** counting rows.

Which mutation reddens which, measured rather than assumed, and recorded in the
file:

| Mutation | Cells reddened |
|---|---|
| emit moved back below the guard returns | the withheld-outcomes cell |
| emit on an **independent** transaction | all three |
| emit via `logAuditAsync` | retryability + withheld-outcomes, **not** rollback |

The last row is the one worth keeping: C2 refuses an in-context async emit, so
that variant writes nothing either — the rollback cell discriminates "written on
the caller's tx" from "written on its own tx and committed", which is the
independent-transaction mutation.

### M1 — Major (convergent: security+testing) — the new gate was fail-open on argument indirection, and action-scoped where the plan specified file-scoped

Two axes, both red-proved by the reviewers:

- `actionOf` returns `null` unless the call's last argument is an inline object
  literal. An ordinary "extract the params object" refactor made a
  `logAuditAsync` invisible on the negative half, while the banner still printed
  the positive claim.
- The plan's P7 pattern was file-scoped for `vault-auto-promote.ts`. Because that
  file's **entire body** runs inside the caller's `withBypassRls`, after C2 *any*
  async emit there is refused and writes nothing — whatever action it carries.
  The action-scoped gate permitted one.

**Fixed.** Undecidable actions now fail closed with a named message; the
bypass-only subject carries an outright ban on `logAuditAsync` while the approve
route keeps the action-scoped rule, because an emit at its handler's top level is
outside the transaction and correct there. The self-test's single
"ignores a DIFFERENT action" case was **split per subject** rather than deleted —
E1 deny, E2 allow — and two more cases were added for the undecidable arm and the
`pre-pr.sh` wiring.

### M2 — Major — `logAuditBulkAsync` had a deny cell and no allow cell

Its real body was exercised nowhere in the tree — every other file naming it
mocks `@/lib/audit/audit` wholesale — so nothing asserted it calls
`enqueueAuditBulk` at all. The singular path's allow companion carries the reason
verbatim ("without it, a refusal that fires unconditionally passes every
assertion above") and it had not been carried across.

**Fixed.** Three cells: no-context enqueues once with all payloads; a mixed batch
enqueues only the well-formed entry with exactly one `invalid_user_id` line and
two structured lines; a batch of one malformed entry enqueues nothing.

### M3 — Major — `audit-outbox.ts`'s membership in the sibling gate's scan set was unpinned

`check-rls-read-context.mjs` gained the module in `SEARCH_DIRS`, but its
self-test was unchanged and its "fails loudly when a target resolves to no files"
case does not fire when a target is simply deleted from the default list. The
enrolment — which the plan calls a second, independent control — could be dropped
silently.

**Fixed** with the file's own established idiom (the sibling `is wired into
scripts/pre-pr.sh` case), asserting both `src/lib` members are present.

### M4 — Major — the new gate's `pre-pr.sh` wiring was unpinned

`check-gate-selftest-coverage.sh` only requires **inline** gates to carry a debt
entry; it does not verify that a `scripts/checks/*.mjs` file is invoked at all.
Deleting the runner line left the gate, its self-test and the meta-gate all
green while the gate stopped running. The repo already had the remedy in
`check-rls-read-context.test.mjs`.

**Fixed** with that shape, matching `(queue|run)_step`.

### Minor findings (16) — dispositions

**Fixed (13):**

- The `refusedEmitLogger` docblock claimed to be "the one audit-loss reason that
  fires with a healthy database" — a claim the same commit disproves twice over
  (`AUDIT_DEAD_LETTER_REASON`'s docblock and `alerts.md` both say
  `invalid_user_id` does too). Corrected, and given the bounded-payload
  justification its unforwarded sibling carries — which matters **more** here,
  because this stream ships by default.
- `fluent-bit.conf`'s surviving comment asserted the exclusion "no longer hides
  the only copy of an unattributable event", which this PR's own runbook edit
  contradicts for `invalid_user_id`. Corrected, and `audit-refused`'s
  must-not-exclude status is now stated in the file rather than held by the
  absence of a rule.
- `alerts.md`'s "any occurrence is worth a ticket" now says the signal reaches a
  SIEM only with the opt-in logging overlay.
- The bulk refusal comment claimed a quantifier symmetry with the catch arm the
  code does not have (refusal iterates `enqueueable`, the catch iterates
  `paramsList`). Corrected with the reason for the asymmetry.
- The refusal-placement comment gave a reason covering only the call sites that
  omit `tenantId`. Corrected.
- `db as Prisma.TransactionClient` discarded the file's only type-level caller
  contract; the parameter is now typed `Prisma.TransactionClient`.
- The unreachable re-narrowing branch returned `no_escrow` after a row saying
  `released` had committed. It now throws — dead code that would lie is worse
  than dead code that stops.
- The two outcome route cells now assert the CAS positively, ahead of the row
  count.
- The C3 ordering cell now asserts the error **class** as well as the prefix.
- The cold-cache test's `createdTokens` registry was written, cleared and never
  read — deleted, with the cascade that actually cleans up named instead.
- Plus the `countAuditRows` docblock, which described an outbox-drain the
  activation no longer uses.

**Deferred with Anti-Deferral (3):**

- **The approve route resolves the tenant twice** (once inside
  `withUserTenantRls` for the authorization read, once directly for the CAS).
  *Anti-Deferral: out of scope for this PR. Worst case — four transactions where
  three would do, and a window in which the two resolutions disagree; it fails
  closed (the CAS is `where: { id, ownerId }`, so a row invisible under the
  second tenant yields a 400 rather than a wrong write). Likelihood of divergence
  low (it needs the SCIM multi-tenant case). Cost — hoisting the resolution above
  the authorization read changes which context that read runs under, which is an
  authorization-adjacent change and wants its own review rather than a rider on
  this one.*
- **`EA_ACTIVATE_OUTCOME` lives in a behaviour module** while its siblings
  (`EA_STATUS`, `EA_ACTOR`) live in `src/lib/constants/integrations/`.
  *Anti-Deferral: out of scope. Worst case — a route imports an audit-metadata
  enum from the auto-promotion helper it does not call; likelihood certain, cost
  nil, impact cosmetic. Moving it touches two import sites and the constants
  barrel, which is a tidy-up better done on its own than inside a security fix.*
- **E1 files the activation row under `User.tenantId` while its only reader opens
  the `TenantMember` tenant** — on divergence the row is written under tenant A
  and every read is scoped to tenant B, so it is invisible.
  *Anti-Deferral: out of scope, follow-up issue. Worst case — the only record
  that escrowed key material moved is unreadable by anyone; likelihood low (needs
  the SCIM deactivate-and-reprovision case). Cost — the obvious remedy is wrong:
  `resolveUserTenantId` throws on a multi-membership user, which would turn a
  working escrow release into a rolled-back 500 for a condition this operation
  does not care about. The right shape is a named warn when the two disagree,
  which is a new observability decision rather than a fix to this diff. Recorded
  because C0 is the contract that inspects this attribution and declares it
  correct.*
- **The two new integration files carry no sentinel-tenant delta assertion.**
  *Anti-Deferral: out of scope. Worst case — a row landing under `__system__`
  rather than the intended tenant goes unnoticed by these files; likelihood low,
  and `audit-outbox-unproxied-client` is marker-scoped so its own counts are
  unaffected. Cost — the assertion needs a before/after pair around every file
  that emits, which is a harness-level change (`helpers.ts`) rather than a
  per-file one, and belongs with whoever owns that helper.*

## Adjacent Findings

- **[Adjacent] Security → functionality**: E1's tenant-resolution reader
  asymmetry (above). Notable in the other direction too: **E2's change moves the
  right way** — its row now follows `resolveUserTenantId`, which is exactly what
  `/api/audit-logs` opens, so where the two diverge the owner gains visibility of
  their own approval row where previously they had none. The plan presented the
  two emitters' resolutions as a neutral choice; they are not symmetric with
  respect to the reader, and only E2's is.
- **[Adjacent] Testing → functionality**: the checklist cross-check found two
  entries absent from the diff (`vault/route.ts` and `fluent-bit.conf`). Both
  were discharged by a different design than the checklist anticipated; deviation
  entries D7 and D8 record that.

## Environment Verification Report

Phase 1 declared VE1–VE3.

| Path | Class | Evidence |
|---|---|---|
| All integration cells (C0 ×3, C1 ×4, C3 cold-cache ×2) | `verified-local` under **VE1** | `docker compose stop audit-outbox-worker retention-gc-worker` → `npm run test:integration` → 108 files / 660 tests pass → workers restarted |
| Unit cells (C2 ×10, C3 ×8, gate self-tests ×10) | `verified-local` | `npx vitest run` — 1028 files / 15384 tests pass |
| Static gates | `verified-local` | `check-pre-pr.sh run` — 78/78 pass, exit 0 |
| CI-only parity gates | `verified-local` | `check-state-mutation-centralization.sh` exit 0; `licenses:check:strict` exit 0 |
| **VE2** (the fold is only observable against a real database) | `verified-local` | `audit-outbox-unproxied-client.integration.test.ts` — red-proved against the pre-C1 shape |
| **VE3** | holds | no `blocked-deferred` path |

## Recurring Issue Check

### Functionality expert

R42 verified by execution on both classes (C2's in-context emit set and C3's
opener-in-opener set re-derived with an independent transitive-closure AST scan
and red-proved against `main`: 0 on HEAD, 1 and 1+3 respectively on `main`).
R29 fired twice (both fixed). Cross-cutting `set_config` sweep clean — every
remaining site is a worker-owned client that deliberately avoids `@/lib/prisma`.
Write-read consistency of `metadata.outcome` clean — no keyed reader in the
outbox worker or `METADATA_BLOCKLIST`. Guard messages byte-identical for the two
pre-existing combinations. Reuse-over-reimplementation checked. R1, R3, R5, R9,
R10, R12, R19, R33, R36, R43 clean.

### Security expert

**No Critical or Major findings.** R29 fired three times (all fixed). R49 fired
once (the gate, fixed). R42 checked by independent re-derivation — 237-file
lexical scan plus transitive callee resolution reproduces "zero live members" for
both classes. R52 verified against the newly-covered population: a dedicated scan
enumerated the 42 direct + 21 transitive opener call sites under a
non-rethrowing catch and read the three the round named — the lockout
notification, new-device detection and directory-sync openers are all
**sequential**, outside any open callback, so none changes behaviour on the newly
denied combinations. Rollback on a throwing emit verified at both sites. R43: no
widening — every predicate this diff moves tightens or is neutral. R9, R19, R33,
R34, R36, RS1–RS6 clean.

### Testing expert

RT1/RT5 verified by mutation, not by reading: removing C2's two refusal blocks
reds exactly 4 cells; hoisting the refusal above `assertEnqueueableUserId` reds
exactly the ordering cell; reverting only `enqueueAuditBulk`'s opener reds
exactly 1; reverting the C3 guard to two combinations reds exactly 3. RT6 clean.
RT7 fired (M1, fixed). RT10 partial (M2 and the outcome cells, fixed) — the
cold-cache pair's discriminating reasoning was independently verified correct.
RT11 clean on marker scoping and failure-path cleanup. R19 clean — the two
repaired files with route-tree twins already used `importOriginal` spreads and
were not members. R33 clean — both new integration files are reached by CI, and
the new gate runs under `PRE_PR_STATIC_ONLY=1`.

## Resolution Status

All Critical and Major findings fixed in this round. Four Minor findings deferred
with Anti-Deferral entries above; the remaining thirteen fixed.

Verification after fixes: `npx tsc --noEmit` clean · `npx eslint` 0 warnings ·
unit 1028 files / 15384 tests · integration 108 files / 660 tests · `pre-pr.sh`
78/78 · workers restarted.
