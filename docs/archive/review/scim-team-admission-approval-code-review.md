# Code Review: scim-team-admission-approval
Date: 2026-11-03
Review round: 1

## Changes from Previous Round
Initial review (Ollama seeds unavailable; full-diff review by all three experts).

## Functionality Findings
- F1 [Major] Approve refusals for a target who left the tenant (409 CONFLICT), 429 and
  reject's 403 surface as "network error"; a departed user's pending row carries no
  marker, so Approve is offered where it always fails.
- F2 [Minor] SCIM member values are not uuid-validated, lowercased or de-duplicated: a
  repeated or upper-case id reaches `createMany` (P2002 → 500), a non-uuid the
  `::uuid[]` cast (22P02 → 500). Pre-existing, in a changed file.
- F3 [Minor] PATCH `SCIM_GROUP_UPDATE` carries no transition-derived `added`/`removed`.
- F4 [Minor] `check-critical-audit-atomic.mjs` comment says confirm-key emits in bulk.
- F5 [Minor] The reject dialog's cancel reuses `cancelInvitation` (ja 取り消す).
- F6 [Minor] One-by-one approval under a 30/hour limit for large IdP groups.

## Security Findings
- S-F1 [Major, escalate: false] A SCIM role raise after approval is not covered by the
  approver's role pin (plan-accepted residual; user decision requested).
- S-F2 [Minor] Reject is not sticky; the next sync re-creates the request.
- S-F3 [Minor, Adjacent] SCIM member value not uuid-validated / case-normalised (= F2).
- No path activates a pending row or hands it a key without approval (writers and
  readers enumerated in the expert's output).

## Testing Findings
- T1 [Major] The A14 accept cells cannot tell throw→rollback from return→commit.
- T2 [Major] A10 `auditRows` drops scope/actorType; `scimTokenId` asserted on one row.
- T3 [Major] `SCIM_GROUP_UPDATE` added/removed never asserted (A4, A5b).
- T4 [Major] A6, A8 other-team and A12 denial cells lack the no-approve-audit check.
- T5-T12 [Minor] confirm-key cell label; A7e fixture hygiene; A11 positive control; A6
  precondition; duplicate unit fixtures; gate rule 7 allow fixtures; bulk enqueue
  allow cell; hard-coded advisory key format in A7c.

## Adjacent Findings
- S-F3 (security → functionality), merged with F2.

## Quality Warnings
None.

## Recurring Issue Check
Functionality: R3 (F1), R8 (F5), R29 (F4); R4, R11, R12, R17, R37, R38, R42, R48 clean.
Security: R49 (S-F1), R34 (S-F3); R1-R6, R9, R12, R14, R18, R24, R29, R31, R38, R39,
R42, R43, R51, R52, RS2, RS3 clean.
Testing: RT1/RT5 (T1), R42 (T2), RT8 (T4), RT10 (T10, T11), RT3 (T12); R12, R16, R19,
R35, R36, RT2, RT4, RT6, RT11 clean.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1.

## Resolution Status
- S-F1: user decision (2026-11-03): keep the residual and make it explicit — the
  approval UI and the SCIM spec state that the IdP can later change an approved
  member's role (up to ADMIN, never OWNER) without approval, recorded in the team audit
  log and webhooks; follow-up issue for approval-gated role raises.
