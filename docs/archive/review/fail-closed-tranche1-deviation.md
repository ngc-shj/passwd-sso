# Coding Deviation Log: fail-closed-tranche1

## D1 — C5 filename (2026-07-18, Batch 1)
Plan named `src/__tests__/db-integration/rate-limit-fail-closed.integration.test.ts`;
that path already exists on main (PR #473, AC5.4a — audit_outbox emission
coverage) and must not be overwritten. C5 implemented as
`rate-limit-fail-closed-chain.integration.test.ts` (header comment explains).
Pre-existing file untouched and still green (3/3). No gate references the
literal C5 filename (checked: check-fail-closed-routes-have-test.sh iterates
route files, not integration-test filenames).

## D2 — C5 teardown settle delay (2026-07-18, Batch 1)
`checkRateLimitOrFail` fires `void emitRateLimitFailClosed(...)`; the
integration test drains 200ms BEFORE `deleteTestData` to avoid an FK race
against the just-deleted tenant. Inherent to the production fire-and-forget
design (documented in rate-limit-audit.ts), not a product bug.

## D3 — C6 case count (2026-07-18, Batch 1)
Plan's C6 case (7) implemented as two cases (Retry-After absent / non-numeric);
8 vitest cases total for the 7 plan cases. Superset of the contract.

## D4 — Comment-literal gate interaction (2026-07-18, orchestrator)
Batch B's explanatory comment in extension/token/route.test.ts contained the
literal option text, inflating the gate's instantiation count to 70 (expected
69). Reworded the comment; gate green. Class note: the gate counts the literal
across all files under src/app/api — test-file comments must avoid it.

## D5 — Phase 2-5 self-R-check folded into Phase 3 (2026-07-18, orchestrator)
The three implementation batches each ran R19/R21/C4 checks and full per-file
verification; the separate Phase 2-5 mini R-check pass is folded into Phase 3
Round 1 (whose experts run the full R1–R44/RS/RT checklist over the same diff).
Cost-justification: avoids a duplicate 3-agent pass over an unchanged diff.

## D6 — Batch C attribution pattern unified post-hoc (2026-07-18, orchestrator)
Batch C hand-rolled capture+replay before snapshotFactory landed (parallel
batches); refactored the 5 files to the shared utility (cross-batch dedup),
identical pass counts (64/64).

## D7 — C1 API extended post-lock by Phase 3 P3-F1 (2026-07-18)
`failure` fixture param added as REQUIRED to assertRedisFailClosed (gate
literal must be code, not comment). Plan C1/C2/C6 text updated in place;
contract re-verified by Phase 3 Round 2 (No findings). C6 case 6 rebuilt per
P3-F2 with scratch-copy discrimination proof.
