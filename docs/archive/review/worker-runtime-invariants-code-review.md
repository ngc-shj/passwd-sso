# Code Review: worker-runtime-invariants
Date: 2026-07-15
Review round: 1

## Changes from Previous Round
Initial code review. Three experts reviewed `git diff main...HEAD` against the plan
(C1-C8, INV1-INV5, forbidden patterns) and deviation log (D1-D4 + R21 process note),
running the manifest guard (19 pass), mock unit suite (31 pass), and C6/C7/C8 integration
tests. Result: Functionality clean, Security clean (one [Adjacent]/Minor trust-boundary
note, no offender), Testing one Minor (documented accepted residual). No Critical/Major.

## Functionality Findings
No findings. Verified per focus area:
- C3 two-branch purge split correct: SENT-branch NOT EXISTS intact, both branches
  ORDER BY correct cutoff col (sent_at ASC / created_at ASC), disjoint-by-status → no
  double-count, single summed RETENTION_PURGED emission, capped deliveries DELETE.
- C1/C2 ORDER BY/LIMIT before FOR UPDATE SKIP LOCKED — syntactically correct.
- deliverRowWithChain return-shape: sole production consumer processBatch reads
  .delivered; both return sites carry {delivered, inserted}; no bare-boolean path.
- runReaper callers bind defaults, no arg change.
- Caps drain remainders next tick, no infinite loop / no silent drops.
- R42 member-set re-derived by AST: 13 sweep statements, exactly 4 capped + 1 anchor
  PK-exemption, no new unbounded sweep.

## Security Findings
No findings.
- INV3 holds: all 5 operational-event writes go through private writeDirectAuditLog
  (chain_seq/event_hash/chain_prev_hash/outbox_id NULL); none routed through
  enqueueAudit*/logAudit*; writeDirectAuditLog never exported/imported. ON CONFLICT DO
  NOTHING preserved.
- C3 split preserves FAILED-row data-minimization: FAILED branch ORDER BY created_at ASC
  (oldest-first), own LIMIT budget — no PII-bearing row lives longer than before.
- No raw-SQL injection: all new ORDER BY/LIMIT use literal columns + bound params.
- C5 tightness gate sound + CI-wired (normal vitest job, not orphaned): rejects broad
  match via unused/ambiguous/loose-exemption; loose gate requires single-row PK/unique
  WHERE + no subselect.
- .inserted exposure: same-tenant, test-only consumption, no cross-tenant leak.
- setBypassRlsGucs tx-local; per-row tenant attribution; MIN(tenant_id) only a metadata
  sample.

## Testing Findings
**RT7-C8 (Minor)** — audit-outbox-sweep-caps.integration.test.ts:94 (also :281/:317): the
cap-proof assertions retain a narrow flakiness window against the SHARED dev DB — the
co-running docker `passwd-sso-audit-outbox-worker-1` reaper could reap ≥2 of the test's
own eligible rows in the ~200ms window, dropping the surviving count to 0. **CI uses an
isolated dedicated Postgres, not the shared dev container, so this vector does not exist
in CI.** Observed 0 flakes in 8 runs. This is the accepted-residual class already
documented in deviation log D3. Reviewer conclusion: no code change warranted — the
robust fix (isolated DB) is already CI's default. Disposition: documented, no fix.

## Adjacent Findings
- [Security → Functionality/doc] TIGHT_PK_WHERE_RE accepts `WHERE tenant_id =` because
  the anchor table's PK is tenant_id; a hypothetical future exemption on a multi-row
  `DELETE FROM audit_outbox WHERE tenant_id = $1` would be wrongly accepted as tight. No
  such offender in the diff; explicitly-stated INV5 trust boundary (table/param semantics
  beyond regex/AST-lite scope). Not a finding.
- [Testing → doc] Plan prose (line 175/220) says `REAP_BATCH_SIZE = 1000` "plain
  literals" / `MAX_ATTEMPTS: 8`; production has `MAX_ATTEMPTS: envInt("OUTBOX_MAX_ATTEMPTS",
  8)`. Manifest assertion 13 expects the envInt form, so test↔code self-consistent (no
  drift); only plan prose is stale shorthand. Not a defect.

## Quality Warnings
None — all findings carry file/line evidence and verified repro.

## Recurring Issue Check
### Functionality expert
R2 pass · R19 pass · R20 pass · R40 pass · R42 pass (member-set AST-re-derived) · R21
noted (deviation residue grep-verified) · RT4/RT7 present (test scope). Others n/a.

### Security expert
R42 pass (deliverRowWithChain + writeDirectAuditLog caller sets re-derived) · RS1-RS6
pass (C7 cross-boundary contract, all readers updated to .delivered) · R9 pass (webhook
fire-and-forget unchanged) · others n/a.

### Testing expert
RT1 pass (D2 fixed real mock divergence) · RT4 pass (C7 non-vacuous) · RT5 pass · RT6
pass · RT7 pass (C5 self-test + C8 red-first) · RT8 pass (C6 asserts mutation) · R19 pass
· R20 pass · R21 clean (residue verified) · R32 n/a · RT9 pass (classifySweeps
single-sourced). RT7-C8 Minor (documented residual).

## Environment Verification Report
Plan VC-DB: all contracts `verifiable-local` — verified-local:
- `npx vitest run` → 12292 passed / 1 skipped (unit).
- `npx vitest run --config vitest.integration.config.ts <10 files>` → 24 passed (C6/C7/C8
  + regression gate, real Postgres).
- `npx next build` → compiled successfully, 243 static pages.
- `npm run lint` → clean.
No VC1/VC2/VC3 (macOS/cosign/container) paths touched → N/A.

## Resolution Status
- Functionality: no findings — nothing to resolve.
- Security: no findings; the [Adjacent] trust-boundary note is an INV5-documented
  boundary with no current offender — accepted, no action.
- Testing RT7-C8 (Minor): accepted residual, already documented in deviation log D3; CI's
  isolated DB avoids the vector; reviewer concluded no code change warranted. No fix
  applied. **Anti-Deferral**: Worst case — a local (not CI) shared-dev-DB run of the cap
  test flakes to a false failure; Likelihood — low (0/8 observed, CI unaffected);
  Cost-to-fix — a code change would not improve CI (already isolated) and local isolation
  is out of this PR's scope. Accepted as documented residual.

Convergence: Functionality + Security return No findings; Testing's sole finding is a
Minor documented-residual requiring no code change. All contracts remain locked. Review
converged in Round 1.

---

# Code Review: worker-runtime-invariants — Round 2 (external security review)
Date: 2026-07-15
Review round: 2

## Changes from Previous Round
An external security review of the branch raised 3 findings that the triangulate
Phase-3 pass had missed or mis-dispositioned. All three fixed on this branch (commit
"fix(worker): make purge audit atomic, suppress duplicate webhook, tighten sweep guard").
Two were pre-existing / mis-scoped; per user ruling, "pre-existing" is a provenance note,
never a reason to skip — and the SC3 at-least-once webhook policy itself was wrong.

## Findings and resolution

**EXT-1 (High) — purge partial-success loses the audit trail.** The C3 SENT/FAILED
two-branch split (this PR's own change) emitted AUDIT_OUTBOX_RETENTION_PURGED only AFTER
both txs committed. If the SENT tx commits and the FAILED tx then throws, a destructive
delete succeeded with no audit record — a new partial-commit boundary (pre-split it was a
single outbox-DELETE tx). This is a genuine gap the Phase-3 review missed (it accepted
"emission was already non-atomic" without noticing the SENT-committed-but-emission-skipped
window).
→ FIX: added a private `writeDirectAuditLogInTx(tx, ...)` (byte-identical INSERT, no own
tx, no error-swallow — rolls back the caller's tx). Each purge branch now emits its own
RETENTION_PURGED INSIDE its DELETE tx, so delete + audit commit atomically. `writeDirectAuditLog`
refactored to wrap `writeDirectAuditLogInTx` in its own tx (existing callers unchanged).
Both stay unexported (INV3). Up to two events/tick (per-branch counts). Regression:
`audit-outbox-retention-purge-audit-atomicity.integration.test.ts` — happy-path two-event,
single-branch one-event, and the core atomicity test (a test-side prisma Proxy rejects the
2nd $transaction → asserts SENT delete + its audit row committed, FAILED untouched, call
rejects). Chain columns NULL (INV3) asserted.

**EXT-2 (Medium) — duplicate webhook on conflicting re-delivery.** Pre-existing: main also
dispatched the webhook whenever `delivered:true`, and `deliverRowWithChain` returned true
unconditionally, so a reaper-re-enqueued row delivered by two workers (ON CONFLICT → one
audit_logs row) dispatched the webhook twice. The Phase-3 review dispositioned this as
"SC3 at-least-once, accepted" — WRONG per user: the SC3 policy itself was the bug.
→ FIX: `deliverRow`/`deliverRowWithChain` gate the delivery enqueue
(`enqueueWebhookDeliveryInTx` + `enqueueAuditDeliveriesInTx`) on the `inserted` discriminator
INSIDE the winning audit tx; a conflicting re-delivery (delivered:true, inserted:false) marks
the row SENT but enqueues nothing. There is no post-commit `dispatchWebhookForRow` /
`fanOutDeliveries` in `processBatch` anymore — both delivery kinds are durable, in-tx, and
idempotent. Regression: `webhook-delivery-durable.integration.test.ts` (T-dedup) asserts the
conflicting re-delivery adds no second webhook_deliveries row via the `{inserted}` discriminator
AND a by-outbox-id row count; `audit-outbox-worker-fanout.integration.test.ts` (M2) asserts the
same for audit_deliveries rows.

**EXT-3 (Low) — sweep guard's single-row pass matched subselect-internal `WHERE id =`.**
This PR's own C5 classifier: pass-condition (b) `SINGLE_ROW_BY_ID_RE.test(statement)` matched
`WHERE id =` anywhere, so an unbounded `DELETE ... WHERE col IN (SELECT ... WHERE id = $1)`
would pass. The tightness gate already had `!HAS_SUBSELECT_RE` but condition (b) did not.
The Phase-3 security review examined TIGHT_PK_WHERE_RE but missed condition (b).
→ FIX: condition (b) now requires `!HAS_SUBSELECT_RE.test(statement)` too. New self-test
fixture (g) proves an unbounded DELETE whose only id-equality is subselect-internal is
flagged `unbounded`. Real worker sweeps stay green (no false-positive).

## Verification
- `npm run lint` — clean
- `npx vitest run` — 12293 passed / 1 skipped (+1 for the new atomicity/dedup tests)
- Regression gate + new integration tests (9 files) — 19 passed × 2 stable runs
- `npx next build` — compiled successfully
- Forbidden patterns / INV3 (bypass actions on direct-write path only; helpers unexported) —
  clean. R21 residue — clean (no production mutation cycle; residue grep verified).

## Process note
Two of the three findings were pre-existing (EXT-2) or a mis-scoped policy (SC3) / this
PR's own new guard (EXT-3). Per user ruling, "pre-existing / not introduced by this PR" is
a correct provenance classification but NEVER a disposition to skip — fixed here. Recorded
in memory: pre-existing-in-changed-file and a mis-classified scope-out are both fixed, not
deferred. The Phase-3 triangulate review's misses (EXT-1 atomicity window, EXT-2 SC3
mis-acceptance, EXT-3 condition-(b) gap) are the value the external review added.

## Convergence
All 3 external findings fixed + regression-tested. Full suite green. Branch ready.
