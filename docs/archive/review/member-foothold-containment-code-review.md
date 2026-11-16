# Code Review: member-foothold-containment
Date: 2026-11-17
Review round: 1

## Changes from Previous Round
Initial review (incremental on a clean Phase 2 self R-check). Ollama seeds unavailable; full-diff review.

## Functionality Findings
- F1 Minor — `base-webhook-card.tsx` comment says `creatorAuthorized` is team-only.
- F2 Minor — tenant `creatorPaused` promises delivery resumes on regaining access; the departure-record rule prevents that after a hard delete and re-creation.
- F3 Minor — the "true or legacy" delivery filter repeats in the dispatcher and both worker branches.
- F4 Minor — the outbox backfill casts `payload->>'userId'` to uuid; a non-uuid value would abort the migration.

## Security Findings
- S1-1 Minor [Adjacent] — C9 operator docs for the webhook pause and departure revocations missing.
- S1-2 Minor — SA / MCP-client PUT gated only on re-activation; scope and redirect-URI widening ran ungated against a concurrent demotion or containment.
- S1-3 Minor (informational) — `MCP_CLIENT_CONSENT` gains a narrow `session` read for `isSessionRowLive`.

## Testing Findings
- T-1 Major — acceptance cells missing in `tenant-member-passkey-revoke.integration.test.ts`: containment + departure concurrently without 40P01; `remaining` counting a foothold created after the listing.
- T-2 Minor — departure-race / fence cells live in the gate file; no pointer.
- T-3 Minor — C3 dispatcher cell's "not delivered" assertion races parallel chunk delivery.
- T-4 Minor — tautological `backendsBlockedBy` assertion after the request completed.

## Adjacent Findings
- S1-1 (docs).

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1-R28 ok | R29 F1 | R30-R57 ok | RS* N/A | RT* N/A
### Security expert
R1-R20 ok | R21 N/A | R22-R57 ok | RS1 ok | RS2 ok | RS3 S1-2 | RS4-RS6 ok
### Testing expert
R1-R41 ok | R42 ok | R43-R57 ok/N/A | RT1-RT3 ok | RT4 ok | RT5-RT6 ok | RT7 T-1, T-3, T-4 | RT8-RT11 ok

## Environment Verification Report
N/A — no environment constraints declared in Phase 1. Integration suite: 161/169 files pass locally; the 8 failing files need MinIO or a migration-created database (deviation log, "Environment").

## Resolution Status
### T-1 Major — missing acceptance cells
- Action: added the concurrent containment + departure cell (no 40P01) and the `remaining`-after-listing cell.
- Modified file: src/__tests__/db-integration/tenant-member-passkey-revoke.integration.test.ts
### T-2, T-3, T-4 Minor
- Action: header pointer; dispatcher skip asserted through its skip log (emitted before delivery starts); tautological assertion removed.
### F1, F2 Minor
- Action: comment corrected; tenant `creatorPaused` (en/ja) no longer promises an unconditional resume.
### S1-1 Minor
- Action: operator doc section on tenant-webhook creator authority, upgrade-time pause, departure revocations and flags.
### S1-2 Minor
- Action: SA / MCP-client PUT take `lockFootholdWriter` for any edit that grants or widens (re-activation, scopes, redirect URIs); deactivate-only and display-only edits stay ungated.
### F3 Minor — Skipped
- **Anti-Deferral check**: acceptable risk.
- **Justification**: worst case — a fourth copy of a one-line predicate drifts; likelihood low (each copy is pinned by its own delivery cell and the C10 reader gate requires the verdict call); cost to fix — sharing it means the team module importing the tenant module (or a third module) for one expression, against the deliberate team/tenant split.
- **Orchestrator sign-off**: skip.
### F4 Minor — Skipped
- **Anti-Deferral check**: acceptable risk.
- **Justification**: worst case — the migration aborts and must be re-run after cleaning one outbox row; likelihood — nil in practice: HUMAN audit rows are written from `tenantAuditBase(req, session.user.id, …)`, always a uuid, and the merged `20261114000300_team_webhook_creator` uses the identical cast; cost to fix — editing a migration already applied in developer databases changes its checksum (Prisma drift).
- **Orchestrator sign-off**: skip.
### S1-3 — No action (informational)

---

# Code Review: member-foothold-containment
Date: 2026-11-17
Review round: 2

## Changes from Previous Round
Round-1 fixes (commit 0ad5227bf): S1-2, T-1–T-4, F1, F2, S1-1 resolved; F3, F4 skipped with Anti-Deferral; S1-3 informational.

## Functionality Findings
- F1-r2 Minor (new) — plan row for the MCP-client PUT still states the re-activation-only gate. → plan C5 table split into the SA and MCP-client rows with the presence condition.
- F2-r2 — service-account PUT comment accurate; no action.

## Security Findings
No findings (S1-2 fix verified as a narrowing per R43; pause text verified against `creatorVerdicts`).

## Testing Findings
- T2-1 Major (new) — the concurrent containment/departure cell accepted a containment-side deadlock victim (mapped to a 409 without "40P01" in the body). → both sides must fulfil; containment must answer 200 or 404; five pairs.
- T2-2 Minor — `remaining` cell sound; creator filter covered by other cells. No action.
- T2-3 Minor — "without blocking" cell had only a timeout as proof. → `settledOrBlocked` observed while the held change is open.

## Recurring Issue Check
### Functionality expert
R43 ok (safe direction) | others ok
### Security expert
R1-R57 ok/N/A | RS1-RS6 ok | R43 ok
### Testing expert
RT4 ok | RT7 T2-1, T2-3 | others ok

## Resolution Status (round 2)
### T2-1 Major — concurrent cell blind to a containment-side deadlock
- Action: requires both promises fulfilled, containment status in {200, 404}, five pairs.
- Modified file: src/__tests__/db-integration/tenant-member-passkey-revoke.integration.test.ts
### T2-3 Minor
- Action: non-blocking observed with `settledOrBlocked` before release.
- Modified file: src/__tests__/db-integration/foothold-write-gate.integration.test.ts
### F1-r2 Minor
- Action: plan C5 table rows corrected.

---

# Code Review: member-foothold-containment
Date: 2026-11-17
Review round: 3

## Changes from Previous Round
Round-2 fixes (a76d5726d) verified: T2-1, T2-3, F1-r2 resolved; production unchanged in that commit.

## Functionality / Security Findings
No findings (plan row matches the MCP-client PUT gate; R43: no predicate changed).

## Testing Findings
- QA-R3-1 Minor — the concurrent cell's comment claimed a 409 mapping the containment route does not have; the assertions are sound.
- QA-R3-2 Minor — the interleaving is probabilistic (the cell says it is not an ordering proof; rule 9 and the held-transaction cells are).
- QA-R3-3 Minor — no recorded red-proof for the concurrent cell.

## Recurring Issue Check
### Functionality / Security expert
R1-R57 ok | RS1-RS6 ok | R43 ok
### Testing expert
RT4 ok | RT7 QA-R3-3 | others ok

## Tightening-only skip — Round 3
Findings applied directly (no Round 4 review):
- QA-R3-1 [Minor] comment wording — src/__tests__/db-integration/tenant-member-passkey-revoke.integration.test.ts — applied verbatim.
Justification: within Round 2's fix range, comment-only, no security-boundary touch.

### QA-R3-2 Minor — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**: worst case — an infrequent deadlock between containment and a departure is not caught by this cell; likelihood low — the lock order it would need to violate is pinned structurally by rule 9 of `check-team-rotation-input-lock.mjs` (ordered callee, red self-tests) and by the held-transaction cells; cost to force the interleave — a mid-transaction pause hook in production code, rejected in plan round 3 (T3-2).
- **Orchestrator sign-off**: accept.

### QA-R3-3 Minor — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**: worst case — the cell's deny side is unproven by mutation; likelihood of a vacuous pass is low — the assertions are positive (`fulfilled`, status in {200, 404}, exactly one audit row per pair) and any rejection or error status fails them; cost — a deterministic red-proof needs the reversed lock order AND a forced overlap, which is the same pause hook as QA-R3-2. The ordering itself is red-proved by the rule-9 self-test (wrong-order case).
- **Orchestrator sign-off**: accept.

## Termination
Round 3: no Critical or Major from any expert; remaining Minors applied or accepted above. R42 class (foothold writers, delivery readers, departure writers): closed by mutation-verified guards — `src/__tests__/foothold-member-set.test.ts` (red-proven: gate call removed from a copy of the SCIM-token POST → unclassified write) and rule 9 of `scripts/checks/check-team-rotation-input-lock.mjs` (red self-tests: missing / out-of-order / foreign-exemption / branch), both run by `npx vitest run` in CI and `scripts/pre-pr.sh`.
