# Coding Deviation Log: departed-member-followups

- **D1 (C1, integration).** The C2 re-admitted cell re-activates through members POST, not accept:
  both fire the `admitted_at` trigger on a deactivated → active UPDATE, and members POST needs no
  invitation seed. The atomicity probe function is `c1_audit_outbox_raise_probe`, one name for every
  cell (each trigger name is unique), registered in `check-bypass-rls`'s `FUNCTION_RULE_ALLOWLIST`
  beside `#1043`'s `c5_accept_rollback_probe`.
- **D2 (C1, unit).** The unit `beforeEach` blocks reset `logAuditInTx` to resolve, so a rejecting cell
  cannot leak into later cells (`clearAllMocks` keeps the implementation).
- **D3 (C1, gate test).** The existing revert cells of `check-critical-audit-atomic.test.mjs` name
  `TEAM_ENTRY_REKEY` explicitly: `ALL`'s last entry is now a pinned action.
- **D4 (C3).** In `team-departure.ts` the Prisma NULL cover reads the payload that decides the row's
  state: `data` (update or create — a create naming `deactivatedAt: null` makes an active row, not a
  departure) and an upsert's `update`. An upsert whose `create` arm sets a timestamp while its
  `update` names nothing is a deactivating writer and needs the call (self-test cells for both upsert
  arms). The three real writers are the `UPDATE`s in `departFromTenant`, `departCreatedMembership`
  and `returnToTenant`. The `endTeamMemberships` cover counts a call in the writer's own function body
  only (`callsIn`), not one nested in a callback (code review S1).
- **D7 (C1).** The ownership transfer's `role: target.role` CAS makes a self-transfer (the OWNER naming
  their own row) answer `MEMBER_NOT_FOUND`: the demotion of the actor row runs first, so the promotion
  finds no OWNER row. Before, it answered 200 as a no-op and wrote a `TEAM_ROLE_UPDATE` row for a change
  that did not happen. No authority changes either way.
- **D5 (C3, test).** The existing "accepts the record's INSERT inside deactivateScimUser" fixture gains
  the `tenantMember.delete` its real counterpart has, so the delete exemption stays matched when that
  fixture overwrites the file.
- **D6 (C5).** The gate header had no "SC5 follow-up issue" wording to replace; rule 8's KNOWN LIMITS
  now name `#1060` as their owner directly.
