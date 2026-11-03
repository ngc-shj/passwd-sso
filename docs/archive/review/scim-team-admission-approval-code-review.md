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

---

# Code Review: scim-team-admission-approval
Date: 2026-11-03
Review round: 2

## Changes from Previous Round
Round 1 findings resolved in `c3d2a342f` (all but S-F1, F6, S-F2, which were
accepted/deferred — see Resolution Status). This round reviews the diff since
that commit: the approve 409 split, the predictor fix, uuid parity, PATCH
operation order, and the test gaps those changes left behind.

## Security Findings
- S-R2-1 [Major] `team-member-display.ts`'s `pendingTenantInactive` answered
  "which one active tenant does this user have" via a last-wins `Map` keyed
  by userId, not "is this user active in the TEAM's own tenant" — the same
  question approve asks with a CAS re-read. A user active in two tenants at
  once (the single-active-tenant invariant only momentarily violated) could
  be flagged `pendingTenantInactive` or not depending on row order, hiding
  the Approve button or offering one that always 409s.
- S-R2-2 [Major] Approve's 409 conflated two outcomes under the generic
  `CONFLICT` code: the target having left the tenant (a terminal state —
  reject instead) and a CAS miss / lock conflict (a transient state — retry).
  The UI could not tell them apart and showed "reject the request instead"
  for a transient conflict too.
- S-R2-3 [Minor] Round 1's Resolution Status section recorded only S-F1; F1-F6,
  S-F2, S-F3 and T1-T12 were resolved in `c3d2a342f` but never logged.

## Functionality Findings
- F-N1 [Major] (= S-R2-2) Approve's `TENANT_INACTIVE` and `CAS_FAILED` /
  lock-conflict outcomes both answered `CONFLICT` (409).
- F-N2 [Minor] The list page mapped `CONFLICT` to "this user left the
  organization" for approve, but reject had no `CONFLICT` arm at all — a
  reject lock conflict fell through to the generic network-error toast.
- F-N3 [Minor] `patch-parser.ts`'s hand-rolled `UUID_REGEX` disagreed with
  the zod `.uuid()` validator `validations.ts` uses for PUT/POST: the regex's
  version/variant nibble ranges rejected the nil (`00000000-…`) and max
  (`ffffffff-…`) uuids that zod accepts as special cases — PATCH and PUT/POST
  validated different id shapes for the same field.
- F-N4 [Major] (RFC 7644 §3.5.2 pre-existing defect) `patchScimGroup` split
  `operations` into add/remove lists by filtering per op kind, discarding
  request order, then always ran `applyAddOperations` before
  `applyRemoveOperations`. A same-id `[remove X, add X]` and `[add X,
  remove X]` both resolved as "add wins" regardless of which op the IdP sent
  last.
- F-N5 [Major] (= S-R2-1) `pendingTenantInactive`'s last-wins `Map`.

## Testing Findings
- T-N1 [Major] (= S-R2-1/F-N5) No cell exercised a pending user active in
  two tenants at once; both createdAt orderings are needed to catch a
  last-wins regression.
- T-N2 [Major] (= S-R2-2/F-N1/F-N2) No cell distinguished approve's
  `TENANT_INACTIVE` 409 from its `CAS_FAILED` / lock-conflict 409 by error
  code; no cell covered reject's `CONFLICT` toast at all.
- T-N3 [Minor] (= F-N3) No cell asserted PATCH's member-value check and
  PUT/POST's schema agree on the same inputs.
- T-N4 [Minor] (= F-N3) No PUT/PATCH route cell exercised a repeated id in
  differing case collapsing to one write, or a non-uuid value 400ing through
  PUT/POST.
- T-N5 [Minor] A8's "member of another team" cell asserted no audit row
  under the pending row's own teamId, but not under the (wrong) teamId the
  mismatched call actually named.
- T-N6 [Minor] `Groups/[id]/route.test.ts`'s PUT describe lacked the
  `mockTeamMember.findMany`/`createMany`/`mockTenantMember.findMany` resets
  the PATCH describe added for T6 in round 1 — a leftover fixture could leak
  across PUT cells.
- T-N7 [Minor] (= F-N4) The patch-parser order test ("keeps add-then-remove
  order") proved only the parser's own output order; nothing proved the
  service actually consumed that order, or exercised the reverse ordering.

## Adjacent Findings
Merged groups (one fix per group): approve-409 conflation = S-R2-2/F-N1/F-N2/T-N2;
predictor drift = S-R2-1/F-N5/T-N1; uuid parity = F-N3/T-N4/T-N3; PATCH order =
F-N4/T-N7; A8 filter = T-N5; PUT reset = T-N6; resolution-status gap = S-R2-3.

## Quality Warnings
None.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1.

## Resolution Status

### Round 1 (`c3d2a342f`)
- F1: fixed — distinct toasts for approve/reject refusals; a pending row
  carries `pendingTenantInactive`.
  `src/app/api/teams/[teamId]/members/[memberId]/approve/route.ts`,
  `src/lib/team/team-member-display.ts`,
  `src/app/[locale]/admin/teams/[teamId]/members/list/page.tsx`.
- F2 / S-F3: fixed — member values uuid-validated, lowercased, de-duplicated
  at the boundary. `src/lib/scim/patch-parser.ts`, `src/lib/scim/validations.ts`.
- F3: fixed — `SCIM_GROUP_UPDATE` carries transition-derived `added`/`removed`.
  `src/lib/services/scim-group-service.ts`.
- F4: fixed — comment corrected (approve/reject/confirm-key use `logAuditInTx`,
  not bulk). `scripts/checks/check-critical-audit-atomic.mjs`.
- F5: fixed — reject's cancel button uses its own `cancel` key, not
  `cancelInvitation`. `src/app/[locale]/admin/teams/[teamId]/members/list/page.tsx`,
  `messages/{en,ja}/Team.json`.
- F6: deferred (D11) — one-by-one approval under the 30/hour limit stays;
  bulk approve is a follow-up issue if it matters in practice.
- S-F1: user decision (2026-11-03) — keep the residual and make it explicit:
  the approval UI and the SCIM spec state that the IdP can later raise an
  approved member's role (up to ADMIN, never OWNER) without approval,
  audited at team scope. **Follow-up issue to be filed with the PR.**
- S-F2: accepted — reject is not sticky by design (plan SC4); documented in
  `docs/architecture/tenant-team-scim-spec.md`.
- T1: fixed — accept's in-tx cells assert on the transaction callback's own
  settlement (reject vs resolve), not just the HTTP response.
  `src/app/api/teams/invitations/accept/route.test.ts`.
- T2: fixed — `auditRows`/`expectScimTeamAuditRows` assert scope, actorType
  and `scimTokenId` on every row, not just the first.
  `src/__tests__/db-integration/scim-team-admission-approval.integration.test.ts`.
- T3: fixed — `SCIM_GROUP_UPDATE.added`/`removed` asserted (A4, A5b) and at
  unit level. `src/__tests__/db-integration/scim-team-admission-approval.integration.test.ts`,
  `src/lib/services/scim-group-service.test.ts`.
- T4: fixed — A6, A8 (own team) and A12 denial cells assert no approve/reject
  audit row. `src/__tests__/db-integration/scim-team-admission-approval.integration.test.ts`.
- T5: fixed — confirm-key's "member gone" cell comment corrected (pre-read
  404, not a CAS miss). `src/__tests__/db-integration/scim-team-admission-approval.integration.test.ts`.
- T6: fixed — PATCH describe resets `findMany`/`createMany` fixtures per
  cell. `src/app/api/scim/v2/Groups/[id]/route.test.ts`.
- T7: fixed — A11's denial cells assert 200 with the owner's row present
  (positive control), not just the pending row's absence.
  `src/__tests__/db-integration/scim-team-admission-approval.integration.test.ts`.
- T8: fixed — A6's precondition (the departure committed; the tenant row
  shows it) is asserted before the refusal it feeds.
  `src/__tests__/db-integration/scim-team-admission-approval.integration.test.ts`.
- T9: fixed — duplicate string-literal fixtures replaced with shared uuid
  constants (forced by the F2 uuid-validation boundary).
  `src/app/api/scim/v2/Groups/[id]/route.test.ts`, `src/lib/scim/patch-parser.test.ts`,
  `src/lib/scim/validations.test.ts`.
- T10: fixed — gate rule 7 positive controls (`create`/`createMany` naming
  the pending marker) added alongside the existing negative cells.
  `scripts/__tests__/check-team-rotation-input-lock.test.mjs`.
- T11: fixed — bulk-enqueue allow cell (tenant matches, not bypass) added as
  the mirror of the existing mismatch cell. `src/__tests__/audit-outbox.test.ts`.
- T12: accepted as is (D11) — A7c's advisory-lock key stays a hard-coded
  literal; a drift fails loudly via `waitForBackendBlockedBy` timing out.

### Round 2
- S-R2-1 / F-N5 / T-N1 (predictor drift): fixed — `pendingTenantInactive`
  computed from a `Set` of userIds active in the team's own tenant, not a
  last-wins `Map`; throws if a pending row is given without `teamTenantId`.
  `src/lib/team/team-member-display.ts`, `src/lib/team/team-member-display.test.ts`,
  `src/app/api/teams/[teamId]/members/route.test.ts`.
- S-R2-2 / F-N1 / F-N2 / T-N2 (approve-409 conflation): fixed — new
  `SCIM_APPROVAL_TARGET_INACTIVE` (409) for the tenant-inactive outcome only;
  `CONFLICT` kept for the CAS miss and lock conflicts; the list page maps
  both approve and reject's `CONFLICT` to a "busy, try again" toast.
  `src/app/api/teams/[teamId]/members/[memberId]/approve/route.ts`,
  `src/lib/http/api-error-codes.ts`, `messages/{en,ja}/ApiErrors.json`,
  `messages/{en,ja}/Team.json`, `src/app/[locale]/admin/teams/[teamId]/members/list/page.tsx`,
  plus their `*.test.ts(x)` and the integration test.
- F-N3 / T-N3 / T-N4 (uuid parity): fixed — `patch-parser.ts` uses the same
  zod `.uuid()` validator as `validations.ts`; parity table and duplicate-id
  / malformed-value route cells added for PATCH, PUT and POST.
  `src/lib/scim/patch-parser.ts`, `src/lib/scim/patch-parser.test.ts`,
  `src/app/api/scim/v2/Groups/[id]/route.test.ts`, `src/app/api/scim/v2/Groups/route.test.ts`.
- F-N4 / T-N7 (PATCH operation order): fixed — `patchScimGroup` folds
  same-userId add/remove ops to the last one in request order before
  splitting; service-level cells for both orderings; the parser order test
  extended with the reverse ordering.
  `src/lib/services/scim-group-service.ts`, `src/lib/services/scim-group-service.test.ts`,
  `src/lib/scim/patch-parser.test.ts`. Recorded as a pre-existing defect
  (D13, deviation log).
- T-N5 (A8 filter): fixed — the "member of another team" cell also asserts
  no approve/reject audit row scoped to the mismatched (other) teamId.
  `src/__tests__/db-integration/scim-team-admission-approval.integration.test.ts`.
- T-N6 (PUT reset): fixed — the PUT describe's `beforeEach` resets the same
  three mocks the PATCH describe resets. `src/app/api/scim/v2/Groups/[id]/route.test.ts`.
- S-R2-3 (resolution-status gap): fixed — this section.

---

Review round: 3 (`6ad756659`)
- S-R3-1 / F-R3-1 [Major] The parser's per-kind first-wins dedup defeated the
  last-op-wins fold: `[remove X, add X, remove X]` resolved as add (a regression
  introduced by round 2). F-R3-2 [Minor] a fold-cancelled add skipped the
  not-in-tenant refusal. F-R3-3 [Minor] stale `teamTenantId` comment.
  T-R3-1 [Major] the operation-order cells passed on the pre-fix add-before-remove
  order through a positional mock queue. T-R3-2 [Minor] bare `rejects.toThrow()`.
- Resolution (`68517a3b9`): the parser keeps every action and the fold is the only
  de-duplication; `assertCancelledAddsValid` applies the add refusal to cancelled
  adds; the order cells answer reads by the rows asked for; the throw message is
  asserted. Red-proven: parser dedup restored, cancelled-add check dropped,
  add-before-remove split restored — each reds its cells.

Review round: 4 (`68517a3b9`)
- Security: no findings (every written user still locked; request bounds
  unchanged; no new disclosure).
- F-R4-1 [Minor] adds are checked against the pre-request state, so
  `[remove X, add X]` for a departed user keeps the row. T-R4-1 [Major] the test
  double applied its own kept-row filter instead of the service's OR.
- Resolution (`1cbcd8662`): leniency documented on `foldPatchOperations` and pinned
  by a cell (end state = last op; no access, key or removal bypass — confirmed by the
  round 5 security review); the double evaluates the OR it is sent, the exact where
  is asserted, plain-deactivated (refused) and pending (withdrawn) cells added.
  Red-proven: dropping the OR, and dropping its pending arm, each red cells.

Review round: 5 (`1cbcd8662`)
- Security: no findings. F-R5-1 [Minor] JSDoc claim applies only at the group's
  role. T-R5-1 [Minor] cell named X drives Y.

## Tightening-only skip — Round 5
Findings applied directly (no Round 6 review):
- F-R5-1 [Minor] `foldPatchOperations` JSDoc qualified to rows at this group's role —
  `src/lib/services/scim-group-service.ts` — applied verbatim.
- T-R5-1 [Minor] cell renamed `[remove Y, add Y] …` —
  `src/lib/services/scim-group-service.test.ts` — applied verbatim.
Justification: every finding scoped within the Round 4 fix range, inline minor
(comment wording, test name), no security-boundary touch.

Follow-ups to file with the PR: approval-gated SCIM role raises (S-F1, user
decision); bulk approve (F6 / D11).
