# Plan Review: worker-runtime-invariants
Date: 2026-07-15
Review round: 1

## Changes from Previous Round
Initial review. Three experts (Functionality, Security, Testing) reviewed the C-P2
first-PR plan against the real repo, verifying every factual claim (line citations for
claimBatch/reapStuckRows/reapStuckDeliveries/purgeRetention/writeDirectAuditLog, the
schema unique constraints, the R42 sweep member-set, and the concurrency primitives).
16 findings: 1 Critical, 6 Major, 9 Minor. No Quality Warnings (all findings carry
concrete file/line evidence and verified repro). All findings incorporated into the plan.

## Functionality Findings

**F1 — Major: C5 assertion 1 substring extraction breaks on retention-gc's interpolated
DELETE template literals.** retention-gc's sweeps are `` `DELETE FROM ${entry.table} ...
LIMIT $1` `` — `TemplateExpression` nodes whose Head/Middle/Tail spans split `DELETE FROM`
from `LIMIT`. Per-span extraction (the ast-guards.ts idiom) false-fails an already-bounded
statement. Fix: extract the enclosing template node's full `.getText()`.
→ Applied to C5 assertion 1.

**F2 — Minor: `scripts/checks/ast-guards.ts` path does not exist** (actual:
`src/__tests__/proxy/ast-guards.ts`). R29 citation-accuracy. → Corrected in C5 + INV4.

**F3 — Minor: C3 must preserve the `WITH deleted AS (…RETURNING…) SELECT COUNT(*),
MIN(tenant_id)` wrapper** that drives the RETENTION_PURGED emission; a bare restructure
would silently stop the audit event. → Applied to C3 (per-branch emission preservation).

**F4 — Minor: C5 exemption `match` uniqueness holds today but multi-hit failure direction
not explicit.** → Applied to C5 (≥2 matches is an error).

Non-findings verified: C1/C2/C3 injection idioms, C4 constant placement, C2+SKIP LOCKED
interaction, C3 vs before-delete trigger, INV4 member-set recompute (4 unbounded + 1
PK-exemption confirmed), C6/C7 exported primitives.

## Security Findings

**S1 — Major: C3 purge cap lacks ORDER BY → FAILED payload rows (PII: metadata/ip/
userAgent) starve past 90-day retention under SENT-dominated backlog.** A single capped
statement fills its budget with SENT rows, deferring FAILED indefinitely. Fix: split into
two independently-capped branches (SENT-aged / FAILED-aged), each ORDER BY cutoff ASC.
→ Applied to C3 + C8 starvation assertion.

**S2 — Minor: global reaper cap + oldest-first order lets a noisy tenant delay others'
reaping (fairness, not isolation).** → Documented as accepted residual SC6.

**S3 — Minor: writeDirectAuditLog swallow loses audit-UI operational events with no retry;
not surfaced as a signal.** → Documented as accepted residual SC7.

**S4 — Minor (R42 class-derivation miss): forbidden enqueue/logAudit pattern omits
AUDIT_DELIVERY_DEAD_LETTER (INV3's 4th unchained action).** Member-set anchored on 3 of 4.
Fix: widen the alternation + add mechanized completeness vs OUTBOX_BYPASS_AUDIT_ACTIONS.
→ Applied to forbidden patterns + C5.

**S5 — Minor: C5 exemption `match` can be over-broad; symmetry check bounds staleness not
breadth.** Fix: an exemption may only document an already-single-row-shaped statement,
never grant boundedness. → Applied to C5 (tightness gate).

Verified sound: SC1/A2 elimination (three schema constraints exist), INV3 CHECK-constraint
rejection, SC5 auth layering, SC3 duplicate-webhook (already skips bypass actions).

## Testing Findings

**T1 — Critical: C7 "both returned true" RT4 guard is vacuous.** `deliverRowWithChain`
returns `true` unconditionally (audit-outbox-worker.ts:359), so two SERIAL calls both
return true and every count assertion passes with zero contention — byte-identical to the
existing serialized dedup test. Fix: thread an `inserted` discriminator out of the deliver
path (keying off the existing `INSERT ... RETURNING` non-empty check at :339), assert
exactly one call inserted, and assert temporal overlap. → Applied to C7 (return-shape
change + overlap guard + consumer walkthrough for the boundary change).

**T2 — Major: regression gate glob omits `audit-delivery-stuck-reaper.integration.test.ts`**
(direct caller of C2-changed reapStuckDeliveries). Fix: derive the gate from
`rg -l '<changed fns>' src/__tests__/db-integration/`. → Applied to testing strategy
(caller-derived member-set: 9 rg-derived files + the separate retention-gc-* suite).

**T3 — Major: C8 red-first procedure incoherent** — an injected `limit` cannot predate the
unbounded signature; `purgeRetention` isn't even exported. Fix: land C1–C3 first, prove
red by raising the cap above the seed and confirming the assertion fails. → Applied to C8
(honest RT7 procedure) + C3 (export purgeRetention).

**T4 — Major: C5 mechanization guard has no proof-of-failure (RT7); wrong ast-guards path.**
The existing manifest test has no negative case. Fix: co-located self-test over in-memory
fixtures (unbounded flagged, bounded/single-row pass, unused/over-broad exemption rejected)
via the extracted pure classifier. → Applied to C5 assertion 3 + path correction.

**T5 — Major (RT1/R19): C1–C3 SQL/signature changes break SQL-string- and txCount-coupled
mocked unit tests; "no weakening" is insufficient guidance.** Fix: enumerate the exact
mock touch-points (:247-248 claim predicate now matches deliveries reaper, :258 purge
detection sees two DELETEs, txCallCount ladders must be re-derived) + add a positive
LIMIT/ORDER BY assertion. → Applied to testing strategy.

**T6 — Minor: C6 assertion 3 (verifyTenantChain ok:true) vacuous for a single-element
chain; call signature wrong (omits `deps`).** Fix: seed a 2nd chained delivery (seq 1 →
dead-letter → seq 2), assert walked===2 && ok, correct signature to
`verifyTenantChain(tenantId, {prisma, logger})`. → Applied to C6.

**T7 — Minor [Adjacent]: C7 "deadlock" claim imprecise (anchor FOR UPDATE serializes, not
deadlocks); lock_timeout=5000ms flake unaddressed.** → Applied to C7 (precise concurrency
model + lock_timeout-throw-is-inconclusive handling).

## Adjacent Findings
- Functionality R19 note → Testing (merged into T5).
- Testing T7 [Adjacent] → Functionality (anchor-lock concurrency model; incorporated in C7).

## Quality Warnings
None — all 16 findings carry concrete file/line evidence and verified repro.

## Recurring Issue Check

### Functionality expert
R1 pass · R2 pass · R3 FINDING (F1) · R5 pass · R9 pass · R12 pass · R13 pass · R17 pass ·
R18 n/a · R19 FINDING-adjacent (→T5) · R20 pass · R21 n/a · R29 FINDING (F2) · R31 pass
(adds bounds, mitigation not violation) · R32 pass · R40 pass · R41 pass · R42 pass
(member-set independently recomputed) · R44 n/a · RT4 pass · RT5 pass · RT7 pass (F1 caveat)

### Security expert
R3 flag (S4) · R14 pass (no new role/grant) · R27 n/a · R31 pass (design-level, adds
bounds) · R42 flag (S4 forbidden-pattern set; S5 exemption breadth; INV4 own derivation
correct) · RS2 n/a · RS3 n/a · RS5 n/a · RT4 pass · RT5 pass · RT7 pass (S5 red-proof gap
→ folded into C5.3) · RT8 pass

### Testing expert
R2 pass · R19 flag (T5) · R21 n/a · R27 n/a · R32 pass · R42 pass (INV4 code-derived; T2 is
gate-glob gap not anchoring) · RT1 flag (T5) · RT2 pass · RT3 pass · RT4 flag (T1 Critical)
· RT5 pass · RT6 pass · RT7 flag (T3 caps, T4 manifest guard) · RT8 pass · RT9 pass

---

# Plan Review: worker-runtime-invariants — Round 2 (Security, incremental)
Date: 2026-07-15
Review round: 2
Reviewer viewpoint: Security Engineer
Scope: threat model, authz, data protection, injection, audit-chain integrity, tenant isolation

## Round-1 findings — resolution verification

- **S1 (Major) — RESOLVED.** C3 (plan:156-171) splits the single union DELETE into two
  independently-capped branches: SENT-aged `ORDER BY sent_at ASC LIMIT $n`, FAILED-aged
  `ORDER BY created_at ASC LIMIT $n`, each with its own budget. The FAILED branch now has a
  dedicated LIMIT so SENT volume can no longer crowd it out. The current code (audit-outbox-worker.ts:882-896)
  is a single un-capped, un-ordered union DELETE, confirming S1 was real. Residual: if the
  FAILED-aged backlog itself exceeds PURGE_BATCH_SIZE (1000) in a tick, `ORDER BY created_at ASC`
  drains oldest-first, so no individual FAILED row starves — the tail clears within ceil(backlog/1000)
  ticks (2.88 M/day FAILED capacity alone). Acceptable and honestly bounded. No finding.

- **S4 (R42) — RESOLVED, spec is correct.** Verified the four `writeDirectAuditLog`-emitted
  actions against the code: AUDIT_OUTBOX_DEAD_LETTER (:492, :816), AUDIT_OUTBOX_REAPED (:823),
  AUDIT_OUTBOX_RETENTION_PURGED (:908), AUDIT_DELIVERY_DEAD_LETTER (:695). The widened forbidden
  alternation `AUDIT_OUTBOX_(DEAD_LETTER|REAPED|RETENTION_PURGED)|AUDIT_DELIVERY_DEAD_LETTER`
  covers exactly these four. The regex prefix `(enqueueAudit|logAudit)\w*\(` correctly matches
  the real emitters logAuditAsync/logAuditAsyncBothScopes/logAuditBulkAsync/enqueueAuditInTx.
  `OUTBOX_BYPASS_AUDIT_ACTIONS` (audit.ts:859-867) has SEVEN members; the other three
  (WEBHOOK_DELIVERY_FAILED, TENANT_WEBHOOK_DELIVERY_FAILED, AUDIT_DELIVERY_FAILED) are
  legitimately NOT emitted via writeDirectAuditLog — the two webhook actions go through the
  normal outbox via `logAuditAsync` (webhook-dispatcher.ts:323-325, :411), and AUDIT_DELIVERY_FAILED
  has no runtime emitter at all. The C5 completeness assertion ("either in this forbidden
  alternation OR documented as never emitted via writeDirectAuditLog") therefore correctly
  requires an allow-set of exactly those three, and is well-specified. Adding the three webhook/
  delivery-failed actions to the forbidden alternation would be a false positive (they must use
  logAudit). No finding.

- **S5 (exemption tightness gate) — NOT fully closed. See S6 below.** The gate regex
  `/WHERE\s+\w+\s*=/` is too loose to certify single-row boundedness.

- **S2 / S3 (SC6 / SC7) — RESOLVED, documentation honest.** SC6: each direct-audit write is
  attributed to the row's own tenant_id (row.tenant_id at :816/:823, result.sampleTenantId at
  :908) — the global reaper cap delays only the *operational* REAPED/DEAD_LETTER/RETENTION_PURGED
  event, never the primary chained `audit_logs` delivery, and never crosses tenant isolation.
  Honest, genuinely low-severity. SC7: writeDirectAuditLog swallows insert failures with a warn
  (:428-433, verified), losing audit-UI operational-event visibility but with a compensating
  structured deadLetterLogger.warn line and no loss of chained-primary audit integrity. Honest.
  No finding.

- **C7 `inserted` boolean (new in round 2) — no security impact.** `deliverRowWithChain` is
  called only from processBatch (audit-outbox-worker.ts:1065) and integration tests; grep
  confirms no API route or client consumes it. The `inserted` boolean reflects only the
  INSERT-won-vs-ON-CONFLICT outcome (keying off the existing `inserted.length > 0` anchor gate
  at :339) — state already observable via the audit_logs row count. Exposing it out of the
  function leaks nothing to any external boundary and changes no posture. No finding.

## Security Findings (round 2)

**S6 — Minor: S5 exemption tightness gate `/WHERE\s+\w+\s*=/` does not reliably discriminate
single-row statements — an unbounded multi-row sweep with any equality predicate in its subselect
passes the gate.** The plan uses two different regexes: assertion 1(b) single-row pass is the
strict `/WHERE\s+id\s*=/`, but the S5 exemption-tightness gate (plan:210) is the loose
`/WHERE\s+\w+\s*=/` (loosened specifically to admit the anchor exemption's `WHERE tenant_id =`).
The loose form matches ANY `WHERE <col> =`, including a non-unique equality inside a multi-row
sweep's subselect. Concretely: `reapStuckRows`'s UPDATE (audit-outbox-worker.ts:788-802) contains
`WHERE status = 'PROCESSING'` (:798); retention-gc deletes contain `WHERE tenant_id = $1::uuid`
in their subselects (sweep.ts:416). If a future change removed the `LIMIT` from such a sweep and
added an exemption pointing at it, the tightness gate would find the subselect's `WHERE status =`
/ `WHERE tenant_id =` and PASS, granting boundedness to a genuinely unbounded sweep — exactly the
bypass S5 aimed to prevent.
- **Impact:** Defense-in-depth CI-guard weakness only — NO runtime security hole. The current
  sole exemption (anchor advance, single-row by PK, :341) is genuinely bounded; the shipped diff
  is correct. The gap is that the guard *could* be talked into exempting a future unbounded sweep.
  No cross-tenant exposure, no audit-integrity loss, no data exposure.
- **Recommended action:** Tighten the S5 gate so the equality predicate must bind the target
  table's primary key / a unique column, not any column. Cheapest robust form: require the
  exemption's identified statement to be a single-statement UPDATE/DELETE whose ONLY `WHERE` is a
  PK/unique-column equality with NO subselect (`/^\s*(UPDATE|DELETE FROM)\s+\S+\s+SET\b.*\bWHERE\s+\w+\s*=\s*\$\d/`
  applied to a statement asserted to contain no `SELECT`), OR maintain an explicit allow-list of
  (table,column) PK pairs the gate accepts (audit_chain_anchors.tenant_id). Add a self-test
  fixture: an unbounded `UPDATE audit_outbox ... WHERE id IN (SELECT id ... WHERE status = 'x')`
  with an exemption pointing at it MUST be rejected. The plan's C5.3 self-test case (e) currently
  only proves an over-broad `match` on `DELETE FROM x WHERE status='SENT'` is rejected — but that
  fixture has no `WHERE id =`/PK equality at all, so it does not exercise the subselect-equality
  bypass; add the subselect fixture.

## Round-2 conclusion

S1, S4, S2/S3, and the new C7 change are correctly resolved and honestly documented. The only
residual security-relevant item is **S6 (Minor)** — a defense-in-depth loosening of the S5 gate
that does not affect the shipped diff's correctness but weakens the guard against a future
unbounded sweep. No Critical/Major findings. No cross-tenant data exposure, no audit-chain
integrity loss, no injection surface (all new SQL is parameterized `$n`, verified). Plan is
GO from the security viewpoint with S6 as a recommended tightening.

## Recurring Issue Check (round 2, Security)

R1 pass · R3 flag (S6 — R42-adjacent: the S5 gate is a class-boundedness guard whose member-test
regex is too loose) · R14 pass (no new DB role/grant; writeDirectAuditLog uses existing bypass
GUCs) · R27 n/a · R31 pass (all C1–C3 changes add bounds; SQL stays parameterized) · R42 flag
(S6 — the boundedness *predicate* under-constrains, distinct from the member-set which is
correctly code-derived per INV4) · RS2 n/a · RS3 n/a · RS5 n/a · RT4 pass (C7 inserted-discriminator
is a genuine anti-vacuous guard) · RT5 pass (exemption gate + self-test share the extracted pure
classifier) · RT7 pass · RT8 pass

```json
[{"id":"S6","severity":"Minor","title":"S5 exemption tightness gate /WHERE\\s+\\w+\\s*=/ passes unbounded sweeps with any equality predicate in a subselect","file":"docs/archive/review/worker-runtime-invariants-plan.md","line":210,"adjacent":false,"escalate":false}]
```

---

# Plan Review: worker-runtime-invariants — Round 3 (convergence)
Date: 2026-07-15
Review round: 3

## Changes from Previous Round
Round-2 raised T1-R2 (Major), T-NEW (Major), S6 (Minor), T-NEW-2 (Minor). All applied.
Round-3 convergence check verified each fix against source and re-ran the M-c coherence
pass; it surfaced one new same-class miss (T-NEW-3), now fixed.

## Round-2 resolution verification
- **T1-R2 (Major) — RESOLVED.** C7 makes exactly-one-inserted the PRIMARY non-vacuous
  guard; the unmeasurable `$transaction`-boundary overlap assertion is removed (demoted to
  an optional best-effort wall-clock signal); lock_timeout-inconclusive handling kept.
- **T-NEW (Major) — RESOLVED (with T-NEW-3 follow-on).** C7 walkthrough now enumerates the
  three return-consuming integration tests with the `.delivered` rule and the
  "never `.inserted` / never truthy-check on the whole object" caveat.
- **S6 (Minor) — RESOLVED.** C5 exemption gate tightened to top-level PK/unique equality
  with no subselect; C5.3 adds negative fixture (f) (subselect-internal equality rejected).
- **T-NEW-2 (Minor) — RESOLVED.** Review-record "10 files" miscount corrected to
  "9 rg-derived + retention-gc-* suite".

## M-c coherence pass — PASS
Exactly-one-inserted under `raceTwoClients` is a genuine race (RT4): `raceTwoClients`
supplies real `Promise.all` contention on the same claimed row; the `inserted`
discriminator is a real observable keyed off the production `:339` `INSERT ... RETURNING`
signal — a broken interleave (both insert) falsifies it, a serial run cannot fake it.
Dropping the mandatory overlap assertion does not weaken M-c (it was unmeasurable → added
no falsifiability). `audit-chain-ordering` is the valid precedent (race test, no overlap
assertion). M-c satisfied.

## New finding (Round 3) — FIXED
**T-NEW-3 — Major: C7 walkthrough misclassified `audit-chain-ordering.integration.test.ts`
as discarding the return.** It actually destructures `const [deliveredA, deliveredB] =
await raceTwoClients(..., (c) => deliverRowWithChain(...), ...)` (:97-105) and asserts
`.toBe(true)`, so the `boolean → {delivered, inserted}` change breaks it. Same miss-class
as the original T-NEW (a return-reader mislabeled as a discarder). → C7 walkthrough
corrected: `audit-chain-ordering` moved to the `.delivered`-reader list
(`expect(deliveredA.delivered).toBe(true)`); only `audit-chain-verify-endpoint` (:434, bare
`await`) genuinely discards.

## Quality Warnings
None.

## Convergence
All Round-2 findings resolved; the sole Round-3 finding (T-NEW-3) is a walkthrough
classification correction, now applied and grep-verified against source. No new logic or
production-contract change introduced by any Round-3 edit. Plan converged — all 8 contracts
locked.

## Recurring Issue Check (Round 3)
### Combined QA + Security reviewer
R40 pass (return-shape change: `.delivered` preserves the prior boolean for every reader) ·
R42 FINDING→FIXED (T-NEW-3: member-set re-derived from `rg 'deliverRowWithChain' src/`, all
readers now enumerated) · RT1 pass · RT4 pass (exactly-one-inserted genuine race) · RT5 pass
· RT7 pass (C5.3 self-test incl. subselect-equality negative; C8 raise-cap-above-seed) ·
RT9 pass · RS-* n/a (no new auth/crypto surface)
