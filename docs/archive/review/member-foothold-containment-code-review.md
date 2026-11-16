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
