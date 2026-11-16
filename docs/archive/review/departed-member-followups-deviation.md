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
- **D4 (C3).** In `team-departure.ts` the Prisma NULL cover reads `data` (an upsert's `update`) only; a
  create's `data` or an upsert's `create` that names `deactivatedAt: null` creates an active row, not a
  return, and gets no cover. The three real writers are the `UPDATE`s in `departFromTenant`,
  `departCreatedMembership` and `returnToTenant`.
- **D5 (C3, test).** The existing "accepts the record's INSERT inside deactivateScimUser" fixture gains
  the `tenantMember.delete` its real counterpart has, so the delete exemption stays matched when that
  fixture overwrites the file.
- **D6 (C5).** The gate header had no "SC5 follow-up issue" wording to replace; rule 8's KNOWN LIMITS
  now name `#1060` as their owner directly.
