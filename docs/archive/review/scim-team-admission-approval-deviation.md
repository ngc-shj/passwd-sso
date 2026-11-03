# Coding Deviation Log: scim-team-admission-approval

- D1 (C4) `TEAM_MEMBER_SCIM_APPROVE` / `TEAM_MEMBER_SCIM_REJECT` are also in the personal
  audit log's TEAM group, as `TEAM_ROLE_UPDATE` and the `#987` actions are: the approver
  is a person and sees their own approvals. The SCIM transition actions are not (their
  actor is a SCIM token).
- D2 (C3) Approve answers the generic `CONFLICT` code (409) for a target inactive in the
  tenant and for a CAS miss; the plan fixed the status, not the code. Members POST
  answers 404 for the same tenant state; approve follows the plan's 409 (A6).
- D3 (C3) The approve/reject rate limit is 30 per hour per user, fail-closed on a Redis
  error (the plan named no number); only `memberId` is uuid-validated, as on every
  other team route `teamId` reaches `requireTeamPermission` unvalidated.
- D4 (C2) The "becomes pending" write is also a CAS (`updateManyAndReturn` on
  `deactivatedAt not null, scimApprovalPending false`) with its transitions from the
  rows written: a team-side DELETE does not take the user's advisory lock, so a pre-read
  could otherwise audit a row that was deleted. The plan named CAS only for the role and
  removal writes.
- D5 (Forbidden patterns) Rule 7's repo-wide `scimApprovalPending` check skips a
  property under a `where` filter (the plan scopes it to write payloads); self-test
  added.
- D6 (C4) The emitter takes `(tx, req, tenantId, teamId, auditUserId, actorType,
  scimTokenId, transitions)`: `logAuditBulkInTx` needs the tenant id explicitly.
- D7 (A7e) The route cell counts `logAuditBulkInTx` calls (one per action present,
  rows summing to N) with the audit module mocked; a per-row regression inside
  `logAuditBulkInTx` is pinned by its own unit cells (one scope read, one `createMany`),
  rather than a fake tx counting `auditOutbox.createMany` in the route cell.
- D8 (Forbidden patterns) Pinned counts: member writes 16 → 19 (approve CAS, reject
  delete, SCIM withdraw delete); admissions unchanged at 7 (SCIM reactivation left,
  approve CAS joined) — as the plan expected. `check-fail-closed-routes-have-test.sh`
  `EXPECTED_LIMITER_COUNT` 73 → 75 and `route-policy-manifest.json` gain the two routes.
- D9 (A7d) The race parks SCIM between its pre-read and the role CAS by holding the
  `users` row a second, brand-new add target's `createMany` FK-checks; the plan named no
  park point and SCIM has no lock boundary there.
- D10 (C7) The listing reads `audit_logs` (it runs after the outbox drains). On the dev
  DB it returned 0 rows; a seeded row inside a rolled-back transaction returned 1.
- Deferred parity gap: `scripts/checks/check-npm-audit.mjs` — needs the network
  advisory database CI queries; `scripts/checks/check-terraform-test-count.mjs` — no
  terraform change on this branch.
- D11 (Round 1 review) F6: approval stays one-by-one, bounded by the 30/hour
  rate limit (D3); a large IdP group forces its admins through that many
  individual approve calls. Bulk approve (one request approving every pending
  row a caller can act on) is a follow-up issue if that turns out to matter in
  practice, not added here. T12: A7c's advisory-lock key is a literal string
  (`tenant-member:${tenantId}:${r.id}`) matched against the real lock key SCIM
  takes — a drift between them does not silently pass, it fails loudly as
  `waitForBackendBlockedBy` timing out (the blocker never sees a waiter), so
  the hard-coded literal is left as is.
