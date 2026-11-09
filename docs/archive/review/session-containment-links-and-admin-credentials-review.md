# Plan Review: session-containment-links-and-admin-credentials
Date: 2026-11-10
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings
- F1 [Major] Account list/unlink must scope by user only (`Account.tenantId` is the link-time tenant
  and strands on realignment); flag `linkedInTenant`; cross-tenant audit parity with passkeys.
- F2 [Major] Unlink does not stop Google's email linking from re-linking; the warning was wrong.
- F3 [Major] Service-account tokens minted on others' service accounts have no creator column.
- F4 [Major] "Same as PUT isActive:false" revokes no tokens, audits post-commit; reactivation revives
  tokens; grant list inconsistent.
- F5–F10 [Minor] GET grant; `parseBody` and empty body; break-glass rule and live predicates;
  unreachable per-kind 403; zero-passkey copy; response shape and both NOT_FOUND exits.

## Security Findings
- Verified: #967 fully closes session-time linking.
- S1 [Major] = F3. S2 [Major] Emergency-access exclusion wrong: the owner's routine unlock escrows
  the vault key to an attacker-accepted grant. S3 [Major] = F1.
- S4–S9 [Minor] SA/MCP reactivation revives tokens; break-glass authz widening; metadata size cap;
  GET grant; other attributable footholds (share links, invitations, vault resets, role/policy);
  containment refused after deactivation.

## Testing Findings
- T1–T9 [Major] Per-kind 403 unreachable; break-glass semantics and cells; GET grant (real-DB cell);
  `deleteTestData` lacks `scim_tokens` / `personal_log_access_grants`; cell 4 needs same-tenant
  foreign ids and a positive control; deterministic failure for cell 5 (WHEN-scoped trigger);
  response shape vs cell 6; no-body path must not touch new models; zero-passkey 404 has two exits.
- T10–T13 [Minor] Account scope; name SA/MCP audit actions and assert via validators; value-level GET
  exposure; dialog test updates.

## Adjacent Findings
F2/F3 security-relevant; S5 overlaps F7/T2.

## Quality Warnings
None.

## Recurring Issue Check
Functionality: R3 (cross-tenant audit, LIST grant, allowlist), R29 (F2, F4, F7), R42 (F3).
Security: member-set from creator columns (S1, S2, S8), user-bound enumeration unchanged, in-tx
audit (S6 size), bypass grant per call site (S7), cross-tenant twin audit (S3).
Testing: RT1 (T1, T3, T8), RT2, RT3, RT5, RT6, RT7 (T5, T6), RT8, RT10, RT11 (T4, T6), R19 (T8).

## Resolution Status

### Round 1
The plan was rewritten. Adopted: accounts by user with `linkedInTenant` and cross-tenant audit
(F1/S3); Google re-link caveat and "may stop" warning (F2); `ServiceAccountToken.createdById` with
both mint paths, plus per-token revocation (F3/S1); SA/MCP containment also revokes their tokens,
named audit actions in the transaction (F4/S4); emergency-access grants listed and revocable (S2);
LIST grant extended, module in the bypass allowlist (F5/S7/T3); strict body, empty = no
containment, validated before step-up (F6/T8); live predicates with `expiresAt`, break-glass requires
an OWNER actor (F7/S5/T2); per-kind permission declared defence in depth with mocked paired cells
(F8/T1); zero-passkey copy (F9); response unchanged plus `contained` (F10/T7); both NOT_FOUND exits
limited to the single scope (T9); deactivated members reachable (S9); metadata ids bounded (S6);
`deleteTestData` gains the two tables (T4); acceptance cells rewritten with same-tenant foreign ids,
positive controls, a WHEN-scoped trigger for atomicity and value-level GET checks (T5, T6, T11–T13).
Out of scope with a follow-up issue: other attributable footholds and edits to others' rows (S8 →
SC1, SC2).

### Round 2
One reviewer, all perspectives. Round-1 resolutions hold except S9 (deactivated targets):
- S1 [Critical] A deactivated target let a former tenant wipe user-global state (passkeys, all
  sessions, IdP accounts, emergency grants) of a user now owned by another tenant;
  `canRevokeMemberPasskey` does not bound it. Action: S9's widening withdrawn — revoke-all stays
  active-only; deactivation happens at the IdP, so the dialog/docs say to contain first; a red cell
  pins "deactivated here, owned elsewhere → 404, nothing changed". This also removes F2 (GET/card
  deactivated gates) and the deactivated parts of F6/T2.
- S2 [Major] `EmergencyAccessGrant` carries `tenantId`. Action: matched on the owner, SYSTEM audit
  row in another tenant it was filed under, admin-actor TENANT row here.
- F1 [Major] The new `ServiceAccountToken.createdById` FK makes it user-bound for three schema gates.
  Action: `NOT_AUTH_ARTIFACTS`, `NOT_STRANDED`, `TENANT_OWNED_LEFT` entries named with reasons.
- T1 [Major] A trigger function is forbidden by `check-bypass-rls`'s function rule. Action:
  atomicity forced with a `CHECK (id <> …) NOT VALID` constraint (no function).
- Minor, applied: activated-grant disclosure not undone and no grantee email (S3); module not
  allowlisted since it makes no `withBypassRls` call (F3); JIT tokens backfilled from
  `access_requests` (F4); scenario wording, no in-app deactivation (F5); zero-passkey copy with a new
  notification key (F6); added cells (T2).

### Round 3
One reviewer, all perspectives; round-2 resolutions verified (active-only consistent, gates exist
under the named member sets, backfill columns exist, `NOT VALID` CHECK is evaluated on UPDATE and
no gate forbids `ALTER TABLE` in tests; integration files run serially). New:
- F1 [Major] The JIT `created_by_id` backfill would update zero rows on RDS (FORCE RLS, NOBYPASSRLS
  migrate role) while passing locally as superuser. Action: tx-local bypass GUCs in the `DO` block,
  restored after, plus a NOBYPASSRLS-role cell (red without the GUCs). Adjacent: the
  `20261101000000_team_tenant_departure` backfill sets no bypass GUCs — reported to the user as a
  follow-up candidate (an applied migration is fixed forward, not edited).
- F2–F6 [Minor], applied: two leftover "deactivated" lines; emergency-access revoke through
  `transition()` clearing all five escrow fields; `EMERGENCY_ACCESS_REVOKE` in a TENANT group;
  write order pinned and the atomicity table named (`emergency_access_grants`, an UPDATE); other-
  tenant SYSTEM rows merged into the existing per-tenant REVOKE_ALL row.

Saturation call (after round 3): no Critical/Major open; the round-3 Major had a direct fix; the
rest prose. Plan review closed.
